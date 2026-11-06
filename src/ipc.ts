import { Channel, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface ScanIssue { file: string; reason: string }

export interface ScanResult {
  hdl: string[];
  xci: string[];
  /** 约束文件（.xdc/.sdc），只读查看不参与索引 */
  con: string[];
  issues?: ScanIssue[];
}

export interface FileContent {
  content: string;
  encoding: string;
  /** 磁盘修改时间（毫秒时间戳） */
  mtime: number;
}

export function scanFolder(path: string): Promise<ScanResult> {
  return invoke<ScanResult>("scan_folder", { path });
}

export function readFile(path: string, encoding?: string): Promise<FileContent> {
  return invoke<FileContent>("read_file", { path, encoding: encoding ?? null });
}

/** 写回文件，返回落盘后的 mtime（毫秒时间戳）。 */
export function writeFile(path: string, content: string, encoding: string): Promise<number> {
  return invoke<number>("write_file", { path, content, encoding });
}

/** 批量查询文件 mtime；文件不存在对应位置为 null。 */
export function fileStates(paths: string[]): Promise<(number | null)[]> {
  return invoke<(number | null)[]>("file_states", { paths });
}

export function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

/** 拖放打开前的目录判定。 */
export function isDirectory(path: string): Promise<boolean> {
  return invoke<boolean>("is_directory", { path });
}

/** 在资源管理器中定位文件。 */
export function showInFolder(path: string): Promise<void> {
  return invoke<void>("show_in_folder", { path });
}

/** 打开目录本身，不在父目录中选中它。 */
export function openDirectory(path: string): Promise<void> {
  return invoke<void>("open_directory", { path });
}

/** Windows 入站路径（对话框、拖放）统一为 `/` 分隔，与扫描结果及索引键一致。 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export async function openFolderDialog(): Promise<string | null> {
  const selected = await open({ directory: true, title: "选择源码文件夹" });
  return typeof selected === "string" ? normalizePath(selected) : null;
}

export async function openFileDialog(defaultPath?: string): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    title: "打开源码文件",
    defaultPath,
    filters: [
      { name: "HDL 源码与约束文件", extensions: ["v", "sv", "vh", "svh", "vhd", "vhdl", "xdc", "sdc"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  return typeof selected === "string" ? normalizePath(selected) : null;
}

export async function saveFileDialog(defaultPath?: string): Promise<string | null> {
  const selected = await save({
    title: "另存为",
    defaultPath,
    filters: [
      { name: "HDL 源码文件", extensions: ["v", "sv", "vh", "svh", "vhd", "vhdl"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  return selected ? normalizePath(selected) : null;
}

export interface SyntaxDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | string;
  ruleId: string;
  source: "verilator" | "ghdl" | "system" | string;
  message: string;
}

export interface BackendSummary {
  name: string;
  version: string;
  files: number;
  status: string;
}

export interface SyntaxCheckResult {
  requestId: number;
  diagnostics: SyntaxDiagnostic[];
  checkedFiles: number;
  backends: BackendSummary[];
  cancelled: boolean;
}

export interface SyntaxProgress {
  stage: string;
  file: string;
  completed: number;
  total: number;
}

export interface SyntaxStub {
  name: string;
  source: string;
}

export interface VhdlLibraryMapping {
  library: string;
  file: string;
}

export interface SyntaxCheckOptions {
  top: string;
  defines: string[];
  includeDirs: string[];
  vhdlLibraries: VhdlLibraryMapping[];
  verilatorArgs: string[];
  ghdlArgs: string[];
}

export const emptySyntaxCheckOptions: SyntaxCheckOptions = { top: "", defines: [], includeDirs: [], vhdlLibraries: [], verilatorArgs: [], ghdlArgs: [] };

export interface SourceSnapshot {
  file: string;
  content: string;
  encoding: string;
}

export function runSyntaxCheck(root: string, files: string[], top: string | undefined, requestId: number, progress: (event: SyntaxProgress) => void, stubs: SyntaxStub[] = [], options: SyntaxCheckOptions = emptySyntaxCheckOptions, snapshots: SourceSnapshot[] = [], vhdlStubs: SyntaxStub[] = []): Promise<SyntaxCheckResult> {
  const channel = new Channel<SyntaxProgress>();
  channel.onmessage = progress;
  return invoke<SyntaxCheckResult>("run_syntax_check", { request: { requestId, root, files, top: top ?? null, stubs, vhdlStubs, options, snapshots }, channel });
}

export function cancelSyntaxCheck(requestId: number): Promise<void> {
  return invoke<void>("cancel_syntax_check", { requestId });
}

export async function saveReportDialog(format: "html" | "csv", defaultPath: string): Promise<string | null> {
  const selected = await save({
    title: "导出语法检查报告",
    defaultPath,
    filters: [{ name: format === "html" ? "HTML 报告" : "CSV 报告", extensions: [format] }],
  });
  return selected ? normalizePath(selected) : null;
}
