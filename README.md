# Workflow Agent

本地优先的通用工作流 Agent —— Electron 桌面应用（第一阶段 MVP）。

用户给出目标，Agent 在**用户明确选择的本地工作区**内自主规划、调用工具、执行多步骤操作、
检查结果，失败后分析修复，最终由程序化验收（Verifier）判定任务状态 —— 不以模型自述为成功依据。

## 技术栈

- 语言/运行时：TypeScript 5.9 + Node.js ≥ 22.13（使用内置 `node:sqlite`，无原生模块编译）
- 桌面：Electron 37（contextIsolation + sandbox 开启，渲染进程无 Node/Shell 能力）
- 前端：React 18 + Vite 6 + Tailwind CSS 4
- 校验：Zod（工具参数、IPC 输入、设置文件三处强制校验）
- 持久化：SQLite（任务/事件/工具调用/待审批/文件变更备份/对话 transcript）
- 测试：Vitest（单元 + 集成 + 安全，共 91 个用例）

## 快速开始

```bash
# 要求 Node.js >= 22.13（推荐 22.13+ 或 24+），包管理器 pnpm
pnpm install

# 中国网络环境下若 Electron 二进制下载失败，使用镜像安装：
# ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm install

pnpm build      # 类型检查 + 编译主进程 + 构建渲染层
pnpm start      # 启动桌面应用（加载 dist）
pnpm dev        # 构建 + 启动

pnpm test       # 运行全部 91 个测试
pnpm typecheck  # 三套 tsconfig 类型检查

pnpm smoke      # Electron 冒烟测试（自动启动并退出，输出 SMOKE_OK）
```

首次使用：在 **设置** 中填写 API Base URL（任意 OpenAI 兼容服务/中转站）、API Key、模型名，
点击"测试连接"；在侧边栏**选择工作区目录**；输入任务目标后运行。

> API Key 只保存在当前运行进程的内存中，不写盘、不进日志；重启应用后需重新输入。

## 架构

单 package 结构，模块边界清晰（后续拆分方案见下文）：

```
src/
  shared/       跨进程共享类型与 IPC 协议（渲染进程只做类型导入）
  policy/       Policy Engine + 路径边界检查 + 敏感信息脱敏
  persistence/  SQLite 打开/迁移 + Store 访问层
  gateway/      Model Gateway（OpenAI 兼容，流式 SSE + 非流式，统一工具调用格式）
  tools/        Tool Registry + 内置工具（list_files/read_file/search_files/
                write_file/apply_patch/get_git_diff/run_tests/submit_plan/complete_task）
  core/         Agent Loop、上下文窗口、Verifier 验收、AgentService 门面（不依赖 Electron）
  main/         Electron 主进程（窗口、IPC 处理器、设置、日志）
  preload/      contextBridge 白名单桥接
  renderer/     React UI（侧边栏/任务输入/时间线/文件变更/审批/结果/设置）
prompts/system.md   System Prompt（独立版本管理，v1.0.0）
tests/              unit / integration / security
```

### Agent Loop

```
任务 → System/Task 消息 → 模型调用（超时/重试）→ 解析工具调用 →
Zod 参数校验 → Policy 审批决策（allow / ask / deny）→（ask 时等待用户批准）→
执行工具（超时/取消检查/输出截断）→ 结构化结果回填模型 → 循环 →
complete_task（测试未通过时被程序拒绝）→ Verifier 验收 → completed / needs_review / failed
```

程序级防护（不依赖提示词）：

- 最大决策步数、任务总超时、单次模型超时、工具超时、结果长度截断
- 用户取消：中止模型调用；取消后不再启动任何新工具调用
- 暂停/恢复：暂停在步骤边界安全停车；恢复基于持久化 transcript 续跑
- 重复调用防护：同一工具+参数重复 3 次注入警告、5 次强制停止
- **测试修复闭环（阶段 2）**：run_tests 退出码非 0 时自动注入修复指令（定位根因→最小修复→重跑）；连续 4 轮失败安全停止
- **complete_task 门控（阶段 2）**：最近一次测试未通过时，程序拒绝宣告完成（TESTS_NOT_PASSING），强制先修复
- **连续失败防护（阶段 2）**：连续 4 次工具失败注入警告、连续 6 次判定无效修复循环并停止（成功即重置计数）
- 悬空 tool_calls 修复：任何中断路径都会补齐 tool 消息，保证 transcript 可恢复
- 崩溃恢复：启动时将遗留的 running/waiting_approval 任务标记为 interrupted，可一键恢复

