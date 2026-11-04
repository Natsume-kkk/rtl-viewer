#[cfg(feature = "bundled-tools")]
use std::fs;
#[cfg(feature = "bundled-tools")]
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=../tools/windows-x64");
    println!("cargo:rerun-if-changed=../tools/licenses");
    #[cfg(feature = "bundled-tools")]
    embed_tools();
    tauri_build::build()
}

#[cfg(feature = "bundled-tools")]
fn embed_tools() {
    let root = PathBuf::from("../tools");
    if !root.join("windows-x64/verilator/bin/verilator_bin.exe").is_file()
        || !root.join("windows-x64/ghdl/bin/ghdl.exe").is_file()
    {
        panic!("bundled-tools requires tools/windows-x64 with Verilator and GHDL");
    }
    let mut files = Vec::new();
    collect_files(&root, &root, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut revision = 0xcbf29ce484222325u64;
    let mut generated = String::from("pub static TOOL_FILES: &[(&str, &[u8])] = &[\n");
    for (relative, path) in files {
        let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        for byte in relative.bytes().chain([0]).chain(bytes.iter().copied()) {
            revision ^= u64::from(byte);
            revision = revision.wrapping_mul(0x100000001b3);
        }
        generated.push_str(&format!("    ({:?}, include_bytes!({:?})),\n", relative, path.canonicalize().unwrap()));
    }
    generated.push_str("];\n");
    generated.push_str(&format!("pub const TOOL_REVISION: &str = \"{revision:016x}\";\n"));
    fs::write(PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("embedded_tools.rs"), generated).unwrap();
}

#[cfg(feature = "bundled-tools")]
fn collect_files(root: &Path, directory: &Path, out: &mut Vec<(String, PathBuf)>) {
    let mut entries: Vec<_> = fs::read_dir(directory).unwrap().map(|entry| entry.unwrap().path()).collect();
    entries.sort();
    for path in entries {
        let meta = fs::symlink_metadata(&path).unwrap();
        if meta.file_type().is_symlink() {
            panic!("tool resources must not contain symlinks: {}", path.display());
        }
        if meta.is_dir() {
            collect_files(root, &path, out);
        } else if meta.is_file() {
            let relative = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            out.push((relative, path));
        }
    }
}
