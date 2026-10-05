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

fn walk(dir: &Path, out: &mut ScanResult) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if path.is_dir() {
            if name.starts_with('.')
                || SKIP_DIRS.contains(&name)
                || GENERATED_DIR_SUFFIXES.iter().any(|s| name.ends_with(s))
            {
                continue;
            }
            walk(&path, out);
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
    path.to_string_lossy().replace('\\', "/")
}

#[tauri::command]
fn scan_folder(path: String) -> Result<ScanResult, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
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
fn file_states(paths: Vec<String>) -> Vec<Option<u64>> {
    paths
        .iter()
        .map(|p| {
            let m = mtime_ms(p);
            if m == 0 { None } else { Some(m) }
        })
        .collect()
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

/// 在资源管理器中定位文件（explorer /select）。
#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg("/select,")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("explorer failed: {e}"))?;
    Ok(())
}

pub fn decode(bytes: &[u8]) -> (String, &'static str) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (
            String::from_utf8_lossy(&bytes[3..]).into_owned(),
            "utf8-bom",
        );
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (s, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return (s.into_owned(), "utf16le");
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (s, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return (s.into_owned(), "utf16be");
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_owned(), "utf8"),
        Err(_) => {
            let (s, _, _) = encoding_rs::GBK.decode(bytes);
            (s.into_owned(), "gbk")
        }
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
        "utf16le" => Ok((encoding_rs::UTF_16LE.decode(body).0.into_owned(), name)),
        "utf16be" => Ok((encoding_rs::UTF_16BE.decode(body).0.into_owned(), name)),
        other => {
            let enc = encoding_rs::Encoding::for_label(other.as_bytes())
                .ok_or_else(|| format!("unsupported encoding: {other}"))?;
            Ok((enc.decode(body).0.into_owned(), name))
        }
    }
}

#[tauri::command]
fn read_file(path: String, encoding: Option<String>) -> Result<FileContent, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read {path} failed: {e}"))?;
    let (content, encoding) = match encoding.as_deref() {
        Some(enc) => decode_as(&bytes, enc)?,
        None => {
            let (s, enc) = decode(&bytes);
            (s, enc.to_owned())
        }
    };
    Ok(FileContent {
        content,
        encoding,
        mtime: mtime_ms(&path),
    })
}

#[tauri::command]
fn write_file(path: String, content: String, encoding: String) -> Result<u64, String> {
    let bytes = encode(&content, &encoding)?;
    fs::write(&path, bytes).map_err(|e| format!("write {path} failed: {e}"))?;
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
            show_in_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running rtl-viewer");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_no_bom() {
        let (s, enc) = decode("中文 module".as_bytes());
        assert_eq!(enc, "utf8");
        assert_eq!(s, "中文 module");
    }

    #[test]
    fn utf8_bom() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice("abc".as_bytes());
        let (s, enc) = decode(&b);
        assert_eq!(enc, "utf8-bom");
        assert_eq!(s, "abc");
    }

    #[test]
    fn gbk_fallback() {
        // "中文" 的 GBK 编码
        let gbk_bytes = [0xD6, 0xD0, 0xCE, 0xC4];
        let (s, enc) = decode(&gbk_bytes);
        assert_eq!(enc, "gbk");
        assert_eq!(s, "中文");
    }

    #[test]
    fn ascii_is_utf8() {
        let (_, enc) = decode(b"module top;");
        assert_eq!(enc, "utf8");
    }

    #[test]
    fn gbk_roundtrip() {
        let bytes = encode("中文注释", "gbk").unwrap();
        let (s, enc) = decode(&bytes);
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
        let (s, enc) = decode(&bytes);
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

        let read1 = read_file(path.clone(), None).unwrap();
        assert_eq!(read1.encoding, "gbk");
        assert_eq!(read1.content, original);

        let edited = read1.content.replace("时钟模块", "时钟模块改");
        write_file(path.clone(), edited.clone(), read1.encoding.clone()).unwrap();

        // 落盘字节仍是 GBK（不是合法 UTF-8）
        let raw = fs::read(&path).unwrap();
        assert!(std::str::from_utf8(&raw).is_err());

        let read2 = read_file(path, None).unwrap();
        assert_eq!(read2.encoding, "gbk");
        assert_eq!(read2.content, edited);
    }

    /// UTF-8 BOM 文件保存后 BOM 保留。
    #[test]
    fn utf8_bom_file_edit_save_roundtrip() {
        let path = temp_file("bom_edit.v", &encode("module a;\n", "utf8-bom").unwrap());
        let read1 = read_file(path.clone(), None).unwrap();
        assert_eq!(read1.encoding, "utf8-bom");
        write_file(path.clone(), read1.content.replace("module a", "module b"), read1.encoding)
            .unwrap();
        let raw = fs::read(&path).unwrap();
        assert!(raw.starts_with(&[0xEF, 0xBB, 0xBF]));
        let read2 = read_file(path, None).unwrap();
        assert!(read2.content.starts_with("module b"));
    }

    /// 手动切换编码保存：GBK 读出后以 UTF-8 写回，内容不变、编码改变。
    #[test]
    fn gbk_save_as_utf8() {
        let original = "// 中文注释\nmodule c;\n";
        let path = temp_file("transcode.v", &encode(original, "gbk").unwrap());
        let read1 = read_file(path.clone(), None).unwrap();
        assert_eq!(read1.encoding, "gbk");
        write_file(path.clone(), read1.content.clone(), "utf8".to_owned()).unwrap();
        let read2 = read_file(path, None).unwrap();
        assert_eq!(read2.encoding, "utf8");
        assert_eq!(read2.content, original);
    }

    /// 外部变更监视基础：file_states 对存在文件返回 mtime、缺失文件返回 None；
    /// read_file 与 write_file 的 mtime 一致且写后变化。
    #[test]
    fn file_states_and_mtime() {
        let path = temp_file("mtime.v", b"module m;\n");
        let states = file_states(vec![path.clone(), "definitely/missing.v".to_owned()]);
        assert!(states[0].unwrap() > 0);
        assert_eq!(states[1], None);

        let read = read_file(path.clone(), None).unwrap();
        assert_eq!(read.mtime, states[0].unwrap());
        assert!(path_exists(path.clone()));
        assert!(!path_exists("definitely/missing.v".to_owned()));

        std::thread::sleep(std::time::Duration::from_millis(20));
        let new_mtime = write_file(path, "module m2;\n".to_owned(), "utf8".to_owned()).unwrap();
        assert!(new_mtime >= read.mtime);
    }
}