### 联网工具与 SSRF 防护（阶段 4.2）

`web_fetch`（抓取公网网页提取正文）与 `web_search`（经用户配置的 SearXNG / Brave 检索），
均为 `network` 风险等级，默认自动放行，可在设置开启"联网操作需审批"（走现有审批流，
拒绝/取消/超时后请求不执行）。全部经 guarded-fetch 程序化防护：

- **URL**：仅 http/https、默认端口（模型可指定目标）；禁止 userinfo/控制字符；尾随点归一化；
  十六进制/八进制/十进制 IPv4 编码由 URL 解析器归一化后仍走私网检查
- **DNS**：逐地址校验（任一私网/保留/回环即整体拒绝，含混合公私结果与 IPv4-mapped/NAT64）；
  查询有独立超时与取消；解析结果以固定 IP 参与连接（检查与连接间无二次解析，防重绑定）
- **TLS/连接**：host=已校验 IP，Host 头与 SNI/证书主机名校验用原始域名，证书校验恒开；
  `agent:false`（无连接池复用）、不读代理环境变量
- **重定向**：手动跟随 ≤5 跳，每跳完整重验（scheme/端口/DNS/IP）
- **响应**：仅 identity 编码（拒压缩炸弹）、Content-Type 白名单、流式 2MB 上限超限即断开、
  响应头大小上限、总时长与慢速响应超时、随任务 abort 实际断开 socket
- **并发**：进程级同时联网请求上限 4
- **审计与密钥**：每次调用留审计（URL 凭据按现有脱敏规则处理）；搜索 API Key 只存内存
  （SecretStore），仅经请求头传递，绝不进入配置文件/日志/事件/错误消息/模型上下文；
  切换或重置搜索配置时立即清除旧密钥
- 搜索端点属用户显式配置（`user-configured` 策略：允许私网自建实例与自定义端口），
  其余防护不变；生产默认路径（public-strict）不继承该例外
- 网页正文与搜索摘要按 System Prompt v1.2.0 视为不可信数据

### 浏览器自动化（阶段 4.3）

默认关闭；启用后在设置中打开开关（使用 Playwright 自管理 headless Chromium，不接管用户浏览器）。
6 个工具：`browser_open / browser_snapshot / browser_click / browser_type / browser_scroll / browser_close`。

- **动态风险分级**（`src/policy/browser-risk.ts` 纯函数）：
  - 高风险（强制审批）：副作用动词（中英：提交/发布/删除/支付/…）、账户安全动词、
    表单提交型元素、密码/支付/验证码字段（autocomplete/name/type/value 形态综合判定）、
    **信息不足无法判定时一律按高风险**；
  - 普通导航点击 = network 级（受"联网操作需审批"开关控制）；快照/滚动/关闭 = 只读。
- **审批先于副作用**：审批经现有管道（落库/事件/UI/超时与取消解除）；批准返回后
  **立即重新解析元素并复核签名**（tag/type/name/文案/href/页面 URL 哈希）——页面或元素已变
  → `APPROVAL_STALE` 中止并要求重新快照，绝不执行；拒绝/取消/超时后不执行任何后续步骤。
  残余窗口（复检与点击之间的毫秒级）由 Playwright 定位器自动等待缓解。
- **输入纪律**：`browser_type` 只填充、无回车/按键能力（隐式提交路径结构上不存在，有测试证明）；
  审批摘要只含字段描述与影响，**绝不包含输入值**（测试断言）。
- **稳定标识**：快照为可交互元素分配 `data-wa-ref`；click/type 的 Schema 只接受 ref，
  CSS/XPath 选择器被拒绝；快照含长度上限与不可信内容标记。
