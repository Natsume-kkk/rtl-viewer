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

`tests/samples/analysis/` 覆盖位赋值、静态 generate 实例、ROM 声明初值、动态地址、类型转换及同模块不同参数实例；对应整合回归为 `tests/analysis-coverage.test.ts`。过程、对象表达式和展开的边界回归分别在 `tests/process-relations.test.ts`、`tests/source-objects.test.ts` 和 `tests/static-generate.test.ts`。

`generated_locals.sv` 用于核对同一生成块局部信号的多个展开身份；入口选择与刷新由 `tests/signal-controller.test.ts` 覆盖。`tests/expression-access-combinations.test.ts` 检查转换嵌套后的地址／条件角色、record 字段与数组／subtype 的组合访问，防止将地址误报为驱动目标。

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

信号链保持两类边界：端口由 `src/model/signal-flow.ts` 跨层追到赋值位置，`src/ui/signal-ports.ts` 直接显示已可见端口的赋值终点；内部信号由 `src/analysis/local.ts` 在当前模块内分析，子模块端口通过 `loadPortSites` 附带有界的第一层源码预览（`stopAtAssignments` + `descendOnly`），沿纯端口转接向下查找到第一处实际赋值／使用，保留预算和递归例化截止，不向父模块回溯，不合并子模块依赖图。入口分类、快照与取消由 `src/app/signal-controller.ts` 管理，两个视图均在原链路显示终点源码，不强制切换到模块内模式；对应回归见 `tests/signal-analysis.test.ts`、`tests/signal-endpoints.test.ts`、`tests/signal-flow-ui.test.ts` 和 `tests/signal-controller.test.ts`。

卡片宽度与连线计算共用 `src/ui/signal-canvas.ts`：无手动覆盖的卡片按内容 max-content 自适应，夹在 236–560 px；手动拖宽（上限 1200 px）覆盖自适应，随当前追踪的视图状态保存，双击或 Home 恢复自适应。列位置按同列最大宽度累加，保留 40 px 列间距；连线和画布使用实际卡片宽度。两种视图以及懒创建的分支卡片均接入边缘拖动，销毁时释放指针捕获。控制器仅在文件、信号、实例与过程作用域相同的刷新中沿用宽度，不沿用旧分析的分支展开状态。回归入口为 `tests/signal-card-width.test.ts` 和 `tests/signal-controller.test.ts`；jsdom 无布局，自适应测量在测试中 mock `offsetWidth`，拖动命中、代码换行与滚动位置仍需浏览器／桌面实际交互检查。

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
| Verilog 块局部变量 | 过程赋值池使用声明位置区分词法身份，不与块外同名模块信号合并；不执行完整 SystemVerilog 名称绑定 |
| Verilog 无端口例化 `foo u;` | 不支持 |
| VHDL 端口省略 mode | 不按语言默认的 `in` 补全，该端口被丢弃 |
| VHDL 裸名无 map 例化 `u1: foo;` | 为避免误匹配 signal／constant 声明，不支持；与 entity／component 形式区分 |
| VHDL configuration 指定例化 | 不支持 |
| VHDL `clk'event and clk='1'` | 不识别为时钟，按组合逻辑降级处理 |
| 模块索引和端口匹配 | 按小写归并；Verilog 中仅大小写不同的同名定义会被合并 |
| 声明定位与大纲 | 要求声明单行闭合，跨行续写的名称可能无法定位 |

[层级模型](../src/model/hierarchy.ts) 对无定义的例化先匹配已识别的 UNISIM 家族原语，否则保留 unresolved。IP 只提供黑盒和端口信息，不展开生成目录；IP 生成目录内的约束同样排除。ISE 的 `ipcore_dir` 按用户源码扫描，以保留 CoreGen 包装的例化目标。

冷扫描与目录增量检查共用 `src/app/project-files.ts` 的 IP 目录筛选；新出现的 XCI 会使该目录此前收录的生成 HDL／约束退出索引，已打开的编辑缓冲区保留。VHDL entity 与 architecture 分文件时，定义跳转保留 entity 文件，例化点使用实际 architecture 文件。

