# rtl-viewer

FPGA/ASIC 源码工程查看器：打开源码文件夹，自动识别 Verilog/SystemVerilog/VHDL 源码与 Vivado IP 核（`.xci`），左侧按例化关系展示 Vivado 风格层级树，右侧为 Monaco 代码编辑器。

## 功能

- **层级树**：从顶层模块按例化关系逐层展开；多顶层时自动识别（仿真环境向内解包出真实顶层），树上方下拉可切换；点击节点跳到父模块中的例化点；IP 核显示为黑盒节点（点击从 `.veo`/stub 提取端口信息，无 stub 时显示 VLNV）；未引用模块归入「未使用」分组；循环例化标注不展开。
- **全局搜索**：侧栏搜索框跨文件纯文本搜索（Ctrl+Shift+F 聚焦），按文件分组展示、命中高亮，点击结果跳转到行；Aa 切换大小写敏感。
- **当前文件大纲**：侧栏下方列出当前文件的模块/信号/进程/函数，点击跳行，编辑时自动刷新。
- **导航历史**：跳转前自动记录位置，Alt+←/→ 或标签栏按钮前进后退。
- **例化端口悬停**：鼠标悬停在例化名上显示端口连接表（端口 → 实际信号），点击信号名跳声明，Ctrl+K 钉住面板便于对照查看。
- **编辑器**：Monaco（VS Code 内核），Verilog/SV/VHDL 语法高亮；多标签页、未保存 `*` 标记、保存（Ctrl+S）/另存为/新建、查找替换、Ctrl+Click 跳转模块定义。
- **约束文件查看**：`.xdc`/`.sdc` 以「约束」分组展示在树中，Tcl 语法高亮只读查看（IP 生成目录的约束不进索引）。
- **外部变更监视**：文件在磁盘被外部修改时，干净标签自动重载、未保存标签标 ⚠；保存时若磁盘已变，弹出「覆盖 / 放弃重载 / 取消」三选，防误覆盖 Vivado 重新生成的内容。
- **最近工程**：工具栏 ▾ 下拉或 Ctrl+R 列出最近打开的 8 个工程，一键切换。
- **编码自适应**：自动识别 UTF-8/UTF-8 BOM/UTF-16/GBK，默认按原编码写回，状态栏可手动「以 X 编码重新打开 / 以 X 编码保存」，兼容 Vivado 默认 ANSI（GBK）工程。
- **快速轻量**：结构扫描只提取模块与例化边，端口按需解析；IP 生成目录不进索引；Windows 单 exe 便携运行，免安装。

## 技术栈

Tauri v2（Rust 后端：文件扫描、编解码、对话框）+ Vite + TypeScript + Monaco Editor；测试用 Vitest（前端）与 cargo test（Rust 编码层）。

## 构建与运行

```bash
npm install
npm run build         # 前端构建（tsc 类型检查 + vite）
npm test              # 前端单元与集成测试
npm run tauri dev     # 开发运行（另需 Rust 环境，见下）
```

Rust 端命令通过 `scripts/Invoke-Cargo.ps1` 执行（自动引入工具链与 MSVC 环境）：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Invoke-Cargo.ps1 test --manifest-path src-tauri/Cargo.toml
```

打包便携 exe 必须走 tauri CLI（裸 `cargo build` 产出的是 dev 模式 exe，界面依赖 dev server，无法独立运行）：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Build-Release.ps1
```

产物 `src-tauri/target/release/rtl-viewer.exe` 即为便携可执行文件，双击运行。

前置：Rust stable（本机经 `D:\workspace\toolchains\rust\`，项目 `rust-toolchain.toml` 固定 1.98.1）、Node 24、WebView2 Runtime（Win10/11 自带）。

## 目录

```text
src/         前端：parser/（HDL 解析）、model/（索引、层级树、搜索、导航历史、大纲提取）、editor/（Monaco 与标签页）、ui/（树、搜索面板、大纲、状态栏）
src-tauri/   Rust 后端
tests/       Vitest 测试（含真实工程验收 tests/acceptance-cp7.test.ts，夹具在 .tmp，不入库）
scripts/     构建辅助（Build-Release.ps1、Invoke-Cargo.ps1、make-icon.mjs）
```