- **隔离**：每任务独立 BrowserContext（空 Cookie/无扩展），任务结束/取消/恢复启动时幂等清理，
  迟到调用对已关闭会话立即失败；应用退出带 2.5s 超时清理浏览器进程。
- **网络受控**：`route()` 统一拦截主框架/子资源/iframe/重定向/popup（scheme/userinfo/
  DNS 全地址私网检查/端口，"不能校验即拒绝"）；**WebSocket 经独立的 `routeWebSocket()` 全部阻断**
  （route 不覆盖 ws）；Service Worker 禁用；`--no-proxy-server` 等启动参数阻断代理与后台网络。
  已知差异（相对 4.2 的固定 IP 连接）：路由拦截发生在 Chromium 解析之后、发送之前——
  无应用数据外流，但存在 DNS 预解析残余；子资源无逐响应字节上限（快照限长约束模型可见内容）。
- 测试例外 `loopbackExempt` 仅豁免回环地址（供本地测试服务器），**其余私网段仍拒绝**；
  生产默认路径不继承该例外（有专门测试以服务端 0 命中证明）。

### MCP 工具接入（阶段 4.4）

仅 stdio 传输；仅连接用户显式配置的可执行程序（无自动发现/自动连接/不接管未知服务器）。
使用 `@modelcontextprotocol/client@2.4.0`（Node ≥ 20，CJS 兼容）。

- **配置**：命令与参数分立、数组式 spawn（不经 Shell）；命令禁止空格/Shell 元字符；
  环境变量键名禁止敏感词；子进程仅收到白名单系统变量 + 用户静态配置（绝不转发
  `process.env` 全量、API Key、SecretStore 或应用配置）；`cwd` 必须绝对路径无 `..`。
  保存时与每次连接前双重校验（同一函数）。
- **Schema 同源校验**：模型看到的 JSON Schema 与本地参数校验使用**同一套语义**（白名单子集，
  含 type/properties/required/items/enum/边界/bool additionalProperties）。白名单外关键字
  （$ref/oneOf/anyOf/allOf/not/format/pattern/patternProperties/元组 items 等）→ **拒绝注册**。
- **命名空间**：`mcp__<server>__<tool>`（内置工具名 `[a-z][a-z0-9_]{1,63}` 安全映射）；
  服务器原始工具名保留在闭包中用于实际调用；命名冲突/超长/非法字符 → 拒绝注册并记事件。
- **风险**：所有 MCP 工具 `riskLevel='external'`，默认逐次审批（`requireApprovalForMcp` 设置，
  默认 true）；服务器自称安全不参与判定；审批在 Loop 层统一处理（非工具内），与所有内置工具
  走同一审批管道（事件/审批 UI/超时与取消解除/审计记录）。
- **取消**：SDK 逐请求 `AbortSignal` → 任务取消/超时只中止单次调用，**不关闭共享连接**
  （探针实测：取消后连接仍可用）。
- **结果**：仅提取 text 块（限长 20KB，超出截断标记）；非文本块 → 占位符；
  `isError:true` → 结构化 `[MCP_TOOL_ERROR]`；全部结果带不可信前缀。
- **生命周期**：`McpManager` 进程级持有连接、跨任务共享；服务器退出 → 状态
  disconnected → 后续调用报 `[MCP_SERVER_DOWN]`；应用退出 will-quit 带超时清理；
  配置变更 → 断开重连（幂等）。

### 计划与验收（阶段 2）

- `submit_plan` 提交步骤清单 → 系统持久化（`tasks.plan_json`）并在 UI 展示进度条；
  `update_plan` 标记步骤 done/skipped（索引越界返回结构化错误），事件广播到时间线；
  中断恢复时计划状态自动回灌，恢复后 `update_plan` 依然可用。
- Verifier 验收规则（程序判定，不依赖模型自述）：
  - 验收标准含"测试/test/spec/jest/pytest"关键词时，必须存在成功的 `run_tests` 才能判 completed；
  - 最近一次测试实际未通过（退出码非 0/超时，由循环跟踪）→ 不得判为 completed；
  - 未提交 complete_task、报告阻塞、存在失败工具调用等规则见阶段 1。

### 任务模板（阶段 4.1）