自动顶层选择的处理顺序：

1. 唯一候选直接采用；多候选时按 `tb_`／`_tb` 等命名和 `sim`／`tb`／`test` 等目录段识别仿真候选。
2. 目录判断先剥离扫描文件的公共路径前缀，避免工程根位于 tests 等父目录下时被误判。
3. 向仿真候选内部解包，取可达子图最大的 DUT，再比较各有效顶层的可达规模；实际顶层不一定在原始候选列表中。用户仍可手动切换。

层级节点的 children getter 首次访问才物化直接子节点。修改消费方遍历时要保留这一边界，避免菱形复用结构沿实例路径组合爆炸。

信号分析通过 `SignalProject.moduleForContext` 按实例惰性应用参数和静态 generate；结构索引仍保持轻量。`src/parser/static-generate.ts` 只求解有界整数常量子集，源视图逐字符映射回原偏移；未知或超预算区域保留独立边界。修改此处必须覆盖不同参数实例、嵌套 generate、未知条件、范围溢出和无关模块不触发详细解析。

参数声明保留类型，支持的标量／单维整数参数先按位宽与符号转换再参与静态选择；未知类型、多维 packed 参数和不能确定的宽度传播保留边界。子实例的参数覆盖使用所属生成块的常量环境。`signalCandidates` 在实际实例上下文返回源码对象候选，生成过程局部对象还须携带过程 `scope`，不能仅按原始名称或源码偏移选定。组合回归见 `tests/static-parameter-followup.test.ts`。

`src/analysis/objects.ts` 收集类型、声明和初始化事实；`ProcessResult.updates` 仅保存可靠更新表达式，`assignments` 保存逐语句源码关系。同一目标已有可靠更新时不重复绘制逐语句驱动。初值不计持续驱动，地址与条件不计数据输入，未知调用参数不绘制确定方向。新增语法必须同时检查这两种表示、过程局部身份及原始源码定位。

### 搜索与文件一致性

`src/app/project-search.ts` 管理单次查询 Worker，`src/model/search-worker.ts` 执行匹配与高亮；`src/ui/search.ts` 仅渲染返回区间，不在主线程执行用户正则。查询替换、面板收起、超时和异常均终止 Worker；界面按请求序号丢弃旧结果。单次预算 2 秒，最多 500 行，每行预览 2000 字符、200 处高亮。回归入口为 `tests/project-search.test.ts`、`tests/search-ui.test.ts` 和 `tests/search-history.test.ts`。

`src/file-path.ts` 统一 Windows 路径身份，标签、共享模型、索引查找与保存队列使用相同规则，展示保留原路径。保存按目标文件和共享模型串行，模型迁移属于保存操作；关闭等待保存完成，失败保留标签。watcher 回填前检查缓存基准和保存状态，显式重载另检查模型版本与保存修订，模块元数据缓存同时检查模型身份和版本。回归入口为 `tests/tabs.test.ts`、`tests/watcher.test.ts`、`tests/definition-models.test.ts` 和 `tests/module-metadata.test.ts`。

### 编码边界

编码实现与回归位于 [Rust 后端](../src-tauri/src/main.rs)。BOM 检测、严格 UTF-8 与 GBK 兜底发生在解析前，写入默认保留原编码；UTF-8 BOM 加 GBK 正文的异常文件按 GBK 写回时不保留 BOM。UTF-16 和传统编码也严格校验，损坏编码或 UTF-32 拒绝读取，单文件读取上限为 64 MiB。解析层不负责重新解释字节或改变编码。

### Monaco 与主题

[Monaco 入口](../src/editor/monaco.ts) 使用按需导入，保留编辑器贡献，排除无关语言服务与 LSP。升级版本时核对以下内容：

