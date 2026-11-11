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
# 打开 http://localhost:1420/?e2e ，从“打开 → 打开文件夹”或空态按钮进入。
# 停止服务后，可移除当前终端变量：Remove-Item Env:RTL_VIEWER_E2E_ROOT
```

文件访问限制在指定目录内；E2E mock 和文件服务不进入生产构建。单文件选择在当前 mock 中固定返回取消，不能据此验收原生文件选择成功路径。真实工程编辑验收同样只使用隔离副本。

底部布局由 `src/ui/bottom-panels.ts` 管理，信号面板标题在组件创建后挂到共用栏，销毁时归还原面板；隐藏标题时同步转移焦点。顶部入口、底部标签和并列显示统一通过面板激活回调刷新问题／统计，隐藏期间只保留数据，重新显示时才渲染。任意两个底部面板都可按当前与上一面板并列，切换面板延续组合，空间不足退回切换；展开仅隐藏编辑区域，不销毁模型，源码定位先恢复布局再导航。相关回归入口为 `tests/bottom-panels.test.ts`，实际滚动、命中范围与窄窗口布局仍须浏览器检查。

## 外部语法检查

`tools/windows-x64/` 保存随应用发布的 Verilator 5.050、GHDL 6.0.0 及其运行库，`tools/licenses/` 保存对应许可。开发构建直接调用该目录；`scripts/Build-Release.ps1` 通过 `bundled-tools` 特性让 `src-tauri/build.rs` 将运行文件嵌入单 exe，首次检查时按内容修订号释放到应用数据目录，不写入用户源码工程。更新工具后需通过正式入口重建并核对版本，不能用裸 `cargo build` 验收发布行为。

`src-tauri/src/syntax.rs` 管理检查请求、进程、超时与取消。Verilator 使用响应文件传入当前范围内 Verilog／SystemVerilog 编译单元、配置的 include 与宏，以及按 IP／VHDL 端口和参数接口生成的临时黑盒，默认范围为当前顶层可达模块，可切换全部工程；顶层按配置覆盖、手动选择、`autoTop` 顺序确定。`src/app/syntax-stubs.ts` 负责 Verilog／VHDL 黑盒转换，保留输入输出方向和常见位宽，不编译 IP 内部实现；`vhdlStubs` 独立传给 GHDL，避免与 Verilator 的 `stubs` 混用。GHDL 根据 library、package、entity／architecture 定义及 `entity work.xxx`／component 引用进行稳定拓扑排序，循环依赖保持原顺序兜底；先分析 IP 接口声明，再逐文件分析真实源码，Stub 不计入检查文件数，并将所有相关 library 工作目录加入 `-P` 搜索路径。`src/app/syntax-options.ts` 按工程保存宏、include、library 映射和附加参数，路径在传参前解析，参数不经过 shell。Verilator 的 `PINCONNECTEMPTY` 统一降为提示，其他端口规则保持原程度；桌面与 Node 解析均过滤末尾 `Exiting due to … error(s)` 进程摘要，问题面板再次排除该重复项，不将其计入诊断；版本查询超时为 10 秒，Verilator 超时为 120 秒，GHDL 单文件超时为 60 秒；版本查询与实际检查共用取消入口，执行前到达的取消同样有效，切换工程或退出会取消任务。Windows 下版本查询和实际检查统一使用 `CREATE_NO_WINDOW`，不能只隐藏主检查进程而遗漏逐文件 GHDL 或版本查询。

工程载入、顶层／范围切换及配置保存会自动调度外部检查，连续编辑在停顿 2 秒后复查；启动检查不展开问题面板，顶部“问题”只控制面板显示。外部检查通过隔离工作区读取工程内已打开文件的未保存快照，不写回原工程；Verilog include 同时保留原源码目录与快照目录。未打开文件仍读取磁盘。前端统一诊断位于 `src/ipc.ts`，`src/ui/problems.ts` 负责显示筛选、分组折叠、进度条与取消状态，`src/app/problem-markers.ts` 管理 Monaco 标记，`src/app/syntax-report.ts` 生成包含内置与外部诊断的 HTML／CSV。筛选只改变显示，报告始终包含当前顶层或全部工程范围内的全部诊断、实际配置、统计和后端状态。错误、警告和提示统一按文件＋规则分组并默认折叠，依赖缺失、重复定义和 Stub 另标为分析环境；常见 Verilator 规则及 GHDL 缺分号、case 分支不完整、声明缺失、类型不匹配、端口不可赋值和重复声明在组标题与明细显示具体中文原因，标识和规则 ID 保留原文；未识别消息明确标为未分类诊断，原始消息保留在筛选数据和报告中。重名文件只增加最短区分目录。分组按诊断指纹协调更新，未变化组复用 DOM，变化组才更新明细；自动复查保留展开状态、滚动位置和焦点。大组展开只创建当前 500 条明细，滚动到末尾自动继续直到全部结果，不预建整组 DOM，也不使用结果截断提示；自动复查保留已加载数量，按诊断指纹差量复用未变化行，不将大组退回首批或整组重建。文本筛选按 200 ms 去抖，Enter 立即执行。单文件 Monaco 标记最多 500 条，后端最多保留 5000 条诊断；截断前先收集并排序，不能在排序前按到达顺序丢弃晚期错误。内置队列完成后才允许导出，CSV 在诊断表后附加后端、配置、统计和过期状态。

复查开始不会提前清除旧结果的过期标记；新结果接收时根据检查期间是否发生修改更新标记，调用失败保留旧结果并标记过期。导出旧结果时，HTML 显示最近失败原因及历史后端状态说明，CSV 在既有元数据后追加非空 `Failure` 行，诊断列契约不变。空检查范围也必须取消旧请求并推进代际，发布零文件、零诊断结果，迟到的成功或失败都不得回填。入口异步路径的回归见 `tests/syntax-lifecycle.test.ts`。

常规 Rust 测试不启动外部工具。以下命令分别显式运行开发目录和内嵌资源的真实后端检查，均覆盖 Verilog include、VHDL 标准库及诊断返回：

```powershell
pwsh -NoProfile -Command "& './scripts/Invoke-Cargo.ps1' -CargoArgs 'test','--locked','--manifest-path','src-tauri/Cargo.toml','real_backends_check_verilog_and_vhdl','--','--ignored','--nocapture'"
pwsh -NoProfile -Command "& './scripts/Invoke-Cargo.ps1' -CargoArgs 'test','--locked','--manifest-path','src-tauri/Cargo.toml','--features','bundled-tools','embedded_backends_check_verilog_and_vhdl','--','--ignored','--nocapture'"
```

前端回归入口为 `tests/problems.test.ts`、`tests/problem-markers.test.ts`、`tests/syntax-report.test.ts` 和 `tests/bottom-panels.test.ts`。真实工程依赖、桌面原生检查交互仍需另行验收，不能用浏览器 mock 代替外部后端结果。

## 检查事实与后台调度

`src/analysis/facts.ts` 统一生成轻量文件事实：物理行、代码行、纯注释行、行内注释行、空白行、注释比例、行宽／Tab／行尾空白、定义、设计单元作用域、过程、敏感列表、赋值、分支、例化端口连接、声明位宽和检查边界。过程、赋值、`case`、声明、端口与参数保留源码偏移对应的作用域，同一行多个设计单元也不能只靠行号归并。解析器为 Verilog／VHDL 端口和参数保留真实声明行，非 ANSI 端口还会从模块体声明补齐方向和位宽，命名规则不得再回退写死为文件第 1 行。`case` 事实支持单行写法、常量参数与表达式、`begin...end` 和嵌套分支后的标签边界、VHDL `=>` 标签及枚举值，并记录各分支目标、default 和可证明的完整覆盖；条件覆盖按目标拆分普通条件与 `case` 分支，不能只凭 default 判为完整。边沿签名按匹配偏移保存作用域，连续赋值保留 RHS 引用，SystemVerilog `logic` 纳入声明。复位只从条件与敏感列表中的完整标识符识别，不按赋值文本中的名称子串猜测。`instanceReads` 复用 `parseFileDetail` 的端口连接，冗余声明判断同时纳入连接、敏感列表和条件使用，避免 Wrapper 误报。过程范围与轻量赋值扫描统一复用 `src/parser/procedural.ts`，复杂更新值推导由 `src/analysis/process.ts` 负责，不再由每条规则独立猜测；`src/analysis/facts.ts` 不依赖跨层信号流。注释比例按“纯注释行＋行内注释行”除以“代码行＋纯注释行＋行内注释行”计算，混合行同时计入代码和注释；工程总比例分别累加分子与分母，不平均各文件百分比。

`src/app/facts-scheduler.ts` 在工程结构载入后按文件调度，当前文件优先。`src/analysis/facts-worker.ts` 在独立 Worker 中计算内容摘要、文件事实、通用／GJB 规则和去重；前台结果与进度按 250 ms 时间窗合并刷新，队列完成立即刷新，问题面板复用未变化的诊断视图与分组 DOM，Monaco 仅在诊断版本、范围或过期状态变化时重算标记；`src/analysis/project-rules.ts` 在队列完成或单文件刷新结束时合并跨文件例化与参数诊断，冲突定义不猜绑定。过程分析边界生成 `ANALYSIS-BOUNDARY`，Worker 失败生成 `ANALYSIS-FAILED`，不得删除旧结果后冒充无问题；后台队列中的刷新失败必须恢复剩余文件分析。界面运行状态同时使用 `factsScheduler.running`、刷新定时器和队列计数，完成、失败与恢复均触发刷新，不能只靠旧计数允许导出。隐藏面板不重建 DOM，统计孙级节点仅在展开时物化。编辑刷新、取消、切换工程或退出会终止旧 Worker，避免旧任务继续占用资源。统计、诊断和外部检查默认限定当前顶层可达模块，切换顶层或全部工程会同步更新队列和旧结果状态。结果不保存整份源码或语法树，只保留结构事实、诊断与内容摘要。相关回归为 `tests/facts.test.ts` 与 `tests/facts-scheduler.test.ts`，构建需确认独立 `facts-worker` 产物。

编辑防抖由事实调度器统一管理，按文件合并待刷新集合，并在执行时读取最新缓冲区；跨标签及双视图编辑不能相互覆盖待刷新项。全量启动接管待刷新集合，切工程、取消及退出同时清空定时器和运行状态。缓存按完整工程文件集合清理，暂时处于分析范围外的文件仍可保留缓存；已删除或因 IP／网表规则退出工程的文件必须移除事实、诊断、失败和版本记录。外部监视每轮完成缓存与层级更新后合并通知一次，重新调度内置及外部检查；切工程后的旧轮次不得通知新工程。相关回归集中在 `tests/facts-scheduler.test.ts` 和 `tests/watcher.test.ts`。

## 通用规则与统计

`src/analysis/general-rules.ts` 消费共享事实，输出统一 `RuleDiagnostic`。当前实现 Verilog／VHDL 各 7 条风格规则和 9 条可综合性规则，全部随事实队列执行。多驱动按设计单元比较过程与连续赋值中的完整简单标识符，位选和局部对象不按模块级完整信号合并；条件覆盖按赋值目标和互补条件路径判断，不能用其他目标的无条件赋值掩盖缺失路径；`case` 还要求每个分支均给目标赋值，default 只覆盖其自身分支，完整枚举必须有可证明的有限范围。复位只识别定义的条件分支，不把名称搜索当作完整语义证明。

`src/ui/stats.ts` 复用事实及内置／外部诊断生成工程汇总、结构统计与文件明细，合计固定在表头下、明细前，支持当前顶层／全部工程范围、模块拓扑展开、简短文件列表排序、定义行定位和按严重程度或文件进入显示筛选；拓扑引用不变时复用节点 DOM，文件列表按 200 行分批，拓扑保留展开状态，长路径仅在悬停提示中显示；按节点类型与失败诊断区分待分析、分析失败、IP／原语短标记和未解析，黑盒完整说明保留在悬停提示中，失败入口可直接筛选对应文件诊断。`src/ui/problems.ts` 合并诊断并提供程度、来源、文件和文本显示筛选，提示与 Stub 分组折叠，筛选不改变检查集合。`src/app/diagnostic-display.ts` 统一格式化 Verilator／GHDL 消息，问题面板与 Monaco 共用；位宽类消息按实际句式转换期望位宽、实际位宽、操作数角色、拼接／复制未定宽和未使用位范围，不再机械截取 `VARREF` 片段；保留端口、信号和规则 ID，未知消息提供悬停原文，面板失败摘要默认中文并保留原始错误悬停。文本筛选同时查询中文和原始消息，报告仍输出原始诊断。对应回归为 `tests/general-rules.test.ts`、`tests/stats.test.ts`、`tests/problems.test.ts`、`tests/diagnostic-display.test.ts`、`tests/problem-markers.test.ts` 和 `tests/bottom-panels.test.ts`。

`src/analysis/gjb-catalog.ts` 收录 GJB 10157 全部 110 条与 GJB 9765 全部 81 条作为规则依据；`src/analysis/gjb-rules.ts` 当前分别自动检查 87 和 56 条，按语言全部执行。字面量只检查非法数字或可能截断，反馈区分 Verilog 大小写和真实位选，函数区分局部与全局赋值且递归只检查实现体，状态机规则先要求时序 `case` 证据；异步复位边沿不计入时钟集合，行波时钟只在来源由时序过程驱动时报警。VHDL 并发语句不按文本行号判断先后，只有过程局部变量检查首次赋值前使用。`src/analysis/width.ts` 只对简单信号、位选／切片、拼接和定宽字面量提供确定宽度，未知类型和表达式不报警；跨文件例化与同名参数由 `src/analysis/project-rules.ts` 检查。需要顶层约束、完整类型推导、完整 CDC、器件资源或人工设计判断的条款不自动判定，未实现条款不显示为人工任务，也不计算合规率。`src/analysis/rule-preferences.ts` 使用固定全量配置和空格 Tab 约定合并通用与 GJB 重复问题，行宽去重不受各规则定位列不同的影响，不再提供规则执行配置。相关回归为 `tests/gjb-rules.test.ts`、`tests/rule-regressions.test.ts`、`tests/project-rules.test.ts` 和 `tests/rule-preferences.test.ts`。

## CLI

`vite.cli.config.ts` 将 `scripts/rtl-lint.ts` 构建为 `dist-cli/rtl-lint.mjs`，`npm run build:cli` 可单独执行。正式 `scripts/Build-Release.ps1` 同时复制 `release/rtl-lint.mjs` 和 `release/tools/windows-x64`，CLI 优先从自身目录定位工具，也可用 `RTL_VIEWER_TOOLS` 覆盖。

`src/app/node-syntax.ts` 在 Node 进程直接调用相同版本的 Verilator／GHDL，`src/app/syntax-order.ts` 统一 Verilog package 与 VHDL entity／architecture 等依赖排序，`src/app/node-source.ts` 按 BOM、严格 UTF-8、GBK 兜底读取磁盘源码；内部快照接口仅接受 UTF-8、UTF-8 BOM、UTF-16 LE／BE，其他编码显式拒绝。CLI 与桌面共用 `src/analysis/facts.ts`、通用／GJB／项目级规则、诊断去重及 `src/app/syntax-report.ts`，默认执行全部自动规则；未显式传入路径时扫描 `--root`，显式路径仍按命令行目标处理；相对 include 和 library 在 `scripts/rtl-lint.ts` 生成后端参数时按 `--root` 解析，绝对路径保持不变。后端无法启动或完成时返回系统 Error 和 `failed`，不增加已检查文件数。全工程 GJB 诊断逐项追加，不能用一次扩展推入突破调用栈上限；文件名规则同时接受 Windows 与 POSIX 路径。`--no-external` 可只运行内置规则，退出码 1 表示 Error，2 表示参数、读取或导出失败。`tests/node-syntax.test.ts` 覆盖未保存快照、package／entity／architecture 顺序与启动失败，`tests/cli-contract.test.ts` 覆盖目录过滤、默认 root 和解码，真实 CLI 样例同时验证 IP 排除和 HTML／CSV。

## 架构与目录

```text
src/         前端：analysis/（按需运算语义与单模块逻辑）、parser/（HDL 解析）、model/（索引、层级树、搜索、导航历史、大纲、信号声明定位）、app/（编辑工作区、工程扫描、外部变更监视、信号链与模块元数据）、editor/（Monaco、标签页、代码补全）、ui/（树、搜索面板、大纲、状态栏、对话框、右键菜单、最近工程）
src-tauri/   本机 Rust 桌面后端：源码在 src/，负责文件扫描、编码读写、系统调用与外部检查进程；另含桌面配置和图标
tools/       随应用发布的 Verilator／GHDL Windows 运行环境及第三方许可
docs/        使用指南、开发指南与 assets/ 界面素材
tests/       Vitest 测试；samples/ 为可提交样例，fixtures/ 为不入 Git 的私有验收副本；私有套件通过环境变量显式启用
scripts/     构建辅助（Build-Release.ps1、Invoke-Cargo.ps1、make-icon.mjs、Capture-Window.ps1 exe 窗口冒烟截图）
release/     便携 exe、CLI 与检查工具交付物（Build-Release.ps1 生成，不入 Git）
```

`src/` 与 `src-tauri/` 属于同一个桌面应用，通过 `src/ipc.ts` 通信；HDL 解析和信号分析在前端执行，磁盘访问与编码读写在本机 Rust 后端执行。

[交互评审原型](interaction-review.html) 保留界面方案对比及评审依据，供设计参考；软件当前行为以[使用指南](usage.md)为准。

[图标评审预览](icon-review.html) 保留透明线构图标的设计对照，默认选中已采用的紧凑交织及功能图标。页面包含参考截图、桌面场景、透明棋盘格、深浅底色和实际尺寸；旧版图标仅供对照。正式应用资源以 `src-tauri/icons/` 与 `src/ui/icons.ts` 为准。

信号链保持两类边界：端口由 `src/analysis/signal-flow.ts` 跨层追到赋值位置，`src/ui/signal-ports.ts` 按模块折叠显示有界终点，少量连接默认展开，大量连接先显示摘要；内部信号由 `src/analysis/local.ts` 在当前模块内分析，子模块端口通过 `loadPortSites` 附带有界的第一层源码预览（`stopAtAssignments` + `descendOnly`），沿纯端口转接向下查找到第一处实际赋值／使用，保留预算和递归例化截止，不向父模块回溯，不合并子模块依赖图。入口分类与快照由 `src/app/signal-controller.ts` 管理；依赖图、端口终点和上下游追踪由 `src/analysis/signal-trace.ts` 在独立 Worker 中计算，切换目标、刷新或换工程会终止旧 Worker，两个视图均在原链路显示终点源码，不强制切换到模块内模式。对应回归见 `tests/signal-analysis.test.ts`、`tests/signal-endpoints.test.ts`、`tests/signal-flow-ui.test.ts`、`tests/signal-trace-task.test.ts` 和 `tests/signal-controller.test.ts`，构建需确认独立 `signal-trace-worker` 产物。

端口视图只改变既有追踪图的显示，不重新推导连接。`TraceNode.module` 可选元数据保留已知模块名和参数覆盖原文；同父实例下至少 3 个同模块、同端口、同方向实例可创建显示分组，未提供元数据时不猜组。收起分支不创建终点源码 DOM，隐藏节点释放行列空间；多端口汇合继续共享实际赋值节点。只看以实例身份覆盖同侧所有相关端口，保存首次进入前的展开、赋值块、筛选、选择和滚动快照，同级切换不覆盖快照；取消只看恢复快照，刷新仍只继承宽度。展开后按新可见节点计算最小滚动并尊重减少动态效果偏好，收起、恢复和销毁取消待执行的跟随。图标通过 `setIcon(..., "only-module")` 注册，与其他行内动作一同在悬停／聚焦时显示。回归入口为 `tests/signal-port-folding.test.ts`，实际跟随、命中范围和窄窗口布局须另做浏览器检查。

卡片宽度与连线计算共用 `src/ui/signal-canvas.ts`：无手动覆盖的卡片按内容 max-content 自适应，夹在 236–560 px；手动拖宽（上限 1200 px）覆盖自适应，随当前追踪的视图状态保存，双击或 Home 恢复自适应。列位置按同列最大宽度累加，保留 40 px 列间距；连线和画布使用实际卡片宽度。两种视图以及懒创建的分支卡片均接入边缘拖动，销毁时释放指针捕获。控制器仅在文件、信号、实例与过程作用域相同的刷新中沿用宽度，不沿用旧分析的分支展开状态。回归入口为 `tests/signal-card-width.test.ts` 和 `tests/signal-controller.test.ts`；jsdom 无布局，自适应测量在测试中 mock `offsetWidth`，拖动命中、代码换行与滚动位置仍需浏览器／桌面实际交互检查。

| 生成目录 | 用途 |
|---|---|
| `dist/` | Vite 前端构建资源，打包时嵌入 exe |
| `src-tauri/target/` | Cargo 编译输出与增量缓存，清理后下次编译需重建 |
| `src-tauri/gen/` | Tauri 生成的配置 schema |
| `release/` | 正式便携交付物：应用使用 `rtl-viewer.exe`，命令行使用 `rtl-lint.mjs` 及同目录工具 |
| `.tmp/<task-slug>/` | 临时夹具、截图、日志与页面快照 |

上述生成目录不入 Git。`tests/fixtures/` 是真实工程验收副本，属于测试输入，不能作为普通构建缓存清理。

## 独立分析样例

[信号运算过程样例](../examples/computation/README.md) 复用源码分析层，生成可离线打开的交互页面；这是独立阅读实验，使用方法与分析范围见样例说明。

## 维护要点

### 解析与层级

解析入口在 [src/parser/](../src/parser/)，采用文本级扫描。`scanStructure` 提取定义名与例化边，`parseFile` 按需补端口，`parseFileDetail` 按需补端口连接；扩展语法前先补失败测试，不在打开工程时全量解析。冷扫描通过 `src/app/structure-scanner.ts` 将逐文件 `scanStructure` 放入独立可终止 Worker，读取、解析结果仍按工程代际提交，完成、取消和切换工程均释放 Worker；对应回归为 `tests/project-scanner.test.ts` 与 `tests/structure-scanner.test.ts`，构建需确认独立 `structure-worker` 产物。

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
| 模块索引和端口匹配 | 索引仍按小写归并；Verilog 中仅大小写不同的定义视为冲突，不猜测选择 |
| 声明定位与大纲 | 要求声明单行闭合，跨行续写的名称可能无法定位 |

[层级模型](../src/model/hierarchy.ts) 对无定义的例化先匹配已识别的 UNISIM 家族原语，否则保留 unresolved。IP 只提供黑盒和端口信息，不展开生成目录；IP 生成目录内的约束同样排除。ISE 的 `ipcore_dir` 按用户源码扫描，以保留 CoreGen 包装的例化目标。

冷扫描与目录增量检查共用 `src/app/project-files.ts` 的 IP 目录及明确网表筛选；文件名规则在读取前应用，导出命令头只检查前 16 KiB 的设计单元前缀，不按原语数量推断。新增 XCI 或已索引文件变成明确网表时退出索引，已打开的编辑缓冲区保留；增量检查按 mtime 记忆被排除的文件头，版本变化后重新判定，换工程时清空。回归见 `tests/project-scanner.test.ts`、`tests/watcher.test.ts`。

VHDL 结构元数据显式保留 entity 和 architecture 身份。`src/model/index.ts` 的 `bindModuleParts` 由索引、层级和信号模型共同使用：唯一 entity 提供定义与端口，唯一 architecture 提供例化；重复定义或多个实现保留冲突边界。用户通过可点击冲突徽章或右键明确选择后，节点保留可点击的“多定义”标识以便改选；`selectModuleParts` 只使用指定实现，选择按工程保存到 `rtl-viewer.definitionPreferences.<工程路径>`，层级、导航、统计与外部检查文件范围同步，不按日期或路径猜选。`src/app/definition-choices.ts` 在打开候选菜单时读取当前缓冲区或扫描缓存，以例化命名端口／参数收窄候选；唯一完整匹配且其他候选均可排除时才推荐，位置连接、多个匹配或未知接口不推荐；候选菜单分别提供定义行预览和绑定操作，预览不改变选择，绑定始终由用户确认。层级的被例化集合只来自有效绑定，冲突实现不能影响其他模块的顶层判断；详细信号解析仍保持按需。回归见 `tests/hierarchy.test.ts`、`tests/ui-tree.test.ts`、`tests/definition-choices.test.ts`、`tests/module-metadata.test.ts`、`tests/signal-flow.test.ts`。

Rust 扫描结果可携带 `issues`，目录读取失败和深度上限都显式报告。前端扫描合并逐文件读取／解析错误，通过完成回调交给界面显示部分载入摘要，不中断其他文件；旧请求的错误与结果同样受代际检查约束。

自动顶层选择的处理顺序：

1. 唯一候选直接采用；多候选时按 `tb_`／`_tb` 等命名和 `sim`／`tb`／`test` 等目录段识别仿真候选。
2. 目录判断先剥离扫描文件的公共路径前缀，避免工程根位于 tests 等父目录下时被误判。
3. 向仿真候选内部解包，取可达子图最大的 DUT，再比较各有效顶层的可达规模；实际顶层不一定在原始候选列表中。用户仍可手动切换。

层级节点的 children getter 首次访问才物化直接子节点。修改消费方遍历时要保留这一边界，避免菱形复用结构沿实例路径组合爆炸。

信号分析通过 `SignalProject.moduleForContext` 按实例惰性应用参数和静态 generate；结构索引仍保持轻量。`src/parser/static-generate.ts` 只求解有界整数常量子集，源视图逐字符映射回原偏移；未知或超预算区域保留独立边界。修改此处必须覆盖不同参数实例、嵌套 generate、未知条件、范围溢出和无关模块不触发详细解析。

参数声明保留类型，支持的标量／单维整数参数先按位宽与符号转换再参与静态选择；未知类型、多维 packed 参数和不能确定的宽度传播保留边界。子实例的参数覆盖使用所属生成块的常量环境。`signalCandidates` 在实际实例上下文返回源码对象候选，生成过程局部对象还须携带过程 `scope`，不能仅按原始名称或源码偏移选定。组合回归见 `tests/static-parameter-followup.test.ts`。

`src/analysis/objects.ts` 收集类型、声明和初始化事实；`ProcessResult.updates` 仅保存可靠更新表达式，`assignments` 保存逐语句源码关系。同一目标已有可靠更新时不重复绘制逐语句驱动。初值不计持续驱动，地址与条件不计数据输入，未知调用参数不绘制确定方向。新增语法必须同时检查这两种表示、过程局部身份及原始源码定位。

过程表达式检查按共享节点记忆结果，同时按展开后最多 4096 个节点、128 层限制更新值，避免替换 DAG 在后续源码映射、格式化或绘图时指数展开。超预算仅降级受影响的更新，保留逐语句关系和独立赋值；降级过程中的内部更新引用保留不确定边界。刷新定位限定原模块，丢失或歧义目标要求重新选择。回归见 `tests/process-relations.test.ts`、`tests/signal-controller.test.ts`、`tests/signals.test.ts`。

### 搜索与文件一致性

`src/ui/bottom-panels.ts` 统一管理搜索与信号链的可见性、共存偏好和总高度，不销毁两块视图。默认切换；可用空间不足以同时保留编辑区和两块面板时临时退回切换，恢复高度后继续共存。隐藏搜索通过主入口取消未完成的 Worker，完成结果与输入仍保留；分隔条支持指针、方向键和 Home，销毁时释放观察器与拖动监听。回归见 `tests/bottom-panels.test.ts`；浏览器另检查窗口缩放、双视图和实际源码可见高度。

“查找同名文本”沿用 `rtl.find-references` 动作 ID 和 `Shift+F12`，仅修改用户可见名称，仍使用字面整词搜索；匹配方式和扫描范围在结果面板中显式展示。`PathBreadcrumb` 接收当前工程根，以 Windows 路径身份显示工程相对路径，完整路径操作仍使用原始目标，工程外文件单独标记。回归见 `tests/search-ui.test.ts` 和 `tests/breadcrumb.test.ts`。

`src/app/project-search.ts` 管理单次查询 Worker，`src/model/search-worker.ts` 执行匹配与高亮；`src/ui/search.ts` 仅渲染返回区间，不在主线程执行用户正则，每个文件按 100 行一批创建结果与高亮。查询替换、面板收起、超时和异常均终止 Worker；界面按请求序号丢弃旧结果。单次预算 2 秒，最多 500 行，每行预览 2000 字符、200 处高亮。回归入口为 `tests/project-search.test.ts`、`tests/search-ui.test.ts` 和 `tests/search-history.test.ts`。

`src/file-path.ts` 统一 Windows 路径身份，标签、共享模型、索引查找与保存队列使用相同规则，展示保留原路径。保存按目标文件和共享模型串行，模型迁移属于保存操作；关闭等待保存完成，失败保留标签。watcher 回填前检查缓存基准和保存状态，显式重载另检查模型版本与保存修订，模块元数据缓存同时检查模型身份和版本。回归入口为 `tests/tabs.test.ts`、`tests/watcher.test.ts`、`tests/definition-models.test.ts` 和 `tests/module-metadata.test.ts`。

`TabManager.openContent` 返回 Promise，目标正在写入时等待保存队列并重新读取；工作区必须等待它完成后再定位，关闭代际使等待中的打开失效。排队的另存为在实际写入前再次核对目标占用，写入成功后始终迁移到目标路径，期间的新编辑只保留脏标记。编码选择是待保存的文档状态，影响脏标记和重载修订；写入后的清洁状态同时比较模型版本与编码，不能清除保存期间发生的新修改。

### 编码边界

编码实现与回归位于 [Rust 后端](../src-tauri/src/main.rs)。BOM 检测、严格 UTF-8 与 GBK 兜底发生在解析前，写入默认保留原编码；UTF-8 BOM 加 GBK 正文的异常文件按 GBK 写回时不保留 BOM。UTF-16 和传统编码也严格校验，损坏编码或 UTF-32 拒绝读取，单文件读取上限为 64 MiB。解析层不负责重新解释字节或改变编码。

### 双视图与标签生命周期

批量关闭、切换工程及退出在保存完成后重新检查全部待关闭缓冲区，包括确认时尚未修改的文件；保存期间出现新的未保存修改时停止整个关闭，不先关闭部分标签。共享模型仍有保留视图时允许关闭当前视图，判断使用保存后的实际标签归属。回归见 `tests/tabs.test.ts`。

双视图由 `src/app/editor-workspace.ts` 协调标签归属、独立导航、活动视图和同步滚动；`src/editor/tabs.ts` 负责标签重排与共享模型的移动／克隆，移动先取得目标引用再释放原引用，不经关闭确认或磁盘重读，等待正在进行的保存结束，失败则保留原侧。`src/ui/editor-layout.ts` 只处理排列、可见性与分隔条，`src/ui/tab-drag.ts` 只处理指针手势与落点反馈，最终调用工作区同一组操作。同步滚动跳过文档切换及标签迁移中的位置恢复，避免覆盖另一侧阅读位置。回归入口为 `tests/editor-workspace.test.ts` 和 `tests/tabs.test.ts`；拖动命中、Monaco 撤销与真实布局另在浏览器或桌面验证。

修改双视图行为时，除自动回归外，按 [使用指南](usage.md#双视图与标签拖动) 检查标签拖出菜单、跨侧移动与拖回合并、共享编辑与撤销、上下排列与位置交换、横纵独立同步滚动，以及收起／恢复后阅读位置和未保存内容。桌面验收还需核对真实拖动手势与不同 DPI；浏览器预览不代替这些检查。

### Monaco 与主题

[Monaco 入口](../src/editor/monaco.ts) 使用按需导入，保留编辑器贡献，排除无关语言服务与 LSP；`vite.config.ts` 将 `node_modules/monaco-editor` 独立为 `monaco` chunk，与业务入口分开缓存。升级版本时核对以下内容：

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

补全与悬浮提示通过 `createEditor` 的 `fixedOverflowWidgets: true` 使用 Monaco 自带的视口定位，两个分屏共用此配置。路径菜单限制宽高到视口内，长路径换行、过长列表滚动，窗口缩小时重新定位；键盘首尾与方向键沿用 `activateMenu` 的焦点导航。应用提示框保留默认按钮、Tab 按钮循环与关闭后焦点恢复，使用 `role="dialog"`、`aria-modal` 和消息标题关联，弹窗期间隔离 `#app` 背景并支持堆叠；长消息保留换行并独立滚动，按钮组不随消息滚出。侧栏和大纲分隔条与底部、双视图分隔条一样支持方向键和 Home。修改这些浮层或分隔条后，在窄窗口检查左右分屏补全及底部候选、菜单首尾项命中与滚动、长文件名／多行错误消息及确认按钮可达；DOM 测试不替代实际窗口布局验收。

