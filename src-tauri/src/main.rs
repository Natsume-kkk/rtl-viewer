#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist"];
/** EDA 工具生成目录（按后缀匹配）：内容是工具产物，不是用户源码。 */
const GENERATED_DIR_SUFFIXES: &[&str] = &[".runs", ".sim", ".cache", ".hw", ".gen", ".ip_user_files"];
const HDL_EXTS: &[&str] = &["v", "sv", "vh", "svh", "vhd", "vhdl"];
/** 约束文件（只读查看，不参与解析与索引） */
const CONSTRAINT_EXTS: &[&str] = &["xdc", "sdc"];

#[derive(Serialize)]
struct ScanResult {
    hdl: Vec<String>,
    xci: Vec<String>,
    con: Vec<String>,
}

/** 目录递归深度上限：junction/硬链接环等异常结构的兜底，避免栈溢出崩进程。 */
const MAX_WALK_DEPTH: usize = 64;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

fn walk(dir: &Path, out: &mut ScanResult) {
    walk_depth(dir, out, 0);
}

fn walk_depth(dir: &Path, out: &mut ScanResult, depth: usize) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        // 不跟随符号链接/junction：环状链接会导致无限递归，一律跳过
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if meta.is_dir() {
            if name.starts_with('.')
                || SKIP_DIRS.contains(&name)
                || GENERATED_DIR_SUFFIXES.iter().any(|s| name.ends_with(s))
            {
                continue;
            }
            walk_depth(&path, out, depth + 1);
        } else {
            let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
            if HDL_EXTS.contains(&ext.as_str()) {
                out.hdl.push(normalize(&path));
            } else if ext == "xci" {
                out.xci.push(normalize(&path));
            } else if CONSTRAINT_EXTS.contains(&ext.as_str()) {
                out.con.push(normalize(&path));
            }
        }
    }
}

fn normalize(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!("//{}", unc.replace('\\', "/"))
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).replace('\\', "/")
    }
}

#[tauri::command]
async fn scan_folder(path: String) -> Result<ScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || scan_folder_sync(path))
        .await
        .map_err(|e| format!("scan_folder task failed: {e}"))?
}

fn scan_folder_sync(path: String) -> Result<ScanResult, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    fs::read_dir(&root).map_err(|e| format!("scan {path} failed: {e}"))?;
    let mut out = ScanResult { hdl: vec![], xci: vec![], con: vec![] };
    walk(&root, &mut out);
    out.hdl.sort();
    out.xci.sort();
    out.con.sort();
    Ok(out)
}

#[derive(Serialize)]
struct FileContent {
    content: String,
    encoding: String,
    /// 磁盘修改时间（毫秒时间戳），读取失败为 0
    mtime: u64,
}

fn mtime_ms(path: &str) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
async fn file_states(paths: Vec<String>) -> Result<Vec<Option<u64>>, String> {
    tauri::async_runtime::spawn_blocking(move || file_states_sync(paths))
        .await
        .map_err(|e| format!("file_states task failed: {e}"))?
}

fn file_states_sync(paths: Vec<String>) -> Result<Vec<Option<u64>>, String> {
    paths
        .iter()
        .map(|p| {
            match fs::metadata(p) {
                Ok(meta) if meta.is_file() => meta.modified()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).map_err(std::io::Error::other))
                    .map(|d| Some(d.as_millis() as u64))
                    .map_err(|e| format!("stat {p} failed: {e}")),
                Ok(_) => Err(format!("not a file: {p}")),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(format!("stat {p} failed: {e}")),
            }
        })
        .collect()
}

#[tauri::command]
async fn path_exists(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || path_exists_sync(path))
        .await
        .unwrap_or(false)
}

fn path_exists_sync(path: String) -> bool {
    PathBuf::from(&path).exists()
}