- 参数化模板（`{{param}}` 占位符）持久化到 SQLite，保存时强校验：
  占位符必须声明、参数名合法且唯一、`allowedTools` 必须是真实工具、约束范围受限；
  同名模板拒绝。
- **预算程序强制**（非提示词约束）：`maxSteps` 由 Agent Loop 在步骤边界强制；
  `taskTimeoutMs` 由定时器 + abort 信号**实际中止**进行中的模型调用与测试进程
  （run_tests 进程树随 abort 终止），等待审批的任务超时后也会解除等待。
- **模板约束只能收紧**：与全局设置逐项取 min / 子集，不能放宽；执行约束只取自
  持久化模板，客户端不可注入。
- **工具白名单双端生效**：注册表子集过滤模型端工具声明 + Agent Loop 执行端强制
  （`TOOL_NOT_ALLOWED`），绕过声明直接调用同样被拒；`complete_task` 始终保留
  （否则任务无法正常结束），但仍走完整策略与门控流程。
- **参数审计脱敏**：`task_started` 事件只记录模板 id/名称与参数的脱敏摘要
  （截断 + 密钥模式抹除）；参数原文只按任务持久化策略存在于 `tasks.goal`。

### 安全边界（程序层实现）

- 所有文件工具路径经 `resolveInsideWorkspace` → `realpath` 双重检查：
  拒绝 `..` 穿越、绝对路径越界、符号链接/junction 逃逸、经由不存在父目录的间接越界
- 写入前：最近已存在祖先目录 realpath 校验后才创建目录；拒绝覆盖二进制/超 2MB 文件/符号链接；
  修改前自动备份原内容到 SQLite（`file_changes` 表，含修改前全文，可回滚）
- **文件回滚（阶段 3）**：任务结束后可在"文件变更"页单条恢复或一键回滚全部 ——
  修改还原为任务前内容（多轮修改取最早备份），任务创建的文件被删除；
  运行中任务拒绝回滚；回滚路径重新经过完整安全检查；事件留痕（file_restored）
- **写入审批开关（阶段 3）**：设置中可开启"写入操作前需要审批"，
  开启后所有 write_file / apply_patch 执行前需用户批准（Policy Engine 程序级强制）
- `run_tests` 只能执行设置白名单中的命令（精确匹配，拼接注入串一律拒绝），
  进程以**数组参数 + shell:false** 启动（无命令注入面），超时按进程树终止；
  默认每次执行前需用户批准
- 删除类工具、网络发送类工具：第一阶段**不提供**
- IPC 只暴露白名单方法；主进程对所有输入做 Zod 校验；日志/事件统一脱敏（sk- Key、Bearer、凭据字段，
  有落盘文件级测试）；API Key 仅存内存
- 渲染进程加载：生产环境经注册的 `app://` 安全协议（standard + secure），
  避免 `file://` 下 ES Module 被 CORS 拦截；路径规范化防穿越；CSP 保持严格（script-src 'self'）
- Preload 自包含（sandbox 下不 require 本地模块，Electron 限制），通道名与协议定义有防漂移测试

### 验收原则（Verifier）

- 模型必须调用 `complete_task` 提交汇报，且给出验证说明
- 存在阻塞说明、run_tests 实际失败 → `needs_review`（不得判为 completed）
- 修改了文件但未运行测试 → 复核警告
- 未提交汇报即终止（超步数/超时）→ `failed`

## 测试覆盖（397 个用例，全部通过）

测试分四类，如实区分：**单元**（纯函数/注入 DNS）、**真实本地网络**（本地服务器 + 真实 socket）、
**真实浏览器**（真实 Chromium + 本地服务器，以服务端请求计数等外部证据断言）、
**真实 MCP stdio**（SDK 客户端 + 真实子进程 mock server，未连接真实第三方 MCP 服务）。