- 导入清单与目标版本 `editor.main.js` 的编辑器贡献部分对应，不改为 `import "monaco-editor"` 整包入口。
- `monaco-editor/nls/lang/zh-cn` 必须先于编辑器及贡献模块加载，菜单和命令标签在模块初始化时生成；沿用同版本自带语言包，不另装中文化插件。升级后检查右键菜单、查找替换、命令面板及双视图的中文显示。
- 列编辑依赖的内部 `CursorColumns` 算法与 [局部类型声明](../src/editor/monaco-internals.d.ts) 一致。
- 定义预览复用 `InMemoryTextModelService`，通过 `StandaloneServices.initialize` 接入按需模型租用，必须早于主题等首次服务初始化。升级时核对服务标识、引用释放及合成文档接口；相关回归见 `tests/definition-models.test.ts`。模型由 `src/editor/model-store.ts` 统一管理标签与预览引用，不全量预建工程模型，也不覆盖已有标签的未保存内容。
- worker、codicon CSS 的实际路径和导出映射仍有效；新增语言高亮只添加对应 `languages/definitions/<lang>/register`。
- 运行编辑器与列编辑相关回归，并检查构建产物没有新增无关语言包和 worker。

[src/style.css](../src/style.css) 是界面深浅主题令牌的唯一来源，通过 `<html data-theme>` 切换；`public/theme-init.js` 在首帧前初始化主题。[src/ui/theme.ts](../src/ui/theme.ts) 管理偏好，Monaco 经 `setEditorTheme` 联动 `meridian-dark`／`meridian-light`，编辑器语法配色与界面令牌分别维护。

应用动作统一通过 `src/editor/actions.ts` 注册：全局注册保留菜单和键位，每个编辑器通过 `addAction` 补命令面板入口，不重复绑定快捷键。`editorTextFocus` 放在键位条件中，不能用作面板动作的前置条件；只读保护仍保留。安装必须在 standalone 编辑器构造完成后进行；升级时核对中文搜索、左右视图执行目标及菜单数量。约束文件按普通可编辑文本处理，使用 Tcl 高亮，不施加只读限制。

字体同样由 `src/style.css` 统一定义：`--font-ui` 用于菜单、按钮和说明，`--font-mono` 用于源码、模块名、路径和信号卡片，均提供微软雅黑中文回退。常规界面为 12 px，辅助文字为 11 px，源码初始字号为 14 px；窄窗口调整空间与省略方式，不缩小字体。`createEditor` 从 CSS 读取等宽字体与源码字号，保留编辑器手动缩放；`useShadowDOM: false` 使右键菜单采用应用字体规则。

右键菜单在 `src/style.css` 中限定为视口固定定位，覆盖 Monaco 的行内绝对定位，避免被编辑区／分屏的 `overflow: hidden` 裁剪；不放开编辑区自身的溢出约束。Monaco 0.57 定位前实测零坐标原点，继续由其处理边缘翻转、子菜单及超高菜单滚动。菜单颜色变量局部映射到应用主题令牌，不影响源码配色。升级 Monaco 后检查定位算法是否仍支持该覆盖，并实际验证上下左右边缘、菜单高于窗口、深浅主题和双视图；除检查边界矩形，还需用命中测试确认首尾项可点击。字体检查覆盖菜单、查找替换和命令输入框，不能只核对 CSS 定义。

补全与悬浮提示通过 `createEditor` 的 `fixedOverflowWidgets: true` 使用 Monaco 自带的视口定位，两个分屏共用此配置。路径菜单限制宽高到视口内，长路径换行、过长列表滚动，窗口缩小时重新定位；键盘首尾与方向键沿用 `activateMenu` 的焦点导航。应用提示框保留默认按钮、Tab 按钮循环与关闭后焦点恢复，长消息保留换行并独立滚动，按钮组不随消息滚出。修改这些浮层后，在窄窗口检查左右分屏补全及底部候选、菜单首尾项命中与滚动、长文件名／多行错误消息及确认按钮可达；DOM 测试不替代实际窗口布局验收。

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