/// 拖放打开前的目录判定。
#[tauri::command]
async fn is_directory(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// 在资源管理器中定位文件（explorer /select）。
#[tauri::command]
async fn show_in_folder(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.replace('/', "\\")))
            .spawn()
            .map_err(|e| format!("explorer failed: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("explorer failed: {e}"))?
}

#[tauri::command]
async fn open_directory(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = PathBuf::from(&path);
        if !directory.is_absolute() || !directory.is_dir() {
            return Err("Directory does not exist or is not absolute".into());
        }
        std::process::Command::new("explorer")
            .arg(path.replace('/', "\\"))
            .spawn()
            .map_err(|e| format!("explorer failed: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("explorer failed: {e}"))?
}

fn strict_decode(bytes: &[u8], encoding: &'static encoding_rs::Encoding) -> Result<String, String> {
    let (text, _, had_errors) = encoding.decode(bytes);
    if had_errors { Err(format!("文件内容不是有效的 {}，已停止读取以避免保存损坏", encoding.name())) }
    else { Ok(text.into_owned()) }
}

pub fn decode(bytes: &[u8]) -> Result<(String, &'static str), String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let body = &bytes[3..];
        // BOM 声明 UTF-8 但内容不符（如 GBK 文件被加了 UTF-8 BOM）时落 GBK 兜底，
        // 不得 lossy 解出替换字符——否则保存会把 U+FFFD 写回，静默损坏原文件
        return match std::str::from_utf8(body) {
            Ok(s) => Ok((s.to_owned(), "utf8-bom")),
            Err(_) => Ok((strict_decode(body, encoding_rs::GBK)?, "gbk")),
        };
    }
    // UTF-32 BOM 必须先于 UTF-16 嗅探：FF FE 00 00 会被 UTF-16LE 抢先命中解出乱码。
    // 不支持 UTF-32 时拒绝读取，不能剥掉 BOM 后冒充其他编码供编辑保存。
    if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) || bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF]) {
        return Err("暂不支持 UTF-32，请先转换为 UTF-8 或 UTF-16".into());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Ok((strict_decode(&bytes[2..], encoding_rs::UTF_16LE)?, "utf16le"));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Ok((strict_decode(&bytes[2..], encoding_rs::UTF_16BE)?, "utf16be"));
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => Ok((s.to_owned(), "utf8")),
        Err(_) => Ok((strict_decode(bytes, encoding_rs::GBK)?, "gbk")),
    }
}

pub fn encode(content: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding {
        "utf8" => Ok(content.as_bytes().to_vec()),
        "utf8-bom" => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(content.as_bytes());
            Ok(v)
        }
        "utf16le" => {
            let mut v = vec![0xFF, 0xFE];
            for u in content.encode_utf16() {
                v.extend_from_slice(&u.to_le_bytes());
            }
            Ok(v)
        }
        "utf16be" => {
            let mut v = vec![0xFE, 0xFF];
            for u in content.encode_utf16() {
                v.extend_from_slice(&u.to_be_bytes());
            }
            Ok(v)
        }
        other => {
            let enc = encoding_rs::Encoding::for_label(other.as_bytes())
                .ok_or_else(|| format!("unsupported encoding: {other}"))?;
            let (cow, _, had_errors) = enc.encode(content);
            if had_errors {
                return Err(format!(
                    "内容包含 {other} 无法表示的字符，请改用 UTF-8 保存"
                ));
            }
            Ok(cow.into_owned())
        }
    }
}

fn decode_as(bytes: &[u8], encoding: &str) -> Result<(String, String), String> {
    let skip = match encoding {
        "utf8-bom" if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) => 3,
        "utf16le" if bytes.starts_with(&[0xFF, 0xFE]) => 2,
        "utf16be" if bytes.starts_with(&[0xFE, 0xFF]) => 2,
        _ => 0,
    };
    let body = &bytes[skip..];
    let name = encoding.to_owned();
    match encoding {
        "utf8" | "utf8-bom" => String::from_utf8(body.to_vec())
            .map(|s| (s, name))
            .map_err(|_| format!("文件内容不是有效的 UTF-8: {encoding}")),
        "utf16le" => Ok((strict_decode(body, encoding_rs::UTF_16LE)?, name)),
        "utf16be" => Ok((strict_decode(body, encoding_rs::UTF_16BE)?, name)),
        other => {
            let enc = encoding_rs::Encoding::for_label(other.as_bytes())
                .ok_or_else(|| format!("unsupported encoding: {other}"))?;
            Ok((strict_decode(body, enc)?, name))
        }
    }
}