- 正常读取/创建/修改文件、搜索、列表、补丁、diff（git 与会话回退）
- 拒绝 `../` 穿越（read/write/list 各形态）、拒绝符号链接与 junction 逃逸
- 拒绝无效工具名、非法 JSON、Schema 违规参数；工具超时；取消后不执行
- 模型 API：HTTP 错误、超时、5xx 重试、流式解析、损坏事件容错、取消
- 工具失败 → 结构化错误回传模型可继续；审批批准/拒绝；白名单外命令直接拒绝
- 最大步数安全停止；取消后不启动新工具；纯文本不收尾 → needs_review
- 重复调用防护；SQLite 持久化往返；崩溃恢复（interrupted → resume → completed）
- 计划跟踪：submit/update_plan 状态持久化、索引越界与无计划的错误路径、恢复后计划回灌
- 测试修复闭环：失败注入修复指令→修复→重跑通过；轮次上限停止；complete_task 门控
- 验收条件程序化判定（要求测试的标准必须实际跑测试）
- 连续失败防护（6 次停止、4 次警告、成功重置）
- 文件回滚：单条恢复/全部回滚/多轮修改取最早备份/运行中拒绝/重复恢复 noop
- 写入审批：批准执行、拒绝后 DENIED_BY_USER、默认关闭对照
- 恢复任务注入已修改文件清单（副作用防护，含无变更对照）
- 日志脱敏落盘（文件级断言密钥不出现）与 child logger 上下文
- 白名单精确匹配（拼接注入/大小写变体拒绝）
- preload 通道与协议防漂移、sandbox 兼容（不 require 本地模块）
- 模板：保存强校验（未声明占位符/非法参数名/未知工具/越界约束）、渲染
  （必填缺失/默认值/多处替换/单趟防二次展开/长度上限）、参数审计脱敏与截断
- 模板持久化：CRUD 往返、重名拒绝、upsert 改名、文件库重启保留、旧库自动迁移
- 预算强制：taskTimeout 实际中止挂起的模型调用与长测试进程（墙钟断言）、
  审批等待超时解除、模板与全局取 min（模板 30/全局 3 → 3 步停止）
- 工具白名单双端：模型声明过滤 + 执行端 TOOL_NOT_ALLOWED + complete_task 保留
  + 被拒调用留审计记录
- 模板溯源：tasks 模板列 + task_started 事件脱敏摘要，参数原文不进事件日志
- 完成状态不依赖模型自述（Verifier 单测 + 集成测试）
- SSRF IP 矩阵（55 例）：IPv4 全部私网/保留/组播/CGNAT/TEST-NET 段、IPv6 ULA/链路本地/
  组播/文档段/discard、IPv4-mapped（点分与十六进制写法）、NAT64 映射、非法地址
- URL/DNS 边界：非法 scheme、userinfo、非默认端口、控制字符、尾随点、
  十六进制/八进制/十进制 IPv4 编码、混合公私 DNS 结果、DNS 超时/取消/失败（注入解析器）
- 真实本地抓取（真实 socket）：GET/Host 头=原始域名、固定 IP 防重绑定（注入错误 IP→连接失败）、
  代理环境变量不影响直连、绝对/相对重定向、ftp 重定向拒绝、跳数上限、2MB 流式截断+
  服务端确认提前断开、非文本类型拒绝、gzip 拒绝、慢响应头/体超时、abort 实际断开
  （服务端确认 socket 关闭）、超大响应头拒绝、生产默认路径不继承私网例外
- 真实 TLS（openssl 生成证书）：不受信 CA → TLS_ERROR（证书校验未关闭）；
  受信 CA 子进程 → 固定 IP + SNI/Host=原始域名 + 握手成功（服务器端验证 SNI）；
  受信 CA + 主机名不匹配 → 按原始域名校验失败（ALTNAME）
- web 工具：正常抓取提取正文/链接、SSRF 结构化错误回传模型、Zod 参数校验、
  并发信号量（服务端观察 ≤4）
- web_search：未配置结构化错误、SearXNG/Brave 协议一致性（本地伪服务）、
  密钥只经请求头且不出现在 URL、错误消息对回显密钥脱敏、缺密钥不发请求
- 联网审批：拒绝后请求不执行（服务端 0 命中）+ URL 凭据审计脱敏
- 浏览器风险分类矩阵（38 例）：中英副作用/账户动词、表单提交型、密码/支付/验证码字段
  （autocomplete/name/value 形态）、信息不足保守默认、元素签名稳定性与变化失效、
  审批摘要不含输入值、选择器参数被 Schema 拒绝、未启用不注册工具
