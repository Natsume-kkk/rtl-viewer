import { invoke } from "@tauri-apps/api/core";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";

export interface ScanResult {
  hdl: string[];
  xci: string[];
}

export interface FileContent {
  content: string;
  encoding: string;
}

export function scanFolder(path: string): Promise<ScanResult> {
  return invoke<ScanResult>("scan_folder", { path });
}

export function readFile(path: string, encoding?: string): Promise<FileContent> {
  return invoke<FileContent>("read_file", { path, encoding: encoding ?? null });
}

export function writeFile(path: string, content: string, encoding: string): Promise<void> {
  return invoke<void>("write_file", { path, content, encoding });
}

export async function openFolderDialog(): Promise<string | null> {
  const selected = await open({ directory: true, title: "选择源码文件夹" });
  return typeof selected === "string" ? selected : null;
}

export function saveFileDialog(defaultPath?: string): Promise<string | null> {
  return save({
    title: "另存为",
    defaultPath,
    filters: [
      { name: "HDL", extensions: ["v", "sv", "vh", "svh", "vhd", "vhdl"] },
      { name: "All", extensions: ["*"] },
    ],
  });
}

export function confirmDialog(message: string): Promise<boolean> {
  return confirm(message, { title: "rtl-viewer", kind: "warning" });
}