#[tauri::command]
async fn read_file(path: String, encoding: Option<String>) -> Result<FileContent, String> {
    tauri::async_runtime::spawn_blocking(move || read_file_sync(path, encoding))
        .await
        .map_err(|e| format!("read_file task failed: {e}"))?
}

fn read_file_sync(path: String, encoding: Option<String>) -> Result<FileContent, String> {
    use std::io::Read;
    let before = fs::metadata(&path).map_err(|e| format!("stat {path} failed: {e}"))?;
    if before.len() > MAX_FILE_BYTES { return Err("文件超过 64 MiB 读取上限".into()); }
    let file = fs::File::open(&path).map_err(|e| format!("read {path} failed: {e}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).map_err(|e| format!("read {path} failed: {e}"))?;
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err("文件超过 64 MiB 读取上限".into()); }
    let after = fs::metadata(&path).map_err(|e| format!("stat {path} failed: {e}"))?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() || bytes.len() as u64 != after.len() {
        return Err("文件在读取期间发生变化，请重新打开".into());
    }
    let (content, encoding) = match encoding.as_deref() {
        Some(enc) => decode_as(&bytes, enc)?,
        None => {
            let (s, enc) = decode(&bytes)?;
            (s, enc.to_owned())
        }
    };
    Ok(FileContent {
        content,
        encoding,
        mtime: after.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0),
    })
}