### 品牌图标与桌面截图

界面图标使用 [src/ui/icons.ts](../src/ui/icons.ts) 的 `setIcon`，保持 16 px 栅格、1.5 px 描边和圆角收口，以 `currentColor` 跟随主题；搜索开关 Aa、词、.* 保留文字。检查、取消、配置、导出、筛选、严重程度、统计与排序共用同一图标集，不新增独立 SVG、emoji 或另一套填充图标；对应回归为 `tests/icons.test.ts`。

工具栏、面板和行内按钮分别采用 30、28、26 px 高度，次要操作复用 `.btn-ghost`。`src/ui/toolbar-overflow.ts` 按实际宽度把问题、统计、信号链和搜索依次收进“更多”菜单，侧栏折叠状态与宽度由 `src/ui/sidebar-width.ts` 保存，760 px 以下首次运行默认收起。诊断分组保持扁平，宽屏单行显示，1100 px 以下筛选默认折叠且诊断消息改为两行，640 px 以下配置表单改为单列。后端完整版本只放在悬停提示与报告中，界面保留名称、短版本和状态。`--fg-muted` 用于需要阅读的辅助文字，`--fg-faint` 只用于装饰图标和禁用态；问题按钮徽章在面板隐藏时也须更新。调整这些样式后需实际检查深浅主题和窄窗口。

