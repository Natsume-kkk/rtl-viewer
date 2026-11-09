use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

const MAX_DIAGNOSTICS: usize = 5000;
const VERILATOR_TIMEOUT: Duration = Duration::from_secs(120);
const GHDL_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxCheckRequest {
    pub request_id: u64,
    pub root: String,
    pub files: Vec<String>,
    pub top: Option<String>,
    #[serde(default)]
    pub stubs: Vec<SyntaxStub>,
    #[serde(default)]
    pub vhdl_stubs: Vec<SyntaxStub>,
    #[serde(default)]
    pub options: SyntaxCheckOptions,
    #[serde(default)]
    pub snapshots: Vec<SourceSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSnapshot {
    pub file: String,
    pub content: String,
    pub encoding: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxCheckOptions {
    #[serde(default)]
    pub defines: Vec<String>,
    #[serde(default)]
    pub include_dirs: Vec<String>,
    #[serde(default)]
    pub vhdl_libraries: Vec<VhdlLibraryMapping>,
    #[serde(default)]
    pub verilator_args: Vec<String>,
    #[serde(default)]
    pub ghdl_args: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VhdlLibraryMapping {
    pub library: String,
    pub file: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxStub {
    pub name: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxDiagnostic {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub severity: String,
    pub rule_id: String,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendSummary {
    pub name: String,
    pub version: String,
    pub files: usize,
    pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxCheckResult {
    pub request_id: u64,
    pub diagnostics: Vec<SyntaxDiagnostic>,
    pub checked_files: usize,
    pub backends: Vec<BackendSummary>,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxProgress {
    pub stage: String,
    pub file: String,
    pub completed: usize,
    pub total: usize,
}

#[derive(Default)]
pub struct SyntaxJobState {
    children: Mutex<HashMap<u64, Child>>,
    cancelled: Mutex<HashSet<u64>>,
}

impl Drop for SyntaxJobState {
    fn drop(&mut self) {
        if let Ok(children) = self.children.get_mut() {
            for child in children.values_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg(feature = "bundled-tools")]
include!(concat!(env!("OUT_DIR"), "/embedded_tools.rs"));

#[tauri::command]
pub async fn run_syntax_check(
    app: AppHandle,
    jobs: State<'_, Arc<SyntaxJobState>>,
    channel: Channel<SyntaxProgress>,
    request: SyntaxCheckRequest,
) -> Result<SyntaxCheckResult, String> {
    let data_root = app.path().app_local_data_dir().map_err(|error| error.to_string())?;
    let jobs = Arc::clone(&jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let tools = prepare_tools(&data_root)?;
        let work = work_directory(&data_root, request.request_id)?;
        let result = execute_check(request, &tools, &work, &jobs, &|progress| {
            let _ = channel.send(progress);
        });
        let _ = fs::remove_dir_all(&work);
        result
    })
    .await
    .map_err(|error| format!("syntax check task failed: {error}"))?
}

#[tauri::command]
pub fn cancel_syntax_check(jobs: State<'_, Arc<SyntaxJobState>>, request_id: u64) {
    cancel_job(&jobs, request_id);
}

fn cancel_job(jobs: &SyntaxJobState, request_id: u64) {
    jobs.cancelled.lock().unwrap().insert(request_id);
    if let Some(child) = jobs.children.lock().unwrap().get_mut(&request_id) {
        let _ = child.kill();
    }
}

fn prepare_tools(_data_root: &Path) -> Result<PathBuf, String> {
    #[cfg(not(feature = "bundled-tools"))]
    {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/windows-x64");
        if root.is_dir() {
            return Ok(root);
        }
        return Err("未找到项目内 Verilator／GHDL 工具目录".into());
    }
    #[cfg(feature = "bundled-tools")]
    {
        let root = _data_root.join("tools").join(TOOL_REVISION);
        for (relative, bytes) in TOOL_FILES {
            let relative_path = Path::new(relative);
            if relative_path.components().any(|part| !matches!(part, std::path::Component::Normal(_))) {
                return Err(format!("内置工具路径无效：{relative}"));
            }
            let target = root.join(relative_path);
            if fs::metadata(&target).map(|meta| meta.len() == bytes.len() as u64).unwrap_or(false) {
                continue;
            }
            let parent = target.parent().ok_or_else(|| "内置工具目标路径无效".to_owned())?;
            fs::create_dir_all(parent).map_err(|error| format!("创建工具目录失败：{error}"))?;
            let temporary = parent.join(format!(".rtl-viewer-tool-{}.tmp", std::process::id()));
            fs::write(&temporary, bytes).map_err(|error| format!("释放工具文件失败：{error}"))?;
            if target.exists() {
                let _ = fs::remove_file(&target);
            }
            match fs::rename(&temporary, &target) {
                Ok(()) => {}
                Err(_) if fs::metadata(&target).map(|meta| meta.len() == bytes.len() as u64).unwrap_or(false) => {
                    let _ = fs::remove_file(&temporary);
                }
                Err(error) => {
                    let _ = fs::remove_file(&temporary);
                    return Err(format!("安装工具文件失败：{error}"));
                }
            }
        }
        Ok(root.join("windows-x64"))
    }
}

fn work_directory(data_root: &Path, request_id: u64) -> Result<PathBuf, String> {
    let nonce = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let directory = data_root.join("work").join(format!("syntax-{}-{request_id}-{nonce}", std::process::id()));
    fs::create_dir_all(&directory).map_err(|error| format!("创建检查工作目录失败：{error}"))?;
    Ok(directory)
}

struct SnapshotFiles {
    overlays: HashMap<String, PathBuf>,
    originals: HashMap<String, String>,
}

fn prepare_snapshots(snapshots: &[SourceSnapshot], root: &Path, work: &Path) -> Result<SnapshotFiles, String> {
    let mut overlays = HashMap::new();
    let mut originals = HashMap::new();
    for snapshot in snapshots {
        let original = fs::canonicalize(&snapshot.file).map_err(|error| format!("读取快照源文件失败：{error}"))?;
        if !original.starts_with(root) {
            return Err(format!("快照文件不在当前工程内：{}", snapshot.file));
        }
        let relative = original.strip_prefix(root).map_err(|_| format!("无法计算快照相对路径：{}", snapshot.file))?;
        let overlay = work.join("snapshot").join(relative);
        let parent = overlay.parent().ok_or_else(|| "快照目标路径无效".to_owned())?;
        fs::create_dir_all(parent).map_err(|error| format!("创建快照目录失败：{error}"))?;
        let bytes = crate::encode(&snapshot.content, &snapshot.encoding)?;
        fs::write(&overlay, bytes).map_err(|error| format!("写入快照失败：{error}"))?;
        let original_display = crate::normalize(&original);
        overlays.insert(original_display.clone(), overlay.clone());
        originals.insert(crate::normalize(&overlay), original_display);
    }
    Ok(SnapshotFiles { overlays, originals })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceKind {
    Verilog,
    Header,
    Vhdl,
}

#[derive(Clone)]
struct SourceFile {
    path: PathBuf,
    display: String,
    kind: SourceKind,
    library: String,
}

fn execute_check(
    request: SyntaxCheckRequest,
    tools: &Path,
    work: &Path,
    jobs: &Arc<SyntaxJobState>,
    progress: &dyn Fn(SyntaxProgress),
) -> Result<SyntaxCheckResult, String> {
    let request_id = request.request_id;
    let result = execute_check_inner(request, tools, work, jobs, progress);
    jobs.cancelled.lock().unwrap().remove(&request_id);
    result
}

fn execute_check_inner(
    request: SyntaxCheckRequest,
    tools: &Path,
    work: &Path,
    jobs: &Arc<SyntaxJobState>,
    progress: &dyn Fn(SyntaxProgress),
) -> Result<SyntaxCheckResult, String> {
    let root = fs::canonicalize(&request.root).map_err(|error| format!("读取工程目录失败：{error}"))?;
    let snapshot_files = prepare_snapshots(&request.snapshots, &root, work)?;
    let mut diagnostics = Vec::new();
    let mut library_mappings = HashMap::new();
    for mapping in &request.options.vhdl_libraries {
        match fs::canonicalize(&mapping.file) {
            Ok(path) if path.is_file() && path.starts_with(&root) && valid_identifier(&mapping.library) => {
                library_mappings.insert(crate::normalize(&path), mapping.library.clone());
            }
            _ => diagnostics.push(system_diagnostic(&mapping.file, &format!("VHDL library 映射无效：{}", mapping.library))),
        }
    }
    let mut files = Vec::new();
    for file in request.files {
        let kind = match extension(&file).as_str() {
            "v" | "sv" => SourceKind::Verilog,
            "vh" | "svh" => SourceKind::Header,
            "vhd" | "vhdl" => SourceKind::Vhdl,
            _ => continue,
        };
        match fs::canonicalize(&file) {
            Ok(path) if path.is_file() && path.starts_with(&root) => {
                let display = crate::normalize(&path);
                let library = library_mappings.get(&display).cloned().unwrap_or_else(|| "work".into());
                let path = snapshot_files.overlays.get(&display).cloned().unwrap_or(path);
                files.push(SourceFile { display, path, kind, library });
            }
            _ => diagnostics.push(system_diagnostic(&file, "文件不存在、不可读或不在当前工程内")),
        }
    }
    files.sort_by(|a, b| a.display.cmp(&b.display));
    let verilogs: Vec<_> = files.iter().filter(|file| file.kind == SourceKind::Verilog).cloned().collect();
    let vhdls: Vec<_> = files.iter().filter(|file| file.kind == SourceKind::Vhdl).cloned().collect();
    let total = verilogs.len() + vhdls.len();
    let mut checked_files = 0;
    let mut backends = Vec::new();
    let verilator = tools.join("verilator/bin/verilator_bin.exe");
    let ghdl = tools.join("ghdl/bin/ghdl.exe");
    let mut include_dirs: BTreeSet<PathBuf> = files.iter()
        .filter(|file| file.kind != SourceKind::Vhdl)
        .flat_map(|file| [file.path.parent(), Path::new(&file.display).parent()])
        .filter_map(|path| path.map(Path::to_path_buf))
        .collect();
    include_dirs.extend(request.options.include_dirs.iter().map(PathBuf::from));

    if !verilogs.is_empty() {
        progress(SyntaxProgress { stage: "verilator".into(), file: String::new(), completed: 0, total });
        let (ordered, mut read_errors) = order_verilog(verilogs);
        diagnostics.append(&mut read_errors);
        let count = ordered.len();
        let version = tool_version(&verilator, tools, &root, request.request_id, jobs);
        let mut status = "completed".to_owned();
        match run_verilator(&verilator, tools, &root, work, &ordered, &include_dirs, &request.stubs, &request.options, request.top.as_deref(), request.request_id, jobs) {
            Ok(outcome) => {
                let before = diagnostics.len();
                parse_verilator_output(&outcome.stdout, &root, &mut diagnostics);
                parse_verilator_output(&outcome.stderr, &root, &mut diagnostics);
                if !outcome.success && !outcome.cancelled && !outcome.timed_out && diagnostics.len() == before {
                    diagnostics.push(system_diagnostic("", &format!("Verilator 检查失败：{}", output_summary(&outcome.stdout, &outcome.stderr))));
                }
                if outcome.cancelled || is_cancelled(jobs, request.request_id) {
                    status = "cancelled".into();
                } else if outcome.timed_out {
                    status = "timed_out".into();
                    diagnostics.push(system_diagnostic("", "Verilator 检查超过 120 秒，已停止"));
                } else {
                    checked_files += count;
                }
            }
            Err(error) => {
                status = "failed".into();
                diagnostics.push(system_diagnostic("", &format!("无法启动 Verilator：{error}")));
            }
        }
        backends.push(BackendSummary { name: "verilator".into(), version, files: count, status });
    }

    if !vhdls.is_empty() && !is_cancelled(jobs, request.request_id) {
        let count = vhdls.len();
        let version = tool_version(&ghdl, tools, &root, request.request_id, jobs);
        let mut status = "completed".to_owned();
        let ghdl_work = work.join("ghdl");
        let stub_directory = ghdl_work.join("stubs");
        fs::create_dir_all(&stub_directory).map_err(|error| format!("创建 GHDL 工作目录失败：{error}"))?;
        let mut stub_files = Vec::new();
        for stub in request.vhdl_stubs.iter().filter(|stub| valid_identifier(&stub.name)) {
            let path = stub_directory.join(format!("{}.vhd", stub.name));
            fs::write(&path, &stub.source).map_err(|error| format!("写入 VHDL 黑盒 stub 失败：{error}"))?;
            stub_files.push(SourceFile { display: crate::normalize(&path), path, kind: SourceKind::Vhdl, library: "work".into() });
        }
        let (ordered, mut read_errors) = order_vhdl(stub_files.into_iter().chain(vhdls).collect());
        diagnostics.append(&mut read_errors);
        let library_paths: BTreeSet<PathBuf> = ordered.iter().map(|file| ghdl_work.join(&file.library)).collect();
        for file in &ordered {
            if is_cancelled(jobs, request.request_id) {
                status = "cancelled".into();
                break;
            }
            let is_stub = file.path.starts_with(&stub_directory);
            if !is_stub {
                progress(SyntaxProgress { stage: "ghdl".into(), file: file.display.clone(), completed: checked_files, total });
            }
            let library_work = ghdl_work.join(&file.library);
            fs::create_dir_all(&library_work).map_err(|error| format!("创建 GHDL library 工作目录失败：{error}"))?;
            let mut args = vec![
                "-a".to_owned(),
                "--std=08".to_owned(),
                "-fsynopsys".to_owned(),
                format!("--work={}", file.library),
                format!("--workdir={}", crate::normalize(&library_work)),
            ];
            for directory in &library_paths {
                args.push(format!("-P{}", crate::normalize(directory)));
            }
            args.extend(request.options.ghdl_args.iter().filter(|argument| !argument.contains(['\r', '\n'])).cloned());
            args.push(crate::normalize(&file.path));
            match run_external(&ghdl, tools, &args, &root, request.request_id, GHDL_TIMEOUT, jobs) {
                Ok(outcome) => {
                    let before = diagnostics.len();
                    parse_ghdl_output(&outcome.stdout, &root, &mut diagnostics);
                    parse_ghdl_output(&outcome.stderr, &root, &mut diagnostics);
                    if !outcome.success && !outcome.cancelled && !outcome.timed_out && diagnostics.len() == before {
                        diagnostics.push(system_diagnostic(&file.display, &format!("GHDL 分析失败：{}", output_summary(&outcome.stdout, &outcome.stderr))));
                    }
                    if outcome.cancelled || is_cancelled(jobs, request.request_id) {
                        status = "cancelled".into();
                        break;
                    }
                    if outcome.timed_out {
                        status = "timed_out".into();
                        diagnostics.push(system_diagnostic(&file.display, "GHDL 单文件分析超过 60 秒，已停止"));
                        break;
                    }
                    if !is_stub { checked_files += 1; }
                }
                Err(error) => {
                    status = "failed".into();
                    diagnostics.push(system_diagnostic(&file.display, &format!("无法启动 GHDL：{error}")));
                    break;
                }
            }
        }
        backends.push(BackendSummary { name: "ghdl".into(), version, files: count, status });
    }

    let cancelled = backends.iter().any(|backend| backend.status == "cancelled");
    for diagnostic in &mut diagnostics {
        if let Some(original) = snapshot_files.originals.get(&diagnostic.file) {
            diagnostic.file = original.clone();
        }
    }
    finalize_diagnostics(&mut diagnostics);
    Ok(SyntaxCheckResult { request_id: request.request_id, diagnostics, checked_files, backends, cancelled })
}

fn finalize_diagnostics(diagnostics: &mut Vec<SyntaxDiagnostic>) {
    diagnostics.sort_by(|a, b| {
        let rank = |diagnostic: &SyntaxDiagnostic| match diagnostic.severity.as_str() { "error" => 0, "warning" => 1, _ => 2 };
        (rank(a), &a.file, a.line, a.column, &a.rule_id, &a.message).cmp(&(rank(b), &b.file, b.line, b.column, &b.rule_id, &b.message))
    });
    diagnostics.dedup();
    if diagnostics.len() > MAX_DIAGNOSTICS {
        diagnostics.truncate(MAX_DIAGNOSTICS - 1);
        diagnostics.push(system_diagnostic("", &format!("诊断数量超过 {MAX_DIAGNOSTICS}，其余结果已省略")));
    }
}

fn run_verilator(
    program: &Path,
    tools: &Path,
    root: &Path,
    work: &Path,
    files: &[SourceFile],
    include_dirs: &BTreeSet<PathBuf>,
    stubs: &[SyntaxStub],
    options: &SyntaxCheckOptions,
    top: Option<&str>,
    request_id: u64,
    jobs: &Arc<SyntaxJobState>,
) -> Result<ProcessOutcome, String> {
    let response_dir = work.join("verilator");
    fs::create_dir_all(&response_dir).map_err(|error| format!("创建 Verilator 工作目录失败：{error}"))?;
    let response = response_dir.join("sources.f");
    let mut content = String::from("--lint-only\n-Wall\n--timing\n--Wno-fatal\n--error-limit 200\n--default-language 1800-2017\n");
    content.push_str(&format!("--Mdir \"{}\"\n", crate::normalize(&response_dir.join("obj_dir"))));
    let mut include_dirs = include_dirs.clone();
    for file in files {
        if let Some(parent) = file.path.parent() {
            include_dirs.insert(parent.to_path_buf());
        }
    }
    for directory in include_dirs {
        content.push_str(&format!("-I\"{}\"\n", crate::normalize(&directory)));
    }
    for define in &options.defines {
        let name = define.split('=').next().unwrap_or("");
        if valid_identifier(name) && !define.chars().any(char::is_whitespace) {
            content.push_str(&format!("+define+{define}\n"));
        }
    }
    for argument in &options.verilator_args {
        if !argument.contains(['\r', '\n']) {
            content.push_str(argument);
            content.push('\n');
        }
    }
    if let Some(top) = top.filter(|name| valid_identifier(name)) {
        content.push_str(&format!("--top-module \"{top}\"\n"));
    }
    for stub in stubs.iter().filter(|stub| valid_identifier(&stub.name)) {
        let path = response_dir.join("stubs").join(format!("{}.sv", stub.name));
        fs::create_dir_all(path.parent().unwrap()).map_err(|error| format!("创建 IP stub 目录失败：{error}"))?;
        fs::write(&path, &stub.source).map_err(|error| format!("写入 IP 黑盒 stub 失败：{error}"))?;
        content.push_str(&format!("\"{}\"\n", crate::normalize(&path)));
    }
    for file in files {
        content.push_str(&format!("\"{}\"\n", crate::normalize(&file.path)));
    }
    fs::write(&response, content).map_err(|error| format!("写入 Verilator 文件列表失败：{error}"))?;
    let args = vec!["-f".to_owned(), crate::normalize(&response)];
    run_external(program, tools, &args, root, request_id, VERILATOR_TIMEOUT, jobs)
}

struct ProcessOutcome {
    stdout: String,
    stderr: String,
    success: bool,
    timed_out: bool,
    cancelled: bool,
}

fn run_external(
    program: &Path,
    tools: &Path,
    args: &[String],
    cwd: &Path,
    request_id: u64,
    timeout: Duration,
    jobs: &Arc<SyntaxJobState>,
) -> Result<ProcessOutcome, String> {
    if is_cancelled(jobs, request_id) {
        return Ok(ProcessOutcome { stdout: String::new(), stderr: String::new(), success: false, timed_out: false, cancelled: true });
    }
    let mut command = Command::new(program);
    command.args(args).current_dir(cwd).stdout(Stdio::piped()).stderr(Stdio::piped());
    configure_tools(&mut command, tools);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "无法读取进程标准输出".to_owned())?;
    let stderr = child.stderr.take().ok_or_else(|| "无法读取进程错误输出".to_owned())?;
    let stdout_reader = thread::spawn(move || read_stream(stdout));
    let stderr_reader = thread::spawn(move || read_stream(stderr));
    jobs.children.lock().unwrap().insert(request_id, child);
    let started = Instant::now();
    let mut timed_out = false;
    let mut cancelled = false;
    loop {
        if is_cancelled(jobs, request_id) {
            cancelled = true;
            if let Some(child) = jobs.children.lock().unwrap().get_mut(&request_id) {
                let _ = child.kill();
            }
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            if let Some(child) = jobs.children.lock().unwrap().get_mut(&request_id) {
                let _ = child.kill();
            }
        }
        let finished = {
            let mut children = jobs.children.lock().unwrap();
            match children.get_mut(&request_id) {
                Some(child) => child.try_wait().map_err(|error| error.to_string())?.is_some(),
                None => true,
            }
        };
        if finished {
            break;
        }
        thread::sleep(Duration::from_millis(40));
    }
    let success = jobs.children.lock().unwrap().remove(&request_id)
        .and_then(|mut child| child.wait().ok())
        .map(|status| status.success())
        .unwrap_or(false);
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    Ok(ProcessOutcome { stdout, stderr, success, timed_out, cancelled })
}

fn read_stream(mut stream: impl Read) -> String {
    let mut bytes = Vec::new();
    let _ = stream.read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

fn configure_tools(command: &mut Command, tools: &Path) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let verilator_bin = tools.join("verilator/bin");
    let ghdl_bin = tools.join("ghdl/bin");
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![verilator_bin, ghdl_bin];
    paths.extend(std::env::split_paths(&path));
    if let Ok(path) = std::env::join_paths(paths) {
        command.env("PATH", path);
    }
    command.env("VERILATOR_ROOT", tools.join("verilator/share/verilator"));
    command.env("GHDL_PREFIX", tools.join("ghdl/lib/ghdl"));
    command.env("NO_COLOR", "1");
    command.env("TERM", "dumb");
}

fn tool_version(program: &Path, tools: &Path, root: &Path, request_id: u64, jobs: &Arc<SyntaxJobState>) -> String {
    run_external(program, tools, &["--version".into()], root, request_id, Duration::from_secs(10), jobs).ok()
        .map(|outcome| {
            let output = if outcome.stdout.trim().is_empty() { outcome.stderr } else { outcome.stdout };
            output.lines().next().unwrap_or("未知版本").trim().to_owned()
        })
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| "未知版本".into())
}

fn is_cancelled(jobs: &SyntaxJobState, request_id: u64) -> bool {
    jobs.cancelled.lock().unwrap().contains(&request_id)
}

fn system_diagnostic(file: &str, message: &str) -> SyntaxDiagnostic {
    SyntaxDiagnostic { file: file.to_owned(), line: 1, column: 1, severity: "error".into(), rule_id: "SYNTAX".into(), source: "system".into(), message: message.to_owned() }
}

fn parse_verilator_output(output: &str, root: &Path, diagnostics: &mut Vec<SyntaxDiagnostic>) {
    for raw in output.lines() {
        let line = raw.trim();
        let severity = if line.starts_with("%Error") { "error" } else if line.starts_with("%Warning") { "warning" } else if line.starts_with("%Note") { "info" } else { continue };
        let Some(header_end) = line.find(':') else { continue };
        let header = &line[1..header_end];
        let rule = header.split_once('-').map(|(_, tag)| tag).unwrap_or("GENERAL");
        let severity = if rule == "PINCONNECTEMPTY" { "info" } else { severity };
        let body = line[header_end + 1..].trim();
        if body.starts_with("Exiting due to ") && body.ends_with(" error(s)") { continue; }
        let (file, line_number, column, message) = split_location(body)
            .map(|(file, line, column, message)| (reported_path(root, &file), line, column, message))
            .unwrap_or_else(|| (String::new(), 1, 1, body.to_owned()));
        push_diagnostic(diagnostics, SyntaxDiagnostic { file, line: line_number, column, severity: severity.into(), rule_id: format!("VERILATOR-{rule}"), source: "verilator".into(), message });
    }
}

fn parse_ghdl_output(output: &str, root: &Path, diagnostics: &mut Vec<SyntaxDiagnostic>) {
    for raw in output.lines() {
        let text = raw.trim();
        let Some((file, line, column, message)) = split_location(text) else { continue };
        let lower = message.to_lowercase();
        let severity = if lower.starts_with("error") || lower.starts_with("fatal") { "error" }
            else if lower.starts_with("warning") { "warning" }
            else { "info" };
        push_diagnostic(diagnostics, SyntaxDiagnostic {
            file: reported_path(root, &file), line, column, severity: severity.into(), rule_id: "GHDL".into(), source: "ghdl".into(), message,
        });
    }
}

fn split_location(text: &str) -> Option<(String, u32, u32, String)> {
    let bytes = text.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b':' { continue; }
        let line_start = index + 1;
        let line_end = text[line_start..].find(':')? + line_start;
        if !text[line_start..line_end].chars().all(|c| c.is_ascii_digit()) { continue; }
        let column_start = line_end + 1;
        let column_end = text[column_start..].find(':')? + column_start;
        if !text[column_start..column_end].chars().all(|c| c.is_ascii_digit()) { continue; }
        let line: u32 = text[line_start..line_end].parse().ok()?;
        let column: u32 = text[column_start..column_end].parse().ok()?;
        return Some((text[..index].trim().to_owned(), line.max(1), column.max(1), text[column_end + 1..].trim().to_owned()));
    }
    None
}

fn reported_path(root: &Path, file: &str) -> String {
    let file = file.trim_matches('"');
    if file.is_empty() || file.starts_with('<') { return String::new(); }
    let path = PathBuf::from(file);
    let absolute = if path.is_absolute() { path } else { root.join(path) };
    crate::normalize(&absolute)
}

fn push_diagnostic(diagnostics: &mut Vec<SyntaxDiagnostic>, diagnostic: SyntaxDiagnostic) {
    diagnostics.push(diagnostic);
}

fn output_summary(stdout: &str, stderr: &str) -> String {
    let text = format!("{stdout}\n{stderr}");
    let trimmed = text.trim();
    if trimmed.is_empty() { "进程异常结束".into() } else { trimmed.chars().take(4000).collect() }
}

fn extension(path: &str) -> String {
    Path::new(path).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_lowercase()
}

fn valid_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().map(|c| c.is_ascii_alphabetic() || c == '_').unwrap_or(false)
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

fn source_text(file: &SourceFile) -> Result<String, SyntaxDiagnostic> {
    let bytes = fs::read(&file.path).map_err(|error| system_diagnostic(&file.display, &format!("读取源码失败：{error}")))?;
    crate::decode(&bytes).map(|(text, _)| text).map_err(|error| system_diagnostic(&file.display, &format!("解码源码失败：{error}")))
}

fn order_verilog(files: Vec<SourceFile>) -> (Vec<SourceFile>, Vec<SyntaxDiagnostic>) {
    let mut texts = Vec::with_capacity(files.len());
    let mut errors = Vec::new();
    let mut definitions = HashMap::new();
    for (index, file) in files.iter().enumerate() {
        match source_text(file) {
            Ok(text) => {
                let cleaned = strip_comments(&text, SourceKind::Verilog);
                for package in verilog_packages(&cleaned) {
                    definitions.entry(package).or_insert(index);
                }
                texts.push(cleaned);
            }
            Err(error) => { errors.push(error); texts.push(String::new()); }
        }
    }
    let mut dependencies = vec![BTreeSet::new(); files.len()];
    for (index, text) in texts.iter().enumerate() {
        for (package, provider) in &definitions {
            if *provider != index && text.contains(&format!("{package}::")) {
                dependencies[index].insert(*provider);
            }
        }
    }
    (stable_order(files, dependencies), errors)
}

fn order_vhdl(files: Vec<SourceFile>) -> (Vec<SourceFile>, Vec<SyntaxDiagnostic>) {
    let mut texts = Vec::with_capacity(files.len());
    let mut errors = Vec::new();
    let mut specifications = HashMap::new();
    let mut bodies = HashMap::new();
    let mut entities = HashMap::new();
    for (index, file) in files.iter().enumerate() {
        match source_text(file) {
            Ok(text) => {
                let cleaned = strip_comments(&text, SourceKind::Vhdl).to_lowercase();
                let (packages, package_bodies) = vhdl_packages(&cleaned);
                for package in packages { specifications.entry((file.library.clone(), package)).or_insert(index); }
                for package in package_bodies { bodies.entry((file.library.clone(), package)).or_insert(index); }
                for entity in vhdl_entities(&cleaned) { entities.entry((file.library.clone(), entity)).or_insert(index); }
                texts.push(cleaned);
            }
            Err(error) => { errors.push(error); texts.push(String::new()); }
        }
    }
    let mut dependencies = vec![BTreeSet::new(); files.len()];
    for ((library, package), body_index) in &bodies {
        if let Some(specification) = specifications.get(&(library.clone(), package.clone())) {
            dependencies[*body_index].insert(*specification);
        }
    }
    for (index, text) in texts.iter().enumerate() {
        let words = words(text);
        for pair in words.windows(2) {
            if let Some(provider) = specifications.get(&(pair[0].clone(), pair[1].clone())) {
                if *provider != index { dependencies[index].insert(*provider); }
            }
            if pair[0] == "component" {
                if let Some(provider) = entities.get(&(files[index].library.clone(), pair[1].clone())) {
                    if *provider != index { dependencies[index].insert(*provider); }
                }
            }
        }
        for window in words.windows(3) {
            if window[0] != "entity" { continue; }
            if let Some(provider) = entities.get(&(window[1].clone(), window[2].clone())) {
                if *provider != index { dependencies[index].insert(*provider); }
            }
        }
        for token in 0..words.len().saturating_sub(3) {
            if words[token] != "architecture" || words[token + 2] != "of" { continue; }
            if let Some(provider) = entities.get(&(files[index].library.clone(), words[token + 3].clone())) {
                if *provider != index { dependencies[index].insert(*provider); }
            }
        }
    }
    (stable_order(files, dependencies), errors)
}

fn stable_order(files: Vec<SourceFile>, dependencies: Vec<BTreeSet<usize>>) -> Vec<SourceFile> {
    let mut emitted = BTreeSet::new();
    let mut order = Vec::with_capacity(files.len());
    while order.len() < files.len() {
        let mut progressed = false;
        for index in 0..files.len() {
            if emitted.contains(&index) || !dependencies[index].iter().all(|dependency| emitted.contains(dependency)) {
                continue;
            }
            emitted.insert(index);
            order.push(files[index].clone());
            progressed = true;
        }
        if !progressed {
            for index in 0..files.len() {
                if emitted.insert(index) { order.push(files[index].clone()); }
            }
        }
    }
    order
}

fn verilog_packages(text: &str) -> Vec<String> {
    let tokens = words(text);
    tokens.windows(2).filter(|pair| pair[0] == "package").map(|pair| pair[1].clone()).collect()
}

fn vhdl_packages(text: &str) -> (Vec<String>, Vec<String>) {
    let tokens = words(text);
    let mut specifications = Vec::new();
    let mut bodies = Vec::new();
    for window in tokens.windows(3) {
        if window[0] != "package" { continue; }
        if window[1] == "body" { bodies.push(window[2].clone()); }
        else if window[1] != "is" { specifications.push(window[1].clone()); }
    }
    (specifications, bodies)
}

fn vhdl_entities(text: &str) -> Vec<String> {
    let tokens = words(text);
    tokens.windows(3).filter(|window| window[0] == "entity" && window[2] == "is").map(|window| window[1].clone()).collect()
}

fn words(text: &str) -> Vec<String> {
    let normalized: String = text.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '$' { c } else { ' ' }).collect();
    normalized.split_whitespace().map(str::to_owned).collect()
}

fn strip_comments(text: &str, kind: SourceKind) -> String {
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    let mut block = false;
    let mut string = false;
    while index < bytes.len() {
        if block {
            if kind == SourceKind::Verilog && index + 1 < bytes.len() && &bytes[index..index + 2] == b"*/" {
                block = false;
                output.push_str("  ");
                index += 2;
            } else {
                output.push(if bytes[index] == b'\n' { '\n' } else { ' ' });
                index += 1;
            }
            continue;
        }
        if string {
            let byte = bytes[index];
            output.push(byte as char);
            index += 1;
            if byte == b'\\' && index < bytes.len() {
                output.push(bytes[index] as char);
                index += 1;
            } else if byte == b'"' {
                string = false;
            }
            continue;
        }
        if kind == SourceKind::Verilog && index + 1 < bytes.len() && &bytes[index..index + 2] == b"//" {
            while index < bytes.len() && bytes[index] != b'\n' { output.push(' '); index += 1; }
            continue;
        }
        if kind == SourceKind::Vhdl && index + 1 < bytes.len() && &bytes[index..index + 2] == b"--" {
            while index < bytes.len() && bytes[index] != b'\n' { output.push(' '); index += 1; }
            continue;
        }
        if kind == SourceKind::Verilog && index + 1 < bytes.len() && &bytes[index..index + 2] == b"/*" {
            block = true;
            output.push_str("  ");
            index += 2;
            continue;
        }
        if bytes[index] == b'"' { string = true; }
        output.push(bytes[index] as char);
        index += 1;
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str, content: &str) -> SourceFile {
        let directory = std::env::temp_dir().join(format!("rtl-viewer-syntax-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(name);
        fs::write(&path, content).unwrap();
        SourceFile { display: crate::normalize(&path), path, kind: SourceKind::Vhdl, library: "work".into() }
    }

    #[test]
    fn vhdl_package_bodies_and_consumers_follow_specifications() {
        let body = fixture("types-body.vhd", "package body types is end package body;");
        let consumer = fixture("consumer.vhd", "use work.types.all; entity consumer is end;");
        let specification = fixture("types.vhd", "package types is end package;");
        let files = vec![body, consumer, specification];
        let (ordered, errors) = order_vhdl(files);
        assert!(errors.is_empty());
        let names: Vec<_> = ordered.iter().map(|file| file.path.file_name().unwrap().to_string_lossy()).collect();
        assert_eq!(names, ["types.vhd", "types-body.vhd", "consumer.vhd"]);
    }

    #[test]
    fn vhdl_entity_and_component_consumers_follow_definitions() {
        let direct = fixture("direct-entity.vhd", "entity direct is end; architecture rtl of direct is begin u: entity work. provider; end;");
        let component = fixture("component-consumer.vhd", "entity component_consumer is end; architecture rtl of component_consumer is component provider is port(a: in bit); end component; begin u: provider port map(a => '0'); end;");
        let provider = fixture("entity-provider.vhd", "entity provider is port(a: in bit); end;");
        let (ordered, errors) = order_vhdl(vec![direct, component, provider]);
        assert!(errors.is_empty());
        let names: Vec<_> = ordered.iter().map(|file| file.path.file_name().unwrap().to_string_lossy()).collect();
        assert_eq!(names, ["entity-provider.vhd", "direct-entity.vhd", "component-consumer.vhd"]);
    }

    #[test]
    fn vhdl_architecture_follows_entity_in_another_file() {
        let architecture = fixture("a_rtl.vhd", "architecture rtl of split_entity is begin end architecture;");
        let entity = fixture("z_entity.vhd", "entity split_entity is end entity;");
        let (ordered, errors) = order_vhdl(vec![architecture, entity]);
        assert!(errors.is_empty());
        let names: Vec<_> = ordered.iter().map(|file| file.path.file_name().unwrap().to_string_lossy()).collect();
        assert_eq!(names, ["z_entity.vhd", "a_rtl.vhd"]);
    }

    #[test]
    fn diagnostics_parse_windows_paths_and_message_colons() {
        let root = PathBuf::from("D:/project");
        let mut diagnostics = Vec::new();
        parse_verilator_output("%Error-WIDTH: D:/project/top.sv:8:12: Operator expects: value\n", &root, &mut diagnostics);
        assert_eq!(diagnostics[0].file, "D:/project/top.sv");
        assert_eq!(diagnostics[0].line, 8);
        assert_eq!(diagnostics[0].column, 12);
        assert_eq!(diagnostics[0].message, "Operator expects: value");
        parse_ghdl_output("D:/project/top.vhd:4:2: error: missing \";\": details\n", &root, &mut diagnostics);
        assert_eq!(diagnostics[1].severity, "error");
        assert_eq!(diagnostics[1].message, "error: missing \";\": details");
        parse_verilator_output("%Note-DECLFILENAME: D:/project/top.sv:2:8: Related declaration\n", &root, &mut diagnostics);
        let note = diagnostics.last().unwrap();
        assert_eq!(note.severity, "info");
        assert_eq!(note.rule_id, "VERILATOR-DECLFILENAME");
        assert_eq!(note.line, 2);
        parse_verilator_output("%Warning-PINCONNECTEMPTY: D:/project/top.sv:3:8: Cell pin connected by name with empty reference: 'full'\n", &root, &mut diagnostics);
        assert_eq!(diagnostics.last().unwrap().severity, "info");
        parse_verilator_output("%Warning-PINMISSING: D:/project/top.sv:4:8: Cell has missing pin: 'empty'\n", &root, &mut diagnostics);
        assert_eq!(diagnostics.last().unwrap().severity, "warning");
        let before = diagnostics.len();
        parse_verilator_output("%Error: Exiting due to 4 error(s)\n", &root, &mut diagnostics);
        assert_eq!(diagnostics.len(), before);
    }

    #[test]
    fn truncation_preserves_errors_before_information() {
        let mut diagnostics = Vec::new();
        for index in 0..(MAX_DIAGNOSTICS * 4 + 1) {
            push_diagnostic(&mut diagnostics, SyntaxDiagnostic {
                file: format!("D:/project/{index}.sv"), line: 1, column: 1, severity: "info".into(), rule_id: "INFO".into(), source: "verilator".into(), message: "information".into(),
            });
        }
        push_diagnostic(&mut diagnostics, system_diagnostic("D:/project/error.sv", "critical"));
        finalize_diagnostics(&mut diagnostics);
        assert_eq!(diagnostics.len(), MAX_DIAGNOSTICS);
        assert_eq!(diagnostics[0].severity, "error");
        assert_eq!(diagnostics[0].file, "D:/project/error.sv");
        assert!(diagnostics.last().unwrap().message.contains("其余结果已省略"));
    }

    #[test]
    fn cancellation_before_execution_is_preserved_and_cleaned_up() {
        let root = std::env::temp_dir().join(format!("rtl-viewer-cancel-before-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let source = root.join("top.sv");
        fs::write(&source, "module top; endmodule\n").unwrap();
        let work = root.join("work");
        fs::create_dir_all(&work).unwrap();
        let jobs = Arc::new(SyntaxJobState::default());
        cancel_job(&jobs, 96);
        let result = execute_check(
            SyntaxCheckRequest { request_id: 96, root: crate::normalize(&root), files: vec![crate::normalize(&source)], ..Default::default() },
            &root.join("missing-tools"), &work, &jobs, &|_| {},
        ).unwrap();
        assert!(result.cancelled);
        assert!(result.backends.iter().all(|backend| backend.status == "cancelled"));
        assert!(result.diagnostics.iter().all(|diagnostic| diagnostic.severity != "error"));
        assert!(!jobs.cancelled.lock().unwrap().contains(&96));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn comments_do_not_create_package_dependencies() {
        let first = SourceFile { kind: SourceKind::Verilog, ..fixture("a.sv", "// package hidden; endpackage\npackage real_pkg; endpackage") };
        let second = SourceFile { kind: SourceKind::Verilog, ..fixture("b.sv", "module b; import real_pkg::*; endmodule") };
        let (ordered, errors) = order_verilog(vec![second, first]);
        assert!(errors.is_empty());
        assert!(ordered[0].display.ends_with("a.sv"));
    }

    #[test]
    #[ignore = "requires the local Verilator and GHDL runtime"]
    fn real_backends_check_verilog_and_vhdl() {
        let root = std::env::temp_dir().join(format!("rtl-viewer-real-syntax-{}", std::process::id()));
        let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/windows-x64");
        assert_real_backends(tools, root, 91);
    }

    #[test]
    #[ignore = "requires the local Verilator runtime and an unsaved source snapshot"]
    fn real_backend_uses_unsaved_snapshot_instead_of_disk() {
        let root = std::env::temp_dir().join(format!("rtl-viewer-snapshot-syntax-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let source = root.join("top.sv");
        fs::write(&source, "module top; invalid verilog\n").unwrap();
        fs::write(root.join("types.svh"), "typedef logic [1:0] pair_t;\n").unwrap();
        let snapshot = SourceSnapshot { file: crate::normalize(&source), content: "module top(input logic a, output logic b); `include \"types.svh\"\npair_t value; assign value = {a, a}; assign b = value[0]; endmodule\n".into(), encoding: "utf8".into() };
        let result = execute_check(SyntaxCheckRequest { request_id: 95, root: crate::normalize(&root), files: vec![crate::normalize(&source)], snapshots: vec![snapshot], ..Default::default() }, &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/windows-x64"), &root.join("work"), &Arc::new(SyntaxJobState::default()), &|_| {}).unwrap();
        assert_eq!(result.checked_files, 1, "{result:?}");
        assert!(!result.diagnostics.iter().any(|diagnostic| diagnostic.severity == "error"), "{result:?}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "requires the local GHDL runtime and a custom VHDL library"]
    fn real_ghdl_checks_custom_library_dependencies() {
        let root = std::env::temp_dir().join(format!("rtl-viewer-vhdl-library-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let vendor = root.join("vendor.vhd");
        let consumer = root.join("consumer.vhd");
        fs::write(&vendor, "package types is constant WIDTH: integer := 8; end package;\n").unwrap();
        fs::write(&consumer, "library vendor; use vendor.types.all; entity consumer is end;\n").unwrap();
        let options = SyntaxCheckOptions { vhdl_libraries: vec![VhdlLibraryMapping { library: "vendor".into(), file: crate::normalize(&vendor) }], ..Default::default() };
        let result = execute_check(SyntaxCheckRequest { request_id: 94, root: crate::normalize(&root), files: vec![crate::normalize(&consumer), crate::normalize(&vendor)], options, ..Default::default() }, &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/windows-x64"), &root.join("work"), &Arc::new(SyntaxJobState::default()), &|_| {}).unwrap();
        assert_eq!(result.checked_files, 2, "{result:?}");
        assert!(!result.diagnostics.iter().any(|diagnostic| diagnostic.severity == "error"), "{result:?}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "checks the repository mixed-language sample with the local tools"]
    fn repository_sample_uses_ip_stub_without_aborting_vhdl() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/samples/basic");
        let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/windows-x64");
        let work = std::env::temp_dir().join(format!("rtl-viewer-sample-syntax-{}", std::process::id()));
        let _ = fs::remove_dir_all(&work);
        fs::create_dir_all(&work).unwrap();
        let files = vec![crate::normalize(&root.join("top.v")), crate::normalize(&root.join("register.vhd"))];
        let stubs = vec![
            SyntaxStub { name: "sample_clock".into(), source: fs::read_to_string(root.join("ip/sample_clock.v")).unwrap() },
            SyntaxStub { name: "sample_register".into(), source: "module sample_register (input wire clk, input wire reset_n, input wire data_in, output wire data_out); endmodule\n".into() },
        ];
        let result = execute_check(SyntaxCheckRequest { request_id: 93, root: crate::normalize(&root), files, top: Some("sample_top".into()), stubs, ..Default::default() }, &tools, &work, &Arc::new(SyntaxJobState::default()), &|_| {}).unwrap();
        assert_eq!(result.checked_files, 2, "{result:?}");
        assert!(result.backends.iter().all(|backend| backend.status == "completed"), "{result:?}");
        assert!(!result.diagnostics.iter().any(|diagnostic| diagnostic.source == "verilator" && diagnostic.severity == "error"), "{result:?}");
        let _ = fs::remove_dir_all(work);
    }

    #[cfg(feature = "bundled-tools")]
    #[test]
    #[ignore = "extracts and runs the embedded Verilator and GHDL runtime"]
    fn embedded_backends_check_verilog_and_vhdl() {
        let root = std::env::temp_dir().join(format!("rtl-viewer-embedded-syntax-{}", std::process::id()));
        let tools = prepare_tools(&root).unwrap();
        assert_real_backends(tools, root.join("project"), 92);
        let _ = fs::remove_dir_all(root);
    }

    fn assert_real_backends(tools: PathBuf, root: PathBuf, request_id: u64) {
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let verilog = root.join("top.sv");
        let vhdl = root.join("top.vhd");
        let include = root.join("include/types.svh");
        fs::create_dir_all(include.parent().unwrap()).unwrap();
        fs::write(&include, "typedef logic [1:0] my_type;\n").unwrap();
        fs::write(&verilog, "`include \"types.svh\"\n`ifdef RTL_CHECK\nmodule top(input logic a, output logic b); my_type value; assign value = {a, a}; assign b = value[0]; endmodule\n`else\nmodule top; invalid verilog\n`endif\n").unwrap();
        fs::write(&vhdl, "library ieee; use ieee.std_logic_1164.all; entity top is port(a:in std_logic;b:out std_logic); end; architecture rtl of top is begin b<=a; end;\n").unwrap();
        let work = root.join("work");
        fs::create_dir_all(&work).unwrap();
        let jobs = Arc::new(SyntaxJobState::default());
        let options = SyntaxCheckOptions {
            defines: vec!["RTL_CHECK=1".into()],
            include_dirs: vec![crate::normalize(include.parent().unwrap())],
            verilator_args: vec!["--Wno-DECLFILENAME".into()],
            ghdl_args: vec!["-frelaxed-rules".into()],
            ..Default::default()
        };
        let result = execute_check(SyntaxCheckRequest { request_id, root: crate::normalize(&root), files: vec![crate::normalize(&verilog), crate::normalize(&vhdl), crate::normalize(&include)], top: Some("top".into()), options, ..Default::default() }, &tools, &work, &jobs, &|_| {}).unwrap();
        assert_eq!(result.checked_files, 2, "{result:?}");
        assert_eq!(result.backends.len(), 2);
        assert!(result.backends.iter().all(|backend| backend.status == "completed"), "{result:?}");
        let _ = fs::remove_dir_all(root);
    }
}