/// 原子写：先写同目录临时文件并落盘，再 rename 覆盖目标；失败清理临时文件，原文件不受影响。
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut tmp_name = path.as_os_str().to_owned();
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    tmp_name.push(format!(".rtlviewer-{}-{sequence}.tmp", std::process::id()));
    let tmp = PathBuf::from(tmp_name);
    // create_new 不覆盖其他进程或遗留文件；只有创建成功后才拥有清理权。
    let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    let result = (|| -> std::io::Result<()> {
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[tauri::command]
async fn write_file(path: String, content: String, encoding: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || write_file_sync(path, content, encoding))
        .await
        .map_err(|e| format!("write_file task failed: {e}"))?
}

fn write_file_sync(path: String, content: String, encoding: String) -> Result<u64, String> {
    let bytes = encode(&content, &encoding)?;
    atomic_write(Path::new(&path), &bytes).map_err(|e| format!("write {path} failed: {e}"))?;
    Ok(mtime_ms(&path))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            read_file,
            write_file,
            file_states,
            path_exists,
            is_directory,
            show_in_folder,
            open_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running rtl-viewer");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_limit_and_stat_errors_are_explicit() {
        let path = temp_file("oversize.v", b"");
        fs::File::options().write(true).open(&path).unwrap().set_len(MAX_FILE_BYTES + 1).unwrap();
        assert!(read_file_sync(path.clone(), None).err().unwrap().contains("64 MiB"));
        let parent = Path::new(&path).parent().unwrap().to_string_lossy().into_owned();
        assert!(file_states_sync(vec![parent]).is_err());
    }

    #[test]
    fn scan_filters_user_sources_and_generated_directories() {
        let path = temp_file("scan_root_anchor", b"");
        let root = Path::new(&path).parent().unwrap().join("scan_filters");
        for relative in ["rtl/top.V", "sim/tb.sv", "ipcore_dir/core.v", "rtl/pins.XDC", "ip/core.xci", "target.v"] {
            let file = root.join(relative);
            fs::create_dir_all(file.parent().unwrap()).unwrap(); fs::write(file, b"").unwrap();
        }
        for dir in ["node_modules", "target", "dist", ".hidden", "p.runs", "p.sim", "p.cache", "p.hw", "p.gen", "p.ip_user_files"] {
            let directory = root.join(dir); fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("excluded.v"), b"").unwrap();
        }
        let out = scan_folder_sync(normalize(&root)).unwrap();
        assert_eq!(out.hdl.len(), 4); assert_eq!(out.xci.len(), 1); assert_eq!(out.con.len(), 1);
        assert!(!out.hdl.iter().any(|p| p.ends_with("excluded.v")));
    }

    #[test]
    #[cfg(windows)]
    fn normalized_verbatim_and_long_paths_remain_readable() {
        assert_eq!(normalize(Path::new(r"\\?\D:\rtl\top.v")), "D:/rtl/top.v");
        assert_eq!(normalize(Path::new(r"\\?\UNC\server\share\top.v")), "//server/share/top.v");
        let anchor = temp_file("long_path_anchor", b"");
        let mut directory = fs::canonicalize(Path::new(&anchor).parent().unwrap()).unwrap();
        for _ in 0..4 { directory.push("x".repeat(70)); }
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("long.v"); fs::write(&path, b"module long; endmodule").unwrap();
        let norm = normalize(&path); assert!(norm.len() > 260);
        assert_eq!(read_file_sync(norm.clone(), None).unwrap().content, "module long; endmodule");
        write_file_sync(norm.clone(), "module edited; endmodule".into(), "utf8".into()).unwrap();
        assert_eq!(read_file_sync(norm, None).unwrap().content, "module edited; endmodule");
    }

    #[test]
    fn malformed_encodings_refuse_read_instead_of_lossy_edit() {
        for (name, bytes) in [
            ("bad_utf16.v", vec![0xff, 0xfe, 0x00, 0xd8]),
            ("odd_utf16.v", vec![0xff, 0xfe, 0x61]),
            ("utf32.v", vec![0xff, 0xfe, 0, 0, 0x61, 0, 0, 0]),
            ("bad_gbk.v", vec![0x81]),
        ] {
            let path = temp_file(name, &bytes);
            assert!(read_file_sync(path.clone(), None).is_err(), "{name}");
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
        assert!(decode_as(&[0, 0xd8], "utf16le").is_err());
        assert!(decode_as(&[0x81], "gbk").is_err());
    }

    #[test]
    fn atomic_write_preserves_preexisting_temporary_name() {
        let path = temp_file("preserve_legacy_atomic.v", b"old");
        let legacy_tmp = format!("{path}.rtlviewer-tmp");
        fs::write(&legacy_tmp, b"unrelated").unwrap();
        atomic_write(Path::new(&path), b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read(&legacy_tmp).unwrap(), b"unrelated");
    }

    #[test]
    fn utf8_no_bom() {
        let (s, enc) = decode("中文 module".as_bytes()).unwrap();
        assert_eq!(enc, "utf8");
        assert_eq!(s, "中文 module");
    }

    #[test]
    fn utf8_bom() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice("abc".as_bytes());
        let (s, enc) = decode(&b).unwrap();
        assert_eq!(enc, "utf8-bom");
        assert_eq!(s, "abc");
    }

    #[test]
    fn utf8_bom_with_gbk_body_falls_back_to_gbk() {
        // BOM 声明 UTF-8 但内容是 GBK：不得 lossy 解出替换字符（保存即毁原文件），落 GBK 兜底
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice(&[0xD6, 0xD0, 0xCE, 0xC4]); // "中文" 的 GBK 编码
        let (s, enc) = decode(&b).unwrap();
        assert_eq!(enc, "gbk");
        assert_eq!(s, "中文");
    }

    #[test]
    fn gbk_fallback() {
        // "中文" 的 GBK 编码
        let gbk_bytes = [0xD6, 0xD0, 0xCE, 0xC4];
        let (s, enc) = decode(&gbk_bytes).unwrap();
        assert_eq!(enc, "gbk");
        assert_eq!(s, "中文");
    }

    #[test]
    fn ascii_is_utf8() {
        let (_, enc) = decode(b"module top;").unwrap();
        assert_eq!(enc, "utf8");
    }

    #[test]
    fn gbk_roundtrip() {
        let bytes = encode("中文注释", "gbk").unwrap();
        let (s, enc) = decode(&bytes).unwrap();
        assert_eq!(enc, "gbk");
        assert_eq!(s, "中文注释");
    }

    #[test]
    fn gbk_unrepresentable_errors() {
        assert!(encode("emoji \u{1F600}", "gbk").is_err());
    }

    #[test]
    fn cjk_encodings_roundtrip() {
        // encoding_rs 标签体系：GB18030/Big5/Shift-JIS/EUC-KR 编解码往返
        let bytes = encode("中文注释", "gb18030").unwrap();
        assert_eq!(decode_as(&bytes, "gb18030").unwrap().0, "中文注释");
        let bytes = encode("繁體中文", "big5").unwrap();
        assert_eq!(decode_as(&bytes, "big5").unwrap().0, "繁體中文");
        assert!(encode("emoji \u{1F600}", "shift_jis").is_err()); // JIS 无 emoji
        assert!(encode("中文", "windows-1252").is_err());
        assert!(decode_as(b"abc", "x-unknown-enc").is_err());
    }

    #[test]
    fn utf16le_roundtrip() {
        let bytes = encode("中文", "utf16le").unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xFE]);
        let (s, enc) = decode(&bytes).unwrap();
        assert_eq!(enc, "utf16le");
        assert_eq!(s, "中文");
    }

    fn temp_file(name: &str, bytes: &[u8]) -> String {
        let dir = std::env::temp_dir().join(format!("rtl-viewer-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// 文件级编辑保存：GBK 文件读出→修改→原编码写回→再读，内容与编码均无损。
    #[test]
    fn gbk_file_edit_save_roundtrip() {
        let original = "// 时钟模块\nmodule top;\n";
        let path = temp_file("gbk_edit.v", &encode(original, "gbk").unwrap());

        let read1 = read_file_sync(path.clone(), None).unwrap();
        assert_eq!(read1.encoding, "gbk");
        assert_eq!(read1.content, original);

        let edited = read1.content.replace("时钟模块", "时钟模块改");
        write_file_sync(path.clone(), edited.clone(), read1.encoding.clone()).unwrap();

        // 落盘字节仍是 GBK（不是合法 UTF-8）
        let raw = fs::read(&path).unwrap();
        assert!(std::str::from_utf8(&raw).is_err());

        let read2 = read_file_sync(path, None).unwrap();
        assert_eq!(read2.encoding, "gbk");
        assert_eq!(read2.content, edited);
    }

    /// UTF-8 BOM 文件保存后 BOM 保留。
    #[test]
    fn utf8_bom_file_edit_save_roundtrip() {
        let path = temp_file("bom_edit.v", &encode("module a;\n", "utf8-bom").unwrap());
        let read1 = read_file_sync(path.clone(), None).unwrap();
        assert_eq!(read1.encoding, "utf8-bom");
        write_file_sync(path.clone(), read1.content.replace("module a", "module b"), read1.encoding)
            .unwrap();
        let raw = fs::read(&path).unwrap();
        assert!(raw.starts_with(&[0xEF, 0xBB, 0xBF]));
        let read2 = read_file_sync(path, None).unwrap();
        assert!(read2.content.starts_with("module b"));
    }

    /// 手动切换编码保存：GBK 读出后以 UTF-8 写回，内容不变、编码改变。
    #[test]
    fn gbk_save_as_utf8() {
        let original = "// 中文注释\nmodule c;\n";
        let path = temp_file("transcode.v", &encode(original, "gbk").unwrap());
        let read1 = read_file_sync(path.clone(), None).unwrap();
        assert_eq!(read1.encoding, "gbk");
        write_file_sync(path.clone(), read1.content.clone(), "utf8".to_owned()).unwrap();
        let read2 = read_file_sync(path, None).unwrap();
        assert_eq!(read2.encoding, "utf8");
        assert_eq!(read2.content, original);
    }

    /// 外部变更监视基础：file_states 对存在文件返回 mtime、缺失文件返回 None；
    /// read_file 与 write_file 的 mtime 一致且写后变化。
    #[test]
    fn file_states_and_mtime() {
        let path = temp_file("mtime.v", b"module m;\n");
        let states = file_states_sync(vec![path.clone(), "definitely/missing.v".to_owned()]).unwrap();
        assert!(states[0].unwrap() > 0);
        assert_eq!(states[1], None);

        let read = read_file_sync(path.clone(), None).unwrap();
        assert_eq!(read.mtime, states[0].unwrap());
        assert!(path_exists_sync(path.clone()));
        assert!(!path_exists_sync("definitely/missing.v".to_owned()));

        std::thread::sleep(std::time::Duration::from_millis(20));
        let new_mtime = write_file_sync(path, "module m2;\n".to_owned(), "utf8".to_owned()).unwrap();
        assert!(new_mtime >= read.mtime);
    }

    /// UTF-32 BOM 不得被误判为 UTF-16（FF FE 00 00 会先命中 UTF-16LE 前缀）。
    /// UTF-32 不支持时明确拒绝，避免用户编辑保存时损坏文件。
    #[test]
    fn utf32_bom_not_misread_as_utf16() {
        // UTF-32LE BOM + "ab" 的 UTF-32LE 编码
        let le = [
            0xFF, 0xFE, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00, 0x62, 0x00, 0x00, 0x00,
        ];
        assert!(decode(&le).is_err());
        // UTF-32BE BOM
        let be = [0x00, 0x00, 0xFE, 0xFF, 0x00, 0x00, 0x00, 0x61];
        assert!(decode(&be).is_err());
        // UTF-16LE BOM 不受影响
        let b16 = [0xFF, 0xFE, 0x61, 0x00];
        let (s, enc) = decode(&b16).unwrap();
        assert_eq!(enc, "utf16le");
        assert_eq!(s, "a");
    }

    /// 原子写：正常写回后无临时文件残留。
    #[test]
    fn atomic_write_leaves_no_tmp() {
        let path = temp_file("atomic.v", b"module a;\n");
        write_file_sync(path.clone(), "module b;\n".to_owned(), "utf8".to_owned()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"module b;\n");
        assert!(!PathBuf::from(format!("{path}.rtlviewer-tmp")).exists());
    }

    /// 原子写失败（目标是目录，rename 必失败）：报错且临时文件被清理。
    #[test]
    fn atomic_write_failure_cleans_tmp() {
        let dir = std::env::temp_dir().join(format!("rtl-viewer-test-{}", std::process::id()));
        let target = dir.join("as_dir.v");
        fs::create_dir_all(&target).unwrap();
        let target_str = target.to_string_lossy().into_owned();
        let result = write_file_sync(target_str.clone(), "module x;".to_owned(), "utf8".to_owned());
        assert!(result.is_err());
        // 目标仍是目录，未被截断成文件
        assert!(target.is_dir());
        assert!(!PathBuf::from(format!("{target_str}.rtlviewer-tmp")).exists());
    }

    /// walk 深度上限：超过 MAX_WALK_DEPTH 的层级不递归、不崩溃。
    #[test]
    fn walk_depth_limit() {
        let root = std::env::temp_dir().join(format!("rtl-viewer-deep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        // 浅层（深度内）与深层（深度外）各放一个 HDL 文件
        let mut shallow = root.clone();
        for _ in 0..10 {
            shallow.push("d");
        }
        let mut deep = root.clone();
        for _ in 0..(MAX_WALK_DEPTH + 10) {
            deep.push("d");
        }
        fs::create_dir_all(&shallow).unwrap();
        fs::create_dir_all(&deep).unwrap();
        fs::write(shallow.join("shallow.v"), b"module s;\n").unwrap();
        fs::write(deep.join("deep.v"), b"module d;\n").unwrap();
        let mut out = ScanResult { hdl: vec![], xci: vec![], con: vec![] };
        walk(&root, &mut out);
        assert_eq!(out.hdl.len(), 1);
        assert!(out.hdl[0].ends_with("shallow.v"));
        let _ = fs::remove_dir_all(&root);
    }

    /// walk 不跟随符号链接：目录自环不会无限递归。无权限创建符号链接时优雅跳过。
    #[test]
    #[cfg(windows)]
    fn walk_skips_symlink_cycle() {
        let root = std::env::temp_dir().join(format!("rtl-viewer-sym-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("real.v"), b"module m;\n").unwrap();
        if std::os::windows::fs::symlink_dir(&root, root.join("sub").join("loop")).is_err() {
            // 非管理员且未开开发者模式时无法创建符号链接，跳过本测试
            let _ = fs::remove_dir_all(&root);
            return;
        }
        let mut out = ScanResult { hdl: vec![], xci: vec![], con: vec![] };
        walk(&root, &mut out);
        assert_eq!(out.hdl.len(), 1);
        assert!(out.hdl[0].ends_with("real.v"));
        let _ = fs::remove_dir_all(&root);
    }
}