品牌采用透明背景的紧凑交织符号：[brand.svg](../src-tauri/icons/brand.svg) 为常规白色线构，[brand-small.svg](../src-tauri/icons/brand-small.svg) 为 16–24 px 光学校正版，线宽由 9 增至 12，构形微放大 8%。标题栏使用小尺寸源，浅色主题通过 CSS 转黑。Windows 文件图标使用白色线条加深色外轮廓，浅色任务栏变体使用深色线条加白色轮廓，两者均保留透明背景；程序运行时按 Windows 的 `SystemUsesLightTheme` 选择原生窗口和任务栏图标，独立于应用页面主题，系统颜色或窗口 DPI 变化后更新，读取失败时使用兼容深浅背景的文件图标。不修改用户的主题设置。修改后的处理顺序：

1. 执行 `node scripts/make-icon.mjs`，从两份 SVG 源派生双色轮廓，使用项目已有 Tauri CLI 渲染 16、24、32、48、64、128、256 px 七档 PNG，再封装默认与浅色任务栏 ICO；16、24 px 使用 `brand-small.svg`，其余使用 `brand.svg`。检查深浅背景下实际像素尺寸的线条和 Alpha，不能添加背景色。
2. `src-tauri/build.rs` 跟踪两份 ICO 并将其内嵌到 exe，图标变更后通过正式入口重建，不依赖手动更新时间戳。`src-tauri/src/taskbar_icon.rs` 在窗口线程安装系统消息监听，显式更新大小图标；原生图标句柄在替换和窗口销毁时释放。
3. 验收 exe 内嵌资源及独立复制运行后的图标，分别核对深浅任务栏选择、运行中系统通知和 DPI 更新；页面 CSS 图标不代替 Windows 原生图标验收。

README 横幅的品牌符号位于 `docs/assets/banner.svg`，品牌构形变化时同步该符号并按原尺寸重新渲染 `banner@2x.png`；字体回退、文字间距和完整布局需要实际查看。

```powershell
node scripts/make-icon.mjs
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Build-Release.ps1
```

桌面冒烟可使用 [Capture-Window.ps1](../scripts/Capture-Window.ps1)，传入 `-ExePath` 和 `.tmp/<task-slug>/` 下的 `-OutPng` 路径；脚本截取窗口后会结束自己启动的进程。截图用于检查窗口渲染，页面是否来自内嵌协议 `http://tauri.localhost` 和具体交互仍需分别验证。
