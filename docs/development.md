# 开发指南

[返回项目首页](../README.md)

以下命令在项目根目录、PowerShell 7 中执行。

## 环境准备

源码构建面向 Windows x64，需要 Node 24、PowerShell 7、Rust MSVC 工具链（版本由 `rust-toolchain.toml` 固定）、Visual Studio／Build Tools 的“使用 C++ 的桌面开发”组件及 Windows SDK，以及 WebView2 Runtime。安装说明见 [Tauri 官方 Windows 前置条件](https://v2.tauri.app/start/prerequisites/#windows)。

## 安装与开发

在项目根目录执行：

```powershell
npm ci
. ./scripts/Initialize-BuildEnvironment.ps1
npm run tauri dev
```

`npm ci` 按锁文件安装；`npm run build` 执行 TypeScript 检查和前端构建。环境脚本只初始化当前 PowerShell 进程，开发与打包均使用项目内 npm 版 Tauri CLI。

脚本优先复用 PATH 中的 Cargo，未找到时从 `CARGO_HOME/bin` 或用户默认 `.cargo/bin` 查找；保留已有 `CARGO_HOME`、`RUSTUP_HOME`。MSVC 使用当前开发终端环境，或通过 vswhere 自动发现。自定义安装位置可在当前终端指定：

```powershell
$env:CARGO_HOME = '<cargo-directory>'
$env:RUSTUP_HOME = '<rustup-directory>'
$env:RTL_VIEWER_VSDEVSHELL = '<visual-studio-directory>/Common7/Tools/Launch-VsDevShell.ps1'
```

只设置实际需要覆盖的变量，不修改系统配置。已有 Developer PowerShell 可不设置 `RTL_VIEWER_VSDEVSHELL`。

## 测试与打包

前端测试、类型检查与构建，以及后端测试和便携版打包分别使用以下命令。打包入口使用项目内 Tauri CLI：

```powershell
npm test
npm run build
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Invoke-Cargo.ps1 test --locked --manifest-path src-tauri/Cargo.toml
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Build-Release.ps1
```

唯一交付入口为 `release/rtl-viewer.exe`，双击运行；脚本构建后读取 Cargo 输出目录并复制到此处。若目标被运行中的窗口占用，脚本会报告交付失败；保存工作并退出该窗口后重新运行。不要用裸 `cargo build` 生成分发文件，它不经过 Tauri 的前端打包流程。

## 自动检查

[GitHub Actions 工作流](../.github/workflows/ci.yml) 在推送 `main`、提交拉取请求或手动触发时运行 Windows 检查：按锁文件安装依赖、执行前端和 Rust 测试，并通过正式打包入口完成 TypeScript 检查、前端构建和便携 exe 构建。成功后可在该次运行的 Artifacts 中下载 `rtl-viewer-windows-x64`，保留 7 天。

自动检查使用仓库内独立样例；私有工程测试需要显式配置本地目录，桌面交互需在实际运行环境中验证。

## 验收数据与浏览器预览

`npm test` 默认运行单元测试及 `tests/samples/basic/` 中随仓库提供的独立样例，覆盖 Verilog／VHDL 混合层级、IP 黑盒、约束文件和寄存器来源。样例用于查看器验收，不是可综合工程，其中 `.xci` 是手工编写的最小解析输入。

三个私有工程套件默认跳过，显式配置目录后才运行；配置不存在或不是目录时直接报错，不作为跳过处理：

| 环境变量 | 对应测试输入 |
|---|---|
| `RTL_VIEWER_ACCEPTANCE_CP7` | 原 CP7 Camera Link 验收副本根目录，通常位于 `tests/fixtures/cp7/project` |
| `RTL_VIEWER_ACCEPTANCE_P1` | 既有 P1 Vivado 验收工程根目录 |
| `RTL_VIEWER_ACCEPTANCE_P2` | 既有 P2 ISE 验收工程根目录 |

这些套件包含特定工程的结构断言，不适用于任意 HDL 文件夹。未运行私有套件不等于真实工程验收通过。

浏览器预览的文件服务默认关闭。下面将仓库样例复制到独立临时目录，允许在副本中编辑与保存；对话框会使用服务实际配置的目录，无需修改源码路径：

```powershell
$previewRoot = Join-Path '.tmp' ('browser-preview-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $previewRoot -Force | Out-Null
Copy-Item -Path 'tests/samples/basic/*' -Destination $previewRoot -Recurse
$env:RTL_VIEWER_E2E_ROOT = (Resolve-Path $previewRoot).Path
npm run dev
# 打开 http://localhost:1420/?e2e ，点击“打开文件夹”。
# 停止服务后，可移除当前终端变量：Remove-Item Env:RTL_VIEWER_E2E_ROOT
```

文件访问限制在指定目录内；E2E mock 和文件服务不进入生产构建。真实工程编辑验收同样只使用隔离副本。

## 架构与目录

```text
src/         前端：analysis/（按需运算语义与单模块逻辑）、parser/（HDL 解析）、model/（索引、层级树、搜索、导航历史、大纲、信号声明定位）、app/（编辑工作区、工程扫描、外部变更监视、信号链与模块元数据）、editor/（Monaco、标签页、代码补全）、ui/（树、搜索面板、大纲、状态栏、对话框、右键菜单、最近工程）
src-tauri/   本机 Rust 桌面后端：源码在 src/，负责文件扫描、编码读写与系统调用；另含桌面配置和图标
docs/        使用指南、开发指南与 assets/ 界面素材
tests/       Vitest 测试；samples/ 为可提交样例，fixtures/ 为不入 Git 的私有验收副本；私有套件通过环境变量显式启用
scripts/     构建辅助（Build-Release.ps1、Invoke-Cargo.ps1、make-icon.mjs、Capture-Window.ps1 exe 窗口冒烟截图）
release/     便携 exe 交付物（Build-Release.ps1 生成，不入 Git）
```

`src/` 与 `src-tauri/` 属于同一个桌面应用，通过 `src/ipc.ts` 通信；HDL 解析和信号分析在前端执行，磁盘访问与编码读写在本机 Rust 后端执行。

| 生成目录 | 用途 |
|---|---|
| `dist/` | Vite 前端构建资源，打包时嵌入 exe |
| `src-tauri/target/` | Cargo 编译输出与增量缓存，清理后下次编译需重建 |
| `src-tauri/gen/` | Tauri 生成的配置 schema |
| `release/` | 正式便携交付物，只使用 `rtl-viewer.exe` |
| `.tmp/<task-slug>/` | 临时夹具、截图、日志与页面快照 |

上述生成目录不入 Git。`tests/fixtures/` 是真实工程验收副本，属于测试输入，不能作为普通构建缓存清理。

## 独立分析样例

[信号运算过程样例](../examples/computation/README.md) 复用源码分析层，生成可离线打开的交互页面；这是独立阅读实验，使用方法与分析范围见样例说明。

## 维护要点

### 解析与层级

解析入口在 [src/parser/](../src/parser/)，采用文本级扫描。`scanStructure` 提取定义名与例化边，`parseFile` 按需补端口，`parseFileDetail` 按需补端口连接；扩展语法前先补失败测试，不在打开工程时全量解析。

以下限制属于现有解析范围，扩展前需评估索引、定位与信号分析的共同影响：

| 写法或场景 | 现有边界 |
|---|---|
| Verilog 转义标识符（如 `\foo`） | 不支持 |
| 宏调用形式的例化 | 不支持 |
| 非 ANSI 端口的体内声明 | 不提取方向和宽度 |
| SystemVerilog 嵌套 module | 不支持 |
| Verilog 命名 begin 块中的局部变量 | 不区分局部作用域，可能与同名模块信号混同 |
| Verilog 无端口例化 `foo u;` | 不支持 |
| VHDL 端口省略 mode | 不按语言默认的 `in` 补全，该端口被丢弃 |
| VHDL 裸名无 map 例化 `u1: foo;` | 为避免误匹配 signal／constant 声明，不支持；与 entity／component 形式区分 |
| VHDL configuration 指定例化 | 不支持 |
| VHDL `clk'event and clk='1'` | 不识别为时钟，按组合逻辑降级处理 |
| 模块索引和端口匹配 | 按小写归并；Verilog 中仅大小写不同的同名定义会被合并 |
| 声明定位与大纲 | 要求声明单行闭合，跨行续写的名称可能无法定位 |

[层级模型](../src/model/hierarchy.ts) 对无定义的例化先匹配已识别的 UNISIM 家族原语，否则保留 unresolved。IP 只提供黑盒和端口信息，不展开生成目录；IP 生成目录内的约束同样排除。ISE 的 `ipcore_dir` 按用户源码扫描，以保留 CoreGen 包装的例化目标。

自动顶层选择的处理顺序：

1. 唯一候选直接采用；多候选时按 `tb_`／`_tb` 等命名和 `sim`／`tb`／`test` 等目录段识别仿真候选。
2. 目录判断先剥离扫描文件的公共路径前缀，避免工程根位于 tests 等父目录下时被误判。
3. 向仿真候选内部解包，取可达子图最大的 DUT，再比较各有效顶层的可达规模；实际顶层不一定在原始候选列表中。用户仍可手动切换。

层级节点的 children getter 首次访问才物化直接子节点。修改消费方遍历时要保留这一边界，避免菱形复用结构沿实例路径组合爆炸。

### 编码边界

编码实现与回归位于 [Rust 后端](../src-tauri/src/main.rs)。BOM 检测、严格 UTF-8 与 GBK 兜底发生在解析前，写入默认保留原编码；UTF-8 BOM 加 GBK 正文的异常文件按 GBK 写回时不保留 BOM。UTF-16 和传统编码也严格校验，损坏编码或 UTF-32 拒绝读取，单文件读取上限为 64 MiB。解析层不负责重新解释字节或改变编码。

### Monaco 与主题

[Monaco 入口](../src/editor/monaco.ts) 使用按需导入，保留编辑器贡献，排除无关语言服务与 LSP。升级版本时核对以下内容：

- 导入清单与目标版本 `editor.main.js` 的编辑器贡献部分对应，不改为 `import "monaco-editor"` 整包入口。
- 列编辑依赖的内部 `CursorColumns` 算法与 [局部类型声明](../src/editor/monaco-internals.d.ts) 一致。
- worker、codicon CSS 的实际路径和导出映射仍有效；新增语言高亮只添加对应 `languages/definitions/<lang>/register`。
- 运行编辑器与列编辑相关回归，并检查构建产物没有新增无关语言包和 worker。

[src/style.css](../src/style.css) 是界面深浅主题令牌的唯一来源，通过 `<html data-theme>` 切换；`public/theme-init.js` 在首帧前初始化主题。[src/ui/theme.ts](../src/ui/theme.ts) 管理偏好，Monaco 经 `setEditorTheme` 联动 `meridian-dark`／`meridian-light`，编辑器语法配色与界面令牌分别维护。

### 品牌图标与桌面截图

界面图标使用 [src/ui/icons.ts](../src/ui/icons.ts) 的 `setIcon`，以 `currentColor` 跟随主题；搜索开关 Aa、词、.* 保留文字。

品牌图标的仓库源文件是 [brand.svg](../src-tauri/icons/brand.svg)。修改后的处理顺序：

1. 将 SVG 以透明背景重新渲染为 16、24、32、48、64、128、256 px 七档 PNG，更新 `src-tauri/icons/png/<size>.png`。
2. 执行 `node scripts/make-icon.mjs`，由这些 PNG 重新封装 `src-tauri/icons/icon.ico`。
3. 更新 `src-tauri/build.rs` 的修改时间，强制构建脚本重新执行，避免 exe 沿用旧图标；然后通过正式入口重建。

```powershell
node scripts/make-icon.mjs
(Get-Item src-tauri/build.rs).LastWriteTime = Get-Date
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Build-Release.ps1
```

桌面冒烟可使用 [Capture-Window.ps1](../scripts/Capture-Window.ps1)，传入 `-ExePath` 和 `.tmp/<task-slug>/` 下的 `-OutPng` 路径；脚本截取窗口后会结束自己启动的进程。截图用于检查窗口渲染，页面是否来自内嵌协议 `http://tauri.localhost` 和具体交互仍需分别验证。