- 真实浏览器（16 例）：打开/快照（ref 分配、不可信标记）/导航点击/重定向跳数、
  搜索框免审批输入、副作用审批（拒绝→服务端 0 POST；批准→真实 POST；审批期间元素变化→
  APPROVAL_STALE 不执行）、密码字段审批（摘要无值、拒绝未填充）、单输入框 fill 无隐式提交
  （服务端 0 POST）、私网子资源（10.x/IPv6 ULA/云元数据）+ WebSocket 全阻断（页面侧证据）、
  popup 受路由约束、生产默认策略拒绝回环（服务端 0 命中）、取消中断慢导航、
  双任务 Cookie 隔离、清理幂等/关闭后迟到调用失败/closeAll 关闭管理器
- MCP Schema 同源白名单（22 例拒绝矩阵：$ref/oneOf/format/元组 items/超深/超属性/无 type 等）
  + 参数同源校验（required/类型/边界/additionalProperties）
- MCP 配置防注入（命令空格/元字符、slug 规范、env 敏感键/非法键、args 控制、cwd 穿越）
  + 子进程 env 白名单（不含敏感键、保留 PATH）
- 真实 MCP stdio（16 例）：发现/命名/Schema 直通/echo 调用/同源校验失败不发请求/
  isError/超时后连接保持/取消后连接保持/超大结果截断/提示注入只作数据/
  external 风险级策略/无审批回调直接调用/环境变量隔离/两任务共享连接/
  closeAll/非法配置运行时拒绝

Electron 冒烟测试（`pnpm smoke`）真实启动应用并断言：React 已挂载（#root 有子元素）、
preload 已注入 `window.api`、数据库与提示词（v1.1.0）加载成功。

## 已知限制与后续计划

**当前为单 package 结构**，模块间以目录边界 + 相对导入隔离；Agent Core 不依赖 Electron，
可原样复用到 CLI。拆分方案：`packages/agent-core`（core+tools+policy+gateway）、
`packages/persistence`、`packages/shared`、`apps/desktop`，用 pnpm workspace 引用即可，
迁移点只有 import 路径。

未实现 / 待完善（按阶段）：

- 阶段 2 剩余：并行工具调用（当前顺序执行）
- 阶段 3 剩余：Playwright 端到端 UI 测试（冒烟已覆盖真实挂载与 API 注入）
- 阶段 4.2 已知限制：**web_search 仅做过协议一致性测试（本地伪 SearXNG/Brave 服务），
  未做真实外网搜索验证**——需要用户配置真实服务后人工验证；HTML 提取为正则级尽力而为，
  不执行 JS 渲染（动态页面内容可能缺失）；非 UTF-8 字符集按 UTF-8 尽力解码
- 阶段 4.3 已知限制：**未做真实外网浏览验证**（仅真实 Chromium + 本地服务器）；
  JS 重渲染页面需快照多次/滚动后重新快照；审批复检与点击之间存在毫秒级残余窗口
  （由定位器自动等待缓解）；Chromium 的 DNS 预解析残余（无应用数据外流）；
  截图能力未提供（无 browser_screenshot 文件外泄面）
- 阶段 4.4 已知限制：**未连接真实第三方 MCP 服务**（仅真实 SDK 客户端 + 本地 mock stdio
  子进程）；Streamable HTTP 传输未实现（待后续专项评审）；SDK 2.x callTool 的 signal/timeout
  行为已探针实测但 SDK 版本升级可能变更；服务器重连策略为手动（无指数退避自动重连）
- 阶段 4 其他：多 Agent 协作（待实际需求证明必要性）
- `run_command` 受控命令执行工具：按需求暂缓（当前仅白名单 run_tests）
- Electron 37 的 Node 提示 `node:sqlite` 为实验特性（功能可用；升级 Electron 38+ 可消除）
- 打包安装器（electron-builder）与渲染进程 HMR 开发模式未配置（主进程已预留 WORKFLOW_AGENT_DEV_SERVER 环境变量）
