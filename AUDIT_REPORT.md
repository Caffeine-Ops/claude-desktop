# Claude Desktop 全项目代码审计报告

> 生成日期：2026-07-05　·　方法：14 子系统并行审计 + 逐条对抗验证（72 个 agent）

## 概览

14 个子系统并行审计，覆盖约 **40 万行 TypeScript** 与 **4 万行 CSS**。每条问题都经过一个独立「怀疑者」agent 对抗验证——先尝试反驳、读实际代码确认证据、排除刻意设计的不变量，只有反驳失败才留下。

| 指标 | 值 |
|---|---|
| 确认问题 | **55** 条 |
| 验证阶段拦下的误报 | 3 条 |
| 参与 agent | 72（14 审计 + 58 验证） |
| agent 出错 | 0 |

**按严重度：**

| 严重度 | 数量 |
|---|---|
| 🔴 严重 (Critical) | 2 |
| 🟠 高 (High) | 8 |
| 🟡 中 (Medium) | 32 |
| ⚪ 低 (Low) | 13 |

**按类别：**

| 正确性 | 功能缺陷 | 性能 | 安全 | 竞态 | 资源泄漏 | 可维护性 |
|---|---|---|---|---|---|---|
| 16 | 14 | 10 | 6 | 5 | 2 | 2 |

## 优先修复清单（严重 + 高危）

1. 🔴 **MCP OAuth 回调页把 attacker 可控的 ?error= 直接塞进内联 <script>，</script> 断标签逃逸 → daemon 同源反射型 XSS** — `apps/daemon/src/mcp-routes.ts:356`
2. 🔴 **preload 把 @electron-toolkit 的 electronAPI 整体暴露给渲染层——泄漏无限制 ipcRenderer 和含 API 密钥的 process.env** — `apps/studio/electron/preload/index.ts:598`
3. 🟠 **每条流式 delta 都全量读改写 events_json，长对话 O(N²) 同步阻塞 daemon 事件循环** — `apps/daemon/src/db.ts:1029`
4. 🟠 **工具 token 固定 15 分钟 TTL 且无续期，超过 15 分钟的活跃 run 中途丢失 live-artifact/connector 工具能力** — `apps/daemon/src/tool-tokens.ts:3`
5. 🟠 **send() 对 runtime.active 无守卫，流式中再发一条消息会顶掉当前 turn，事件全部错挂且新回复被丢弃** — `apps/studio/electron/main/core/engine.ts:1000`
6. 🟠 **IMAGE_MANIFEST_READ 每次轮询同步解码全部图片且无缓存，生成期间反复按住主进程事件循环** — `apps/studio/electron/main/ipc/register.ts:680`
7. 🟠 **流式热路径零 memo：每个 rAF flush 重渲染整个对话并全量重新 parse 所有历史消息的 markdown** — `apps/studio/src/canvas/components/chat/AssistantMessage.tsx:121`
8. 🟠 **八项确认页所有「自定义」入口点击后死路：空草稿时 onChange('') 使 isCustom 恒为 false，自由文本输入框永不出现** — `apps/studio/src/chat/components/chat/CanvasConfirm.tsx:945`
9. 🟠 **AskUserQuestion 内联提问挂了无焦点作用域的 window 级键盘监听，在输入框打字会误提交答案并吞键** — `apps/studio/src/chat/components/permissions/AskUserQuestionView.tsx:307`
10. 🟠 **全局 textarea::selection { color: transparent } 的受益者已不存在，两面所有普通 textarea 选中文字直接隐形** — `apps/studio/src/chat/styles/main.css:312`

---

## 问题详情

### 🔴 严重 (Critical)

#### 1. MCP OAuth 回调页把 attacker 可控的 ?error= 直接塞进内联 <script>，</script> 断标签逃逸 → daemon 同源反射型 XSS

- **位置**：`apps/daemon/src/mcp-routes.ts:356`
- **类别**：安全　·　**区域**：daemon API 边界　·　**验证置信度**：high

**证据**　回调路由 GET /api/mcp/oauth/callback 明文注释「deliberately do NOT enforce isLocalSameOrigin … no Origin header at all on a top-level navigation」（第170-175行），即这条路由对浏览器顶层导航是无鉴权可达的。它把攻击者控制的 query 原样拼进消息：第179-183 行 `message: \`Auth provider returned error: ${error}\``（error = req.query.error，未过滤）。renderOAuthResultPage 第309 行 `payload = {..., message: opts.message ?? null}` 原样带上，第356 行 `var payload = ${JSON.stringify(payload)};` 把它注入内联脚本。JSON.stringify 只转义引号，不转义 `<`/`>`/`/`，所以 message 里的 `</script>` 会提前闭合脚本标签。全局 /api 中间件遇到无 Origin 请求直接 `return next()`（server.ts 第3469 行），且该回调响应没设任何 CSP（对比 setLiveArtifactPreviewHeaders 的 `script-src 'none'`）。PoC：浏览器新标签打开 `http://127.0.0.1:7456/api/mcp/oauth/callback?error=x%3C/script%3E%3Cscript%3E/*任意JS*/%3C/script%3E`。

**影响**　攻击者只需诱导用户点一个链接（默认端口 7456 可猜），注入的 JS 就运行在 daemon 自身 origin 上——这意味着它已是同源，彻底绕过所有跨源白名单/CORS 防护，可直接 fetch 同源 /api/* 接口读写/删除任意项目文件、触发部署、读凭据并外泄到攻击者服务器。对一个会读写用户磁盘、能 spawn 子进程的本地 daemon 属于本地 RCE 前置的完整同源 API 接管。第358 行 `postMessage(payload,'*')` 用通配 targetOrigin 又放大了消息面（虽 payload 本身不含 token）。

**优化方案**　三处收口：(1) 用脚本安全序列化替换第356 行——`JSON.stringify(payload).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/ /g,'\\u2028').replace(/ /g,'\\u2029')`，或改成 `<script type="application/json" id="p">…</script>` + `JSON.parse(document.getElementById('p').textContent)` 避免脚本上下文注入；(2) 给这条回调响应加一份最小 CSP（至少 `default-src 'none'; script-src 'self'` 或用 nonce），像 live-artifact 预览那样把内联脚本纳入白名单，杜绝任意注入脚本执行；(3) 把第358 行 postMessage 的 `'*'` 换成 daemon 自身 origin（getPublicBaseUrl(req)），别用通配。根因是「reflected 输入进了 <script> 上下文而只做了 HTML 转义」，第305 行 `<p>` 里的 escapeHtml 是安全的，问题只在 payload/script 这条路径。

---

#### 2. preload 把 @electron-toolkit 的 electronAPI 整体暴露给渲染层——泄漏无限制 ipcRenderer 和含 API 密钥的 process.env

- **位置**：`apps/studio/electron/preload/index.ts:598`
- **类别**：安全　·　**区域**：preload 与 IPC 契约一致性　·　**验证置信度**：high

**证据**　preload/index.ts 596-608 行：`contextBridge.exposeInMainWorld('electron', electronAPI)`。而同文件 81-82 行的头注释明确写着「Never expose ipcRenderer directly — that would give the renderer access to every channel, including unintended ones」。实测 @electron-toolkit/preload@3.0.2 的 dist/index.mjs：electronAPI.ipcRenderer 透传 send/sendSync/invoke/on/once/postMessage（任意 channel），且 `process: { get env() { return { ...process.env } } }` 返回完整环境变量副本。studio view 的 webPreferences 是 `sandbox: false, contextIsolation: true`（tabRegistry.ts 309-314），preload 的 process.env 即真实进程环境；main 的 bootstrap/loadEnv 在任何 renderer 创建前就把 env.json 的真实凭据（ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY / GEMINI_API_KEY，register.ts 799-800、1079-1084 都在读它们）灌进 process.env，renderer 子进程继承。前端对 window.electron 的调用点为零（grep src/ app/ 无一命中）。

**影响**　页面主世界里任何脚本（前端依赖树里的任意第三方包、markdown/HTML 渲染链一旦出 XSS、devtools 注入的代码）都能：① 直接读 `window.electron.process.env.OPENAI_API_KEY` 等密钥——这正是 TRANSCRIBE_AUDIO 注释里「Keeping the HTTP call in main means the API key never lands in the renderer」刻意防的东西，被这一行整个击穿；② `window.electron.ipcRenderer.invoke` 任意通道，包括 chatApi 从未暴露的 settings:cli-backend-set（改全局设置）、workspace:set 等，还能 `ipcRenderer.on` 窃听其它面板的 chat:event 流。整个「小而严格类型化的 chatApi」安全边界形同虚设。

**优化方案**　删除 `contextBridge.exposeInMainWorld('electron', electronAPI)` 这一行和顶部 `import { electronAPI } from '@electron-toolkit/preload'`（webUtils 已单独 import，pathForFile 不受影响），同步删除 index.d.ts 里的 `electron: ElectronAPI` 声明与 import，以及非隔离 fallback 分支的 `window.electron = electronAPI`。前端零调用点，删除零风险；typecheck 会抓出任何漏网引用。若将来确需 platform 探测，暴露一个只含 `{ platform: process.platform }` 的最小对象，绝不透传 ipcRenderer 和 env。

---

### 🟠 高 (High)

#### 3. 每条流式 delta 都全量读改写 events_json，长对话 O(N²) 同步阻塞 daemon 事件循环

- **位置**：`apps/daemon/src/db.ts:1029`
- **类别**：性能　·　**区域**：daemon 核心服务　·　**验证置信度**：high

**证据**　appendMessageAgentEvent（db.ts:1013-1031）每次调用都执行：SELECT 整个 events_json → JSON.parse 整个数组 → [...events, event] → JSON.stringify 整个数组 → `UPDATE messages SET content = COALESCE(content, '') || ?, events_json = ? WHERE id = ?`。调用方是 server.ts:10176-10179 的 send()（`persistRunEventToAssistantMessage(db, run, event, data)`），startChatRun 里所有 agent 事件（包括 claude-stream 的每个 content_block_delta 文本片段，claude-stream.ts:214-219 逐 chunk 发出）都走这条路。且 tool_result 内容零截断持久化（server.ts:2003 `content: String(data.content ?? '')`，claude-stream.ts stringifyToolResult 原文返回）——agent Read 一个大文件后 events_json 立刻膨胀几百 KB 到数 MB。better-sqlite3 是同步 API，之后每个 delta 都要在 daemon 事件循环上付整个 blob 的 parse+stringify+写盘。

**影响**　长 agent 运行（几千个 delta + 若干大 tool_result）时，单条消息的 events_json 达到 MB 级后，每秒几十个 delta × 每个 delta 双向 MB 级 JSON 处理 = 持续同步 CPU 按住事件循环，daemon 上所有 HTTP/SSE 请求（文件列表、其他会话流、live-artifact 工具调用）一起卡顿，症状与本项目 2026-07-03 main 进程同步扫描全 app 冻结事故同族；同时 WAL 每 delta 一次全 blob UPDATE 造成磁盘写放大。

**优化方案**　把逐事件落库改成内存缓冲 + 定期 flush：在 startChatRun 的 send() 层为每个 run 维护内存 events 数组，每 ~500ms 或每 N 条批量执行一次 UPDATE（close 时最终 flush），把 O(N²) 降为 O(N)；或者把事件改存独立 append-only 表 message_events(message_id, seq, json)，appendMessageAgentEvent 变成单条 INSERT，listMessages 读取时再聚合。另外对持久化的 tool_result content 加长度上限（如 32KB 截断 + 标记 truncated），SSE 直播流保持不截。

---

#### 4. 工具 token 固定 15 分钟 TTL 且无续期，超过 15 分钟的活跃 run 中途丢失 live-artifact/connector 工具能力

- **位置**：`apps/daemon/src/tool-tokens.ts:3`
- **类别**：正确性　·　**区域**：daemon 核心服务　·　**验证置信度**：high

**证据**　`DEFAULT_TOOL_TOKEN_TTL_MS = 15 * 60 * 1000`（tool-tokens.ts:3），mint() 里 `setTimeout(() => this.revokeToken(token, 'ttl_expired'), ttlMs)`（132 行）。全 daemon 唯一 mint 调用点是 server.ts:9741 startChatRun 开跑时一次性 `toolTokenRegistry.mint({runId, projectId, ...})`，未传 ttlMs；token 经 env 注入子进程后再无任何刷新/续期路径（grep 全仓只有这一个 mint 调用点）。每次工具调用都经 server.ts:2650 `toolTokenRegistry.validate(...)`，过期即返回 401 TOOL_TOKEN_EXPIRED。而 run 本身的 inactivity watchdog 只在完全静默 10 分钟后才杀（server.ts:3047），持续产出的 run 可以合法跑几十分钟甚至更久。

**影响**　coding agent 干大活（生成整站、多轮工具调用）超过 15 分钟后，MCP live-artifacts create/update、connectors execute 全部开始 401——agent 在 run 后半段无法注册/更新 live artifact、无法调 connector，表现为「跑了很久最后交付物没挂上」，且对用户只有 agent 转述的模糊报错。

**优化方案**　让 token 生命周期跟随 run 而不是固定挂钟：方案 A（最小改动）在 startChatRun 的 noteAgentActivity() 里顺带调用 registry 新增的 touch(token)（重置 expiresAtMs 与 timer，滑动窗口 15 分钟），child close 时已有 revokeToolToken('child_exit') 兜底回收；方案 B 把 mint 时 ttlMs 提到与 MAX_CHAT_RUN_INACTIVITY_TIMEOUT_MS 同级（24h），安全性不降级——token 本来就在子进程退出时被显式 revoke，TTL 只是泄漏兜底。

---

#### 5. send() 对 runtime.active 无守卫，流式中再发一条消息会顶掉当前 turn，事件全部错挂且新回复被丢弃

- **位置**：`apps/studio/electron/main/core/engine.ts:1000`
- **类别**：竞态　·　**区域**：ChatEngine 核心　·　**验证置信度**：high

**证据**　send() 在 ensureSessionReady 之后无条件覆盖单槽 active：`runtime.active = { requestId, messageId, ... }`（L1000），没有任何 `if (runtime.active)` 检查或排队。而 runPump 的 turn 边界配对是位置式的——`if (sdkMessage.type === 'result')` 就对当前 active 发 end 并清槽（L2063-2119），依赖注释里的不变量「Each user turn is followed by exactly one result」。这条路径用户可达已逐层确认：ProseMirrorComposerInput.tsx L116 的 Enter 处理 `onSubmit()` 无 streaming 守卫 → Composer.tsx L369-372 `composerRuntime.send()`（只有可见的 Send 按钮被 `ThreadPrimitive.If running={false}` 藏掉，Enter 不受影响）→ assistant-ui external-store core 的 `async append(message){ ... await this._store.onNew(message) }` 同样无 isRunning 守卫（实测 node_modules 源码，isRunning 检查只在 switchToBranch 里）→ FusionRuntimeProvider onNew 直调 chatApi.send。

**影响**　assistant 正在流式输出时用户按 Enter 发第二条：turn2 的 ActiveTurn 立刻顶掉 turn1 → turn1 剩余的 chunk/tool 事件全被记到 turn2 的 messageId（渲染进错误的气泡）→ turn1 的 result 到达时对 turn2 发 end 并清 active → SDK 随后真正执行 turn2 时所有消息命中「no active turn, dropping」被整段丢弃——第二条消息的回复在 UI 上永远不出现（虽然落了 JSONL）。无报错、无提示。

**优化方案**　两层修：1) engine 侧在 send() 安装 ActiveTurn 前检查 `runtime.active !== null`——最小修复是给 runtime 加 pendingTurns 队列（send 只 push {messageId,...} + emit start，runPump 在 result 清掉 active 后从队列弹出下一个装入 active），这与 AsyncMessageQueue 的缓冲语义天然对齐；不想做队列就先 throw『上一轮回复还在进行』让 renderer toast。2) renderer 侧在 ProseMirrorComposerInput 的 onSubmit 调用处（Composer.tsx L369）加 streaming 守卫，与隐藏 Send 按钮的行为对齐。两处都要——engine 自己文档说 send() 接受任意 runtime id，不能只靠 UI 拦。

---

#### 6. IMAGE_MANIFEST_READ 每次轮询同步解码全部图片且无缓存，生成期间反复按住主进程事件循环

- **位置**：`apps/studio/electron/main/ipc/register.ts:680`
- **类别**：性能　·　**区域**：主进程服务与 IPC handler　·　**验证置信度**：high

**证据**　handler 里对每个 exists 的条目执行 `const img = nativeImage.createFromPath(absPath); if (!img.isEmpty()) { item.thumbnail = img.resize({ width: 320 }).toDataURL() }`（register.ts 678-690）——createFromPath 解码、resize、toDataURL 重编码全是主线程同步 CPU。而渲染层 ImagesPanel.tsx 以 `IMAGES_POLL_MS = 1500` 的间隔带 `withThumbnails: true` 轮询（ImagesPanel.tsx 27/177-180/230），且每个 tick 都对**所有已完成图片**全量重新解码——没有任何 mtime/内容缓存，MAX_ITEMS=40 的上限只防单次爆炸，防不了每 1.5s 重复支付。注释「40 is a safe ceiling that still keeps the main thread responsive」只考虑了单次上限，没考虑重复解码。

**影响**　ppt-master 图片生成跑到中后期（例如 15-40 张 1024px 级 PNG，每张同步解码+缩放+PNG 重编码约 30-150ms），每 1.5s 的 tick 会让主进程被同步 CPU 按住数百毫秒到秒级——所有 IPC（聊天流式、权限响应、tab 操作）排队，全 app 可见卡顿/冻结，正是 2026-07-03 搜索弹窗冻结事故的同款模式（那次靠 mtime 键控 transcriptCache 修掉）。生成的图片越接近完成，卡得越狠。

**优化方案**　照搬 sessionStore.transcriptCache 的不变式：生成的图片文件写完后不再变化，mtime 不变 ⇒ 缩略图永远有效。在 register.ts 加模块级 `const thumbCache = new Map<string, { mtimeMs: number; dataUrl: string }>()`；循环里把 `existsSync(absPath)` 换成一次 `statSync`（顺便拿 mtimeMs），命中缓存直接复用 dataUrl，miss 才解码并写缓存；返回前用当前 manifest 的 absPath 集合 prune 同目录的陈旧 key。再保守一点可在相邻两次解码间 `await setImmediate` 让 IPC 插队（同 searchSessionContent 的 yieldToEventLoop 手法）。

---

#### 7. 流式热路径零 memo：每个 rAF flush 重渲染整个对话并全量重新 parse 所有历史消息的 markdown

- **位置**：`apps/studio/src/canvas/components/chat/AssistantMessage.tsx:121`
- **类别**：性能　·　**区域**：canvas 组件：home/chat/composer　·　**验证置信度**：high

**证据**　流式文本按 rAF 节流落地（bufferedTextUpdates.ts:75-82 `flushFrame = requestAnimationFrame(...)` + 250ms 兜底），每次 flush 走 ProjectView.updateAssistant → `setMessages(curr.map(...))`，触发 ChatPane 整体重渲染。ChatPane.tsx:981 `messages.map(...)` 里 AssistantMessage 是裸函数组件（AssistantMessage.tsx:93 `export function AssistantMessage(`，无 React.memo），且每个消息的 `onSubmitForm={(text) => {...}}`（ChatPane.tsx:1024）、`onFeedback`（:1034）都是内联新箭头函数。AssistantMessage 内部 `const blocks = stripTodoToolGroups(suppressAskUserQuestionFallbackText(buildBlocks(events)))`（:121-123）完全没有 useMemo——buildBlocks 每次渲染遍历全部 events 并 new Map；ProseBlock 里 `renderMarkdown(seg.text)`（:1239）也无缓存，markdown.tsx 的 parseBlocks+renderInline 是纯函数无 memoize，每次渲染对每段 prose 全量正则重 parse。连带效应：`displayedProduced` useMemo（:126-138）依赖每次渲染都换新的 `blocks`，memo 永不命中，`inferProducedFilesFromTurn` 对 projectFiles 的 filter+sort 每帧重跑。

**影响**　长对话（几十条含表格/代码块的 assistant 消息）流式期间，每秒最多 60 次 flush，每次都要对整个 transcript 做 O(全部 markdown 字符) 的正则解析 + O(全部 events) 的 block 重建。CPU 被渲染循环吃满，chat 面板打字、滚动、展开 tool card 全部卡顿，且随对话变长线性恶化——正好卡在产品最核心的交互上。历史消息对象在 updateAssistant 里保持引用不变（只替换流式那条），这些重算全部是浪费。

**优化方案**　三层改：① AssistantMessage 用 React.memo 包裹；ChatPane 把 per-message 内联回调下沉到一个小的 MessageRow 子组件（接收 message + 稳定的 onSubmitForm/onFeedback/onContinueRemainingTasks 引用，内部再绑定 message），或用 useCallback+message.id 派发，保证历史消息 props 全部引用稳定（projectFileNames 在 ProjectView.tsx:937 已 useMemo，可直接受益）。② AssistantMessage.tsx:121 的 blocks 计算包 `useMemo(() => stripTodoToolGroups(suppressAskUserQuestionFallbackText(buildBlocks(events))), [events])`——events 数组只有流式那条消息会换引用，历史消息直接命中缓存，同时救活 displayedProduced/pluginActionFolders 两个 memo。③ ProseBlock 里把 `renderMarkdown(seg.text)` 提为 `useMemo(..., [seg.text])` 的小组件（如 <MarkdownText text={...}/>），流式消息也只在文本真变时重 parse。改完后每次 flush 只有流式那一条消息重渲染。

---

#### 8. 八项确认页所有「自定义」入口点击后死路：空草稿时 onChange('') 使 isCustom 恒为 false，自由文本输入框永不出现

- **位置**：`apps/studio/src/chat/components/chat/CanvasConfirm.tsx:945`
- **类别**：正确性　·　**区域**：chat 组件层　·　**验证置信度**：high

**证据**　EnumField：`const isCustom = cur != null && cur !== '' && ids.indexOf(cur) === -1`（L893），自定义 chip `onClick={() => onChange(customText || '')}`（L945），而输入框条件是 `{allowCustom && isCustom && <input .../>}`（L981）。customText 初始为 ''（L903，仅当挂载时已是 custom 值才被 seed）。所以从目录选项状态下首次点「自定义」→ onChange('') → cur='' → `cur !== ''` 不成立 → isCustom=false → 输入框不渲染、chip 也不高亮，唯一后果是把当前字段值清成空串。VisualStyleField（L1090 同模式，L1058-1060）和 CanvasField（L1277，L1252-1253）逐字复制了同一逻辑。

**影响**　ppt-master 确认页的 canvas（画布格式）/ mode / icons / image_usage / visual_style 五处「自定义」全部无法使用：点击后无输入框、无选中态，看起来像没反应；且该字段被置空——用户若不再点回目录项就提交，tier1/final payload 里会带 `mode:''`/`canvas:''` 空值给服务器。只有推荐值本身就是 out-of-catalog 文本的罕见情形下输入框才可见。

**优化方案**　让空串也进入 custom 态：给三个组件加一个显式 `const [customOpen, setCustomOpen] = useState(isCustom)`，chip onClick 改为 `setCustomOpen(true); onChange(customText)`（值为空时不必立刻写 ''），输入框渲染条件改成 `allowCustom && (customOpen || isCustom)`；点击任一目录 chip 时 `setCustomOpen(false)`。同时在 submitTier1/submitFinal 前对空串字段回退到 recommended/first，防止把 '' 提交给服务器。

---

#### 9. AskUserQuestion 内联提问挂了无焦点作用域的 window 级键盘监听，在输入框打字会误提交答案并吞键

- **位置**：`apps/studio/src/chat/components/permissions/AskUserQuestionView.tsx:307`
- **类别**：功能缺陷　·　**区域**：chat 组件层　·　**验证置信度**：high

**证据**　useEffect 里 `window.addEventListener('keydown', handler)`（L307），handler 只检查内部 `otherEditing` 状态，完全不看 `e.target` 落在哪里：`if (/^[1-9]$/.test(e.key)) { ... e.preventDefault(); commitAnswer(current.options[n].label, true) }`（L267-274）、Enter → `commitAnswer(label, true)`（L285-301，最后一题时直接 onSubmit → respond('allow-once')）、Escape → `onCancel()`（= respond 'deny'）。而宿主 InlinePermissionPrompt.tsx L34-45 的注释明确设计目标是「no global key handler needed... scoped to this card」——非 AskUserQuestion 分支确实用了 container 局部监听，唯独这个分支被 AskUserQuestionView 的全局监听打穿。提问 pending 期间聊天 composer（ProseMirror contenteditable）依然可输入。

**影响**　非 slides 会话中模型调用 AskUserQuestion、内联提问卡可见时：用户在 composer 里输入含数字的文本（如「做3页就行」）——数字被 preventDefault 吞掉打不进输入框，同时第 N 个选项被 commit；若是最后一题直接 allow-once 提交给 AI（用户根本没作答）。按 Enter 发消息会把当前高亮选项提交为答案；按 Esc（包括取消拼音候选）直接 deny 整个提问。并行两个 AskUserQuestion 时两份全局监听同时响应，互相污染。

**优化方案**　把监听从 window 移到提问卡自身：InlinePermissionPrompt 已有 containerRef，给容器加 tabIndex={-1} 并在挂载时 focus，把 handler 绑到 containerRef.current 上（keydown 只在 focus-within 时到达）。若要保留全局快捷键，至少在 handler 开头加目标守卫：`const t = e.target as HTMLElement | null; if (t && (t.closest('input, textarea, [contenteditable="true"]'))) return`，并补 `if (e.isComposing) return`。CanvasQuestionnaire（slides 面）没有这个问题，可对照它的纯点击交互。

---

#### 10. 全局 textarea::selection { color: transparent } 的受益者已不存在，两面所有普通 textarea 选中文字直接隐形

- **位置**：`apps/studio/src/chat/styles/main.css:312`
- **类别**：功能缺陷　·　**区域**：CSS 双面泄漏审计　·　**验证置信度**：high

**证据**　main.css:312 `textarea::selection { color: transparent; background: hsl(var(--accent) / 0.28); }`（313 行 ::-moz-selection 同款）。规则前注释写明前提：「NB: targeting any `textarea` in the renderer is safe — only the composer ever mounts one. If that changes, scope this to the composer card via a class.」——这个前提已经双重失效：① chat composer 已迁到 ProseMirror contenteditable（.pm-composer-input，index.css:319），grep 全 src/chat 找不到任何 ComposerHighlightOverlay 组件，原「透明 textarea + 高亮 overlay」结构不存在了；② 合并单 document 后该规则命中整个页面——chat 自己的 LivePreviewEditor.tsx:1134（修改说明输入框）和 CanvasConfirm.tsx:1599/1733（自定义配色/字体输入）是普通可见文本 textarea，canvas 侧约 20 个组件（McpClientSection、SkillsSection、PasteTextDialog、NewAutomationModal、ProjectView、QuestionForm、MemorySection……）也都挂普通 textarea。canvas 只有自家 ChatComposer 用 base.css:2447 的 `.composer-input-wrap.has-mention-overlay textarea::selection` 自带 overlay 补字形，其余全部裸奔吃到 chat 这条全局规则。

**影响**　用户在任何一个普通 textarea 里选中文字（比如想复制 MCP JSON 配置、编辑修改说明、粘贴文本对话框），选区只显示一条 accent 淡色带，字符本身被画成 transparent 完全消失——看起来像文字被删了。两面全部命中，无控制台报错，纯视觉排查极难定位到这条 90 行外的注释规则。

**优化方案**　直接删除 main.css:312-319 两条规则（textarea::selection 与 textarea::-moz-selection）——它们服务的 overlay composer 已经退役，是零受益纯伤害的死规则。若想保留「选区跟主题 accent」的观感，改成不带 color: transparent 的版本：`textarea::selection { background: hsl(var(--accent) / 0.28); }`（不写 color，浏览器保留原文字色）。将来若 overlay textarea 复活，按原注释的自我要求用 composer 卡片类名收窄作用域。

---

### 🟡 中 (Medium)

#### 11. CI 把 ENV_JSON 真实密钥打进对外分发的安装包 asar，任何拿到 dmg/exe 的人可直接解包提取

- **位置**：`.github/workflows/build.yml:112`
- **类别**：安全　·　**区域**：workspace 包与构建链　·　**验证置信度**：high

**证据**　build.yml:112 `printf '%s' "$ENV_JSON" > apps/studio/env.json`，随后 electron-builder 按 apps/studio/package.json 的 `"files": ["out-electron/**/*", "resources/**/*", "env.json", "package.json"]` 把它打进 asar；发布步骤直接把 dmg/zip/exe 附到 GitHub Release。而 loadEnv.ts 自己的注释写明 "env.json carries real credentials. It is listed in .gitignore. Do not commit it, paste it, or log its values"——仓库里守得很严，但产物里原样带出。asar 无任何加密，`npx asar extract` 一条命令就能拿到 OPENAI_API_KEY（gpt-image-2）与 ANTHROPIC_* csdn gateway 凭据。

**影响**　任何下载安装包的用户（若 Release 公开则是任何人）都能提取共享 API key：OPENAI_API_KEY 可被直接盗刷计费，ANTHROPIC gateway 凭据可被脱离 app 白嫖。key 一泄露只能全量换 Release 轮换。

**优化方案**　短期：把这两组 key 换成网关侧可按 app 版本/设备吊销的低权限代理凭据（gateway 端做配额与来源校验），并在文档里明确这是有意的分发模型；不要用高权限官方 OPENAI_API_KEY 直落 env.json。长期：图像生成等计费调用走自家 daemon/gateway 中转（客户端只持有可轮换的匿名 token），env.json 只留非敏感开关。至少在 build.yml 该步骤加注释声明此风险是被接受的，避免后人往 ENV_JSON secret 里再塞更高权限凭据。

---

#### 12. daemon typecheck 的 pnpm --filter 前置重建守卫在本仓库是静默 no-op（无 pnpm-workspace.yaml），根 typecheck 对 daemon 给假绿；机器没装 pnpm 时根 typecheck 直接 exit 127

- **位置**：`apps/daemon/package.json:32`
- **类别**：正确性　·　**区域**：workspace 包与构建链　·　**验证置信度**：high

**证据**　apps/daemon/package.json:32 `"typecheck": "pnpm --filter @open-design/contracts build && pnpm --filter @open-design/registry-protocol build && tsc -p tsconfig.json --noEmit && ..."`。实测在 apps/daemon 下运行 `pnpm --filter @open-design/contracts build` 输出 `No projects matched the filters in ".../apps/daemon"` 且 **exit=0**——本仓库是 bun workspace，没有 pnpm-workspace.yaml，filter 匹配不到任何项目，pnpm 静默跳过。也就是说这两个『先重建契约包再 typecheck』的守卫从 open-design 平移过来后一直是死代码，daemon 的 tsc 永远对着盘上现存（可能陈旧）的 contracts/registry-protocol dist .d.ts 检查。

**影响**　两层：① 改了 contracts/registry-protocol 源码后跑根 `bun run typecheck`（项目唯一自动化防线），daemon 对旧 .d.ts 检查通过=假绿，破坏性契约变更要拖到 dist:* 发版时 daemon tsc 才炸（CI 的 typecheck 步骤刻意只查 studio，同样查不到 daemon）；② 没装 pnpm 的机器上根 typecheck 在 daemon 处 exit 127 整体失败——CI 注释里记录的正是这个死法，但只在 CI 侧绕开了，本地脚本没修。

**优化方案**　把守卫换成本仓库真实的包管理器：`"typecheck": "bun run --filter='@open-design/contracts' build && bun run --filter='@open-design/registry-protocol' build && tsc -p tsconfig.json --noEmit && tsc -p tsconfig.tests.json --noEmit"`（与根 prebuild:resources 的写法一致）。顺手把同文件 daemon/dev/start 三个脚本里的 `pnpm run build` 也换成 `bun run build`，消灭这批 open-design 时代的 pnpm 残留。修完后 CI 里『daemon typecheck 会因 pnpm 缺失而死』的规避理由消失，可考虑让 CI 恢复对 daemon 的类型检查。

---

#### 13. 六个 /api/proxy/*/stream 路由客户端断开后不中止上游 fetch，继续白烧上游 token；senseaudio 还会为死连接继续跑图/视频生成工具

- **位置**：`apps/daemon/src/chat-routes.ts:583`
- **类别**：资源泄漏　·　**区域**：daemon 核心服务　·　**验证置信度**：high

**证据**　同文件里 /api/provider/models（142 行）和 /api/test/connection（201 行）都正确接了 AbortController + req/res 'close'，但 anthropic/openai/azure/google/ollama/senseaudio 六个流式代理（539/635/731/844/944/1041 行）的 `await fetch(url, {...})` 全部没传 signal、也没挂任何 close 监听。客户端断开后 createSseResponse.send() 只是静默返回 false（server.ts:3005 `if (!canWrite()) return false`），streamUpstreamSse（429-450 行）照样 `reader.read()` 读完整个上游响应。senseaudio 路由更进一步：断开后 MAX_BYOK_TOOL_LOOPS 循环里 `await executeOneTool(call)` 仍会真实执行 generate_image / generate_video（注释自述视频「up to 5 min」）。

**影响**　用户在 BYOK 聊天里发出长回复后关页面/停止：上游 API 继续生成到自然结束，token 照常计费；senseaudio 场景下 daemon 还会为已经没人看的会话继续烧图片/视频生成额度并写文件进项目目录。多次「发出即离开」会累积多条僵尸上游流占用 daemon 连接与内存。

**优化方案**　给六个 proxy 路由复制 /api/provider/models 已有的模式：每请求 new AbortController()，fetch 传 signal，`res.on('close', () => { if (!res.writableEnded) controller.abort(); })`；streamUpstreamSse/streamUpstreamNdjson 的 onFrame 里利用 sse.send() 的布尔返回值——返回 false（客户端已断）即 return true 终止读循环；senseaudio 的工具循环在每轮开始前检查 `res.writableEnded || controller.signal.aborted` 提前退出。

---

#### 14. GET /api/projects 每次导航都对全量 messages 表做 LIKE 全表扫描 + 无 LIMIT 排序

- **位置**：`apps/daemon/src/db.ts:482`
- **类别**：性能　·　**区域**：daemon 核心服务　·　**验证置信度**：high

**证据**　listProjectsAwaitingInput（db.ts:482-514）对所有 assistant 消息跑 `LOWER(m.content) LIKE '%<question-form%'` + 窗口函数 + 每命中行一个 NOT EXISTS 子查询；listLatestProjectRunStatuses（db.ts:456-480）SELECT 全部 run_status 非空消息、按计算列 COALESCE(ended_at,started_at,created_at) 排序（无索引可用）并全部物化进 JS 再取每项目第一条。两者都在 project-routes.ts:85-86 的 GET /api/projects 处理器里同步执行；前端 RailProjectList.tsx:81-83 在 pathname 每次变化时都 reload 一次 /api/projects（画布内任意导航都触发），TasksView/RoutinesSection 也各自拉取。

**影响**　消息历史积累到几万条（重度用户几个月的量，assistant content 还包含完整回复文本）后，每次点侧栏/切路由都触发一次全表扫描 + 全量排序，better-sqlite3 同步执行期间 daemon 整体无响应，导航越多卡顿越频繁——性能随历史线性劣化且用户无感知原因。

**优化方案**　去掉每请求扫描：在 conversations（或 projects）表上加两列反规范化状态 latest_run_status / awaiting_input，由 upsertMessage / pinAssistantMessageOnRunCreate / reconcileAssistantMessageOnRunEnd 写消息时同步维护（写路径本来就在改同一行），GET /api/projects 退化为纯 projects 表读取；过渡方案是给这两个查询套 mtime/写计数键控缓存（daemon 单写者，任何 message 写入使缓存失效），并给 messages(role, run_status) 建部分索引。

---

#### 15. runPump finally 不置 pendingResume=true：cli 崩溃/退出后下一次 send 以「全新会话」重生同一 id，全部对话历史静默丢失

- **位置**：`apps/studio/electron/main/core/engine.ts:2146`
- **类别**：功能缺陷　·　**区域**：ChatEngine 核心　·　**验证置信度**：high

**证据**　runPump 的 finally（L2142-2161）只清 queue/handle/pumpPromise/ready*，没有碰 pendingResume。对比同文件 restartRuntimesForBackendChange L740 明确写 `rt.pendingResume = true`，注释是「Next send must reload the transcript so history survives the backend swap」——说明作者清楚：重生 runtime 必须带 resume 才能保住历史。但 pump 因子进程崩溃/被杀而退出时走的正是同样的重生路径：下一次 send() → ensureSessionReady 读到 `const resume = runtime.pendingResume`（此时为 false，L1713——它在上次 spawn 时已被消费置 false）→ openSession 走 `{ sessionId }` 分支而非 `{ resume: sessionId }`（L1458），fusion-code 以同 id 新建会话。abort() 的注释（L1139-1141）也承认 interrupt 可能杀掉整个 query() 走到这条路。

**影响**　聊了很久的会话中 fusion-code 子进程崩一次（OOM、网络断连抛错、abort 触发 SDK 杀 query），用户接着发下一条消息：模型拿到的是零上下文的全新会话，且 CLI 对着磁盘上已存在的 <sessionId>.jsonl 以「新会话」身份写入——历史上下文丢失 + 转录文件被混写/覆盖。全程无任何报错，用户只会觉得「AI 忽然失忆了」。

**优化方案**　在 runPump 的 finally 里补一行：当本 runtime 生命周期内已见过 system init（可用局部布尔在 readyResolve 调用处记录，或直接判 runtime.openedViaSend）时置 `runtime.pendingResume = true`，语义与 restartRuntimesForBackendChange L740 完全一致——JSONL 此时已在磁盘上，下一次 send 就会带 --resume 重载历史。顺带把 runPump 头注释「The next send() will then call openSession() again and pay another cold start」补上 resume 语义说明。

---

#### 16. warmup 异步续体在 await 之后不再校验 activeSessionId/disposed，可向已切走的会话甚至已 dispose 的 engine spawn fusion-code 进程

- **位置**：`apps/studio/electron/main/core/engine.ts:1653`
- **类别**：资源泄漏　·　**区域**：ChatEngine 核心　·　**验证置信度**：high

**证据**　switchToSession 的 warmup 定时器只在触发瞬间做 double-check：`if (this.activeSessionId !== newId) return`（L1652），随后的 async IIFE 里 `await this.refreshExternalMcpServers({ waitForDaemon: true })` 最长阻塞 8 秒（loadExternalMcpServers deadline=8000ms，externalMcp.ts L159），await 回来后直接 `await this.ensureSessionReady(newId)`，没有任何重校验。期间两种情况都会漏：1) 用户切到会话 B——switchToSession(B) 的 warmup-cancel 检查 `prevRt.handle || prevRt.queue`（L1601）时 A 还没 spawn（handle/queue 均 null）所以放过了 A 的 slot，之后 A 的续体照样 spawn；2) 窗口关闭——dispose()（L623-647）只 clearTimeout 已排队的 timer，对已在 await 中的续体无能为力，且 dispose 清空 sessions 后 getSession 会在同一个 map 里重建 slot、openSession 照常 spawn（webContents 已毁只是让事件静默丢弃，进程本身活着）。engine 没有任何 disposed 标志（全文 grep 确认）。

**影响**　冷启动 daemon 未就绪（正是 waitForDaemon 存在的场景）时：用户点开会话 A 又在几秒内切到 B → A 得到一个永远不会被 warmup-cancel 回收的 idle fusion-code 进程（每个冷启动烧满一个核数秒，之后常驻内存）；更糟的是在这 8 秒窗口内关窗口 → fusion-code 被 spawn 进已 dispose 的 engine，无人持有、无人回收，泄漏到 app 退出为止。

**优化方案**　两处改：1) warmup 续体在 refreshExternalMcpServers 的 await 之后、调 ensureSessionReady 之前重查 `if (this.activeSessionId !== newId || this.disposed) return`；2) 给 engine 加 `private disposed = false`，dispose() 开头置 true，并在 ensureSessionReady/openSession 入口 throw 或 return——这同时兜住未来任何 fire-and-forget 路径在 dispose 后复活 runtime 的可能。send() 同期的 waitForDaemon await 不用改（用户主动等待，spawn 是其明确意图）。

---

#### 17. abort() 立即清 active 但被中断 turn 的 result 仍会从流里晚到，若用户已发新消息则新 turn 被 stale result 提前终结

- **位置**：`apps/studio/electron/main/core/engine.ts:1152`
- **类别**：竞态　·　**区域**：ChatEngine 核心　·　**验证置信度**：high

**证据**　abort()（L1128-1153）发出 interrupt 控制请求后同步 `this.emitEvent(sessionId, { type: 'end', ... }); runtime.active = null`，但 pump 还在跑：CLI 处理 interrupt 后仍会为被中断的 turn 产出一条 `result`（runPump 头注释自己列了 subtype 'error_*' 族）。end 事件让 renderer 的 isRunning 立刻翻 false、composer 解锁，用户马上发下一条 → send() 装入新 ActiveTurn → stale result 到达时 pump 在 L2063 把它当作新 turn 的边界：handleResultMessage 因 subtype 非 success 对新 messageId 发 error 事件（L2798-2804），随后 emit end 并清 active（L2115-2119）→ 新 turn 真正的流式内容全部命中「no active turn」被丢。result 消息不携带我们的 messageId/requestId，配对纯靠位置，abort 打破了「一 turn 一 result」的不变量却没有消费掉那条孤儿 result。

**影响**　常见操作序列「点停止 → 立刻改口发新问题」（窗口 = interrupt 往返耗时，数百 ms 到数秒）：新问题的气泡先显示一条莫名的错误信息，然后 AI 的真实回复永远不渲染（内容落在 JSONL 里但 UI 丢弃）。用户视角是「停止之后再问就坏了」。

**优化方案**　abort 时不破坏配对：给 runtime 加 `staleResultsExpected` 计数（或把 active 改为带 aborted 标记保留在槽内），abort() 里计数 +1 而 UI 侧的 end 照发；runPump 收到 result 时先检查计数 >0 就消费掉并 continue（不发任何事件、不清新 active），归零后才恢复正常配对。这样 stale result 被显式吞掉，新 turn 的边界仍由它自己的 result 驱动。

---

#### 18. restartRuntimesForBackendChange 跳过 in-flight runtime 后无后续回收：该会话直到 app 重启都停留在旧 backend，注释承诺的「下一 turn 生效」永不发生

- **位置**：`apps/studio/electron/main/core/engine.ts:705`
- **类别**：正确性　·　**区域**：ChatEngine 核心　·　**验证置信度**：high

**证据**　L703-706 对 in-flight runtime 直接 `if (rt.active) continue`，注释解释是「Those finish on the old backend and only the turn AFTER completion picks up the new one (the pump's finally clears handle/queue → next send re-spawns)」。但这个机制依据是错的：pump 是长命的（Milestone B 设计——单个 query({prompt: iter}) 撑整个会话），turn 结束只是 L2119 `runtime.active = null`，for-await 继续迭代，finally 根本不会跑；也没有任何代码在 turn 结束时关 queue。于是 handle/queue 一直非空，下一次 send() 的 ensureSessionReady 在 L1709 `if (runtime.handle && runtime.queue)` 直接 short-circuit 复用旧进程——正是这个函数头注释里说要修掉的「must restart to switch」bug，在 in-flight 会话上原样复活。

**影响**　用户在某个会话回复流式进行中去设置页把 bundled fusion-code 切成系统 claude（或反向）：该会话之后的每一轮都仍然跑在旧 backend（旧模型、旧网关、旧凭据）上，设置 UI 显示已切换，零报错零提示。只有重启 app 或手动 close runtime 才真正生效。

**优化方案**　把「turn 结束后回收」显式化：restartRuntimesForBackendChange 对 `rt.active` 非空的 runtime 置 `rt.recycleAfterTurn = true`（SessionRuntime 加一个布尔字段）；runPump 在 result 分支清掉 active 之后检查该标志——为真则置 `runtime.pendingResume = true` 并 `runtime.queue.close()`，让 pump 自然走 finally 清场，下一次 send 就按新 backend 冷启动并 --resume 保历史。这正好复用现有的 teardown 路径，不引入新的并发面。

---

#### 19. SESSION_RENAME/SHELL_SESSION_RENAME 的 sessionId 未限制字符集，可路径穿越向任意既存 .jsonl 追加写

- **位置**：`apps/studio/electron/main/ipc/register.ts:1715`
- **类别**：安全　·　**区域**：主进程服务与 IPC handler　·　**验证置信度**：high

**证据**　validateSessionRenamePayload 只检查 `typeof v.sessionId !== 'string' || length===0 || length>128`（register.ts 1715-1727），随后 renameSession → findSessionJsonl 直接 `const candidate = join(dir, `${sessionId}.jsonl`)`（sessionStore.ts 491）并 `await appendFile(filePath, line, 'utf8')`（sessionStore.ts 249）。sessionId 传 `../../../../Users/x/notes`（<128 字符）即解析到 projects 目录之外。对照组：SHELL_SESSION_DELETE 之所以安全纯属侥幸——SDK 的 deleteSession 内部有严格 UUID 正则 `/^[0-9a-f]{8}-[0-9a-f]{4}-.../i` 校验（sdk.mjs 的 L$ 函数），我们自己写的 rename 链路没有对等防线。register.ts 头注释明确要求「Each exposed procedure is a potential attack surface — validate every input」。

**影响**　被攻破的渲染进程（聊天内容渲染 XSS 等）可对用户磁盘上任意既存 `.jsonl` 文件追加一行 JSON（如其他 workspace 的会话记录、别的应用的 jsonl 数据文件），造成越权写/数据污染。WORKSPACE_FILE_OPEN 同类风险已用「拒 `..` 段 + path.relative 二次校验」双保险堵住，唯独 sessionId 这条通道裸奔。

**优化方案**　在 register.ts 把所有 sessionId 校验器（validateSessionId、validateSessionRenamePayload、validateSessionLoadPayload、validateSessionSwitchPayload、validateSessionCloseRuntimePayload）收紧为字符集白名单：`if (!/^[A-Za-z0-9_-]+$/.test(v.sessionId)) throw`——真实 sessionId 全是 UUID，白名单零误伤；一处抽成共享的 assertSafeSessionId 供五个校验器复用，与 SDK 的 UUID 守卫形成同层防线。

---

#### 20. studio 主 UI 全程无 Content-Security-Policy，前端 XSS 可直达 chatApi 特权桥

- **位置**：`apps/studio/electron/main/services/appProtocol.ts:75`
- **类别**：安全　·　**区域**：Electron 安全配置　·　**验证置信度**：high

**证据**　prod 下页面由 app:// handler 读盘返回，fileResponse 只设了 content-type 一个响应头，没有任何 CSP（appProtocol.ts:64-78,75）。next.config.ts 也没有 headers()，且 static export（output:'export'）模式下 Next 的 headers/rewrites 全部失效（next.config.ts:12-37）；全仓 grep Content-Security-Policy/http-equiv 在 app//src//public/ 零命中。也就是说承载 window.chatApi 的 studio 顶层文档没有 script-src/default-src 约束，而它又用 AssistantMarkdown 把不可信模型输出渲染成 markdown/HTML（src/chat/components/chat/AssistantMarkdown.tsx）。

**影响**　studio 顶层框架里一旦出现一个 XSS sink（markdown 渲染漏洞、被注入的第三方脚本等），注入脚本就运行在持有 chatApi 的主世界里，等同拿到与 finding #1 相同的完整 IPC 桥（可 bypassPermissions + 驱动 agent 任意命令、读任意文件）。缺 CSP 违反 Electron 安全基线第 6 条，且把「一个前端 XSS」直接放大成「主机级危害」。

**优化方案**　在 fileResponse 里对 HTML 响应补 Content-Security-Policy 响应头，例如 default-src 'self' app:; script-src 'self' app:; style-src 'self' app: 'unsafe-inline'; img-src 'self' app: data:; connect-src 'self' app:; frame-src app: http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'none'。因为 dev 页面来自 next dev 不走 app:// handler，最稳的做法是在 main 里用 session.defaultSession.webRequest.onHeadersReceived 对 studio 的 webContents 统一注入 CSP 头，dev/prod 一致覆盖；dev 需放宽 HMR（'unsafe-eval'/ws）到独立 dev-only 分支。

---

#### 21. studio webContents 缺 will-navigate 守卫，顶层跨源导航会把 chatApi 特权桥带进攻击者页面

- **位置**：`apps/studio/electron/main/tabRegistry.ts:319`
- **类别**：安全　·　**区域**：Electron 安全配置　·　**验证置信度**：high

**证据**　newStudioTab 给 WebContentsView 挂了完整 preload（preload: index.mjs，暴露 window.chatApi）且 contextIsolation:true（tabRegistry.ts:308-319）。但导航侧只调了 attachExternalLinkHandler，它只 hook setWindowOpenHandler（新窗口路径），并在注释里明确写「We do NOT hook will-navigate」（tabRegistry.ts:79-88, 93-100）。Electron 的 preload 会在同一 webContents 的每次顶层导航后重新注入——一旦 studio 顶层被导航到任意 origin（http/https/file），evil 页面照样拿到 window.chatApi。而这条桥非常重：PERMISSION_MODE_SET 接受 'bypassPermissions'（register.ts:1169-1178,1481），CHAT_SEND 能驱动 agent 的工具（register.ts:280-289），SHELL_OPEN_PATH 打开任意绝对路径文件（register.ts:476-505），IMAGE_FILE_READ 把任意图片文件读成 data URI 外带（register.ts:711-752）。

**影响**　任何能触发 studio 顶层跨源导航的路径（Electron 经典脚坑：往窗口拖入一个 URL/.html 文件默认就会导航过去，而本 app 是文件密集型工作流；或任意 location.assign/重定向）都会让攻击者页面继承 chatApi。到手后可 PERMISSION_MODE_SET('bypassPermissions')+CHAT_SEND 让 agent 执行任意命令，等于 RCE；或直接读任意文件外带。注释声称不 hook 是为了不打断 web app 路由，但该前端是 Next SPA，客户端 pushState 导航根本不触发 will-navigate，守卫不会影响路由——这个理由不成立。

**优化方案**　在 newStudioTab 里给 view.webContents 加 will-navigate（并同样处理 will-redirect）守卫：解析目标 URL，只放行已知 studio origin（dev=http://localhost:3100，prod=app://studio），其余一律 event.preventDefault()（需要外链时复用已有的 shell.openExternal）。这与 setWindowOpenHandler 的白名单对称，且 SPA 用 pushState 不触发 will-navigate，正常路由零影响。另建议把该 tab 的 sandbox:false 改回默认沙箱（若 preload 无 Node 依赖）以增加纵深防御。

---

#### 22. 标注(annotation)『send』路径绕过 sendDisabled 且用陈旧闭包，用户输入会被静默清空丢失

- **位置**：`apps/studio/src/canvas/components/ChatComposer/ChatComposer.tsx:877`
- **类别**：功能缺陷　·　**区域**：canvas 组件：home/chat/composer　·　**验证置信度**：high

**证据**　ANNOTATION_EVENT 处理器（:791-903）的 `detail.action === 'send'` 非流式分支直接 `sendComposedTurn(prompt, attachments, ...)`（:877-880），而 sendComposedTurn（:721-732）只调 `onSend(...)` 后无条件 `reset()`——全程没有检查 `sendDisabled`。对比：键盘/按钮路径 `submit()` 第一行就 `if (sendDisabled) return`（:1086），流式结束后的补发 effect 也有 `if (streaming || sendDisabled) return`（:907）。而上游 ProjectView.handleSend（ProjectView.tsx:1832）遇到 `currentConversationBusy` 是静默 `return`。另外该分支的 `draft`/`staged`/`streaming` 都是事件注册那次渲染的闭包值，中间还隔着一个 `await uploadProjectFiles(...)`（:804），等待期间用户新打的字不在 stale `draft` 里。

**影响**　sendDisabled=true 而 streaming=false 的窗口（刷新后后台 run 仍 active、切会话 messages 还在加载、消息加载失败），用户在预览上画标注选『发送』：onSend 被 ProjectView 静默丢弃，但 composer 已经 reset()——草稿、staged 附件、staged 评论、刚上传的截图引用全部被清空，零提示，用户输入直接丢失。次要路径：正常状态下标注触发到上传完成之间用户在 composer 补打的文字，也会因 stale draft 不被发送却被 reset 抹掉。

**优化方案**　在 :854 的 send 分支把 `if (streaming)` 扩成 `if (streaming || sendDisabled)`（并把 sendDisabled 加进 effect 依赖 :892-903）——落入与流式相同的『stage + streamingAnnotationSendPending』挂起路径，等 :905 的补发 effect 在可发送时用最新 state 补发，天然同时解决 stale-draft 问题（该 effect 读的是当前 draft/staged）。另外 sendComposedTurn 里 onSend 之前也应兜底 `if (sendDisabled) return false`，避免未来再有调用点绕过守卫。

---

#### 23. per-turn 技能（stagedSkills/meta.skillIds）整条链路死掉：@ 选技能实际是永久改项目默认技能

- **位置**：`apps/studio/src/canvas/components/ChatComposer/ChatComposer.tsx:741`
- **类别**：正确性　·　**区域**：canvas 组件：home/chat/composer　·　**验证置信度**：high

**证据**　grep 全文件：`setStagedSkills` 只有 reset 清空（:688）和 removeStagedSkill 过滤（:748），从没有任何 add——stagedSkills 永远是空数组。但整套下游都还在按『每回合技能』契约运转：ChatSendMeta.skillIds 的注释说『Per-turn skill ids picked via the @-mention popover…without touching the project's persistent skillId』（:156-161）；:734-740 的注释说『Picking a skill…adds ONLY a staged chip (StagedSkills row / context state)』；currentRunContextMeta（:706）从 stagedSkills 读 skillIds。实际上 `insertSkillMention`（:741-745）、PM 路径 `handlePmPickItem` 的 skill 分支（:1261-1263）、ToolsSkillsPanel onPick（:1691-1693）三个入口全部走 `applyProjectSkill` → `patchProject(projectId, { skillId })`（:1064-1070），即持久改写项目级 skillId。对照同文件 MCP/connector 入口（insertMcpMention :1050、insertConnectorMention :1057）确实按注释 setStaged*。附带：`const stagedSkillIds = new Set(stagedSkills.map(...))`（:1184）每次渲染 new，把 mentionAdapter 的 useMemo（:1251 依赖含 stagedSkillIds）打成每渲染重建。

**影响**　行为与文档/UI 承诺相反：用户 @ 一个技能想只作用于本回合，结果项目的持久 skillId 被静默替换，之后每一轮都带着这个技能跑，且没有 chip 提示（StagedSkills 行 :1289 永远不渲染）、没有可移除入口（removeStagedSkill 死代码）。daemon 侧 meta.skillIds/context.skillIds 永远收不到值，任何依赖 per-turn skill 组装 system prompt 的后端路径形同虚设。后续维护者按注释理解代码必然踩坑。

**优化方案**　二选一并对齐注释：A) 恢复 per-turn 设计——insertSkillMention/handlePmPickItem 的 skill 分支改为 `setStagedSkills((prev) => prev.some(s=>s.id===skill.id) ? prev : [...prev, skill])`（不再调 applyProjectSkill），让 currentRunContextMeta 的 skillIds 真正带上值；ToolsSkillsPanel（项目级设置面板）可保留 applyProjectSkill 语义。B) 若产品已决定全部走项目级技能，则删掉 stagedSkills state、StagedSkills 渲染、removeStagedSkill、meta.skillIds 组装，并改掉 :156-161 与 :734-740 两处已经撒谎的注释。同时把 :1184 的 Set 包进 useMemo([stagedSkills]) 修复 mentionAdapter 的 memo。

---

#### 24. 文件读取失败被静默当成空文件渲染，用户误以为内容丢失

- **位置**：`apps/studio/src/canvas/components/FileViewer/media-viewers.tsx:664`
- **类别**：正确性　·　**区域**：canvas 组件：文件/项目/插件/记忆　·　**验证置信度**：high

**证据**　TextViewer（L661-666）：`void fetchProjectFileText(projectId, file.name).then((t) => { if (!cancelled) setText(t ?? ''); });`；MarkdownViewer L878-879 `setText(next ?? '')`、ReactComponentViewer L161-162 `setSource(text ?? '')` 同款。fetchProjectFileText（providers/registry.ts L1442-1478）在 404/500/网络异常时统一返回 null，`?? ''` 把失败坍缩成空串。对比同文件 SvgViewer（L566-575）对 null 明确设置 sourceError 并渲染 previewUnavailable——三个 viewer 与它不一致。

**影响**　daemon 瞬时 500、agent 正在重写文件（chokidar unlink+add 窗口）、或文件被删时，打开 text/code/md/jsx 文件显示为一份「空文件」：无错误提示、Copy 按钮复制空串、用户很可能以为 agent 把内容清空了。mtime 变化触发的自动重取失败时同样把已显示的内容替换成空。

**优化方案**　照抄 SvgViewer 的模式：三处 `.then((t) => setText(t ?? ''))` 改为区分 null——null 时置 error state 渲染 t('fileViewer.previewUnavailable')+重试按钮（reloadKey 机制已有），仅 t === '' 才渲染空内容。这样失败与真空文件可区分，且不破坏现有 loading 判断（text === null 仍表示加载中，可另加 loadError state）。

---

#### 25. TextViewer 对大文件无任何阈值防护，打开多 MB 文本/JSON 同步冻结整个 canvas 面

- **位置**：`apps/studio/src/canvas/components/FileViewer/media-viewers.tsx:996`
- **类别**：性能　·　**区域**：canvas 组件：文件/项目/插件/记忆　·　**验证置信度**：high

**证据**　CodeWithLines（L996-1008）：`const lines = text.split('\n'); const gutter = lines.map((_, i) => `${i + 1}`).join('\n');` 全量拆行+拼行号串，再渲染两个巨型 <code> 节点。上游 TextViewer L696-700 `formatJsonFileTextForDisplay` 对 JSON 文件还会同步 `JSON.parse(text)` + `JSON.stringify(parsed, null, 2)`（L749-758）+ 逐字符扫描 hasPrecisionSensitiveJsonNumberText。FileViewer.tsx L249-251 把所有 kind==='text'|'code' 文件无条件路由到 TextViewer，无大小上限。对比同文件 ReactComponentViewer L184-191 对 source>100_000 特意 setTimeout 让出主线程——说明大源文件是已知场景，但 TextViewer 完全没有防护。

**影响**　agent 产出大 JSON 数据文件/日志（几 MB 到几十 MB）后用户在 Design Files 双击打开：JSON.parse+stringify 双倍内存+同步 CPU 按住主线程数秒，随后 10 万行级 <pre> 布局再卡数秒，canvas 与 chat 共存同一 document，整个 studio 页面冻结（同「main 同步 CPU 按住事件循环」坑的 renderer 版）。

**优化方案**　在 TextViewer 加尺寸闸门：file.size 超阈值（如 2MB）时不走 fetchProjectFileText 全量渲染，改渲染截断视图（前 N 行 + 「文件过大，共 X MB，下载查看全部」，复用 FileActions 的 download 链接）；formatJsonFileTextForDisplay 加 `if (text.length > 1_000_000) return text;` 短路跳过美化。阈值检查放在 effect 之前可以完全避免大响应体进内存两份。

---

#### 26. autosave 直接持久化不完整的执行模式草稿，Issue #739 守卫已成死代码

- **位置**：`apps/studio/src/canvas/components/SettingsDialog/SettingsDialog.tsx:1041`
- **类别**：正确性　·　**区域**：设置页迁移区　·　**验证置信度**：medium

**证据**　autosave 循环对原始草稿零校验直接落盘：`const snapshot = autosaveLatestRef.current; ... await onPersist(snapshot, persistOptions);`（1017/1041 行）。而 settingsHelpers.ts 里专为此写的两个守卫 `shouldEnableSettingsSave`/`sanitizeSettingsSavePayload`（635-692 行，注释明说"Persisting it would leave the app in an unusable execution state after the modal closes. Issue #739"）经全仓 grep 确认除 index.ts 重导出外零调用——footer Save 按钮删除后（1123 行注释"With no footer button anymore"）没人再走这条守卫。触发极易：执行模式面板点一下"API"tab（`setMode` 457 行）或任一 BYOK 协议 tab（`switchApiProtocolConfig` 会强制 `mode:'api'`，settingsHelpers.ts 713 行），400ms 后 mode='api'+空 apiKey/model 就被 `onPersist` 写进 localStorage + daemon（App.tsx handleConfigPersist 无二次校验，buildPersistedConfig 只剥 Composio 秘钥）。

**影响**　用户好奇点了一下 BYOK tab 没填任何字段就关掉设置页（或切到其他 section 后忘了改回）：残缺的 api 模式被持久化，聊天发送链路按 BYOK 走（ProjectView.tsx 1191 行 `streamFormat: config.mode === 'api' ? 'plain' : undefined` 等多处分支）但没有可用凭证，会话直接不可用，且重启后依旧——正是 #739 修过又复发的场景。

**优化方案**　在 autosave 定时器回调里持久化前套用现成守卫：`const sanitized = sanitizeSettingsSavePayload(snapshot, autosaveLastSavedRef.current, activeSection, agents, isValidApiBaseUrl(snapshot.baseUrl))` 再 `onPersist(sanitized, ...)`；同时 unmount flush（1108 行）走同一清洗。这样用户在执行 section 内编辑时草稿照常落盘（activeSection==='execution' 时 passthrough 保持现状），但离开执行 section 或关闭对话框时不完整的执行配置会回退到上次有效值。若产品上有意让执行 section 内的半成品也落盘，至少要在 mode 切换时校验完整性，不完整则保留旧 mode 只存 apiProtocolConfigs 草稿。

---

#### 27. 全局 Escape 不检查 defaultPrevented：关 Radix 下拉/connector 抽屉时一并拆掉整个设置页

- **位置**：`apps/studio/src/canvas/components/SettingsDialog/SettingsDialog.tsx:1128`
- **类别**：功能缺陷　·　**区域**：设置页迁移区　·　**验证置信度**：high

**证据**　1125-1132 行：`function onKey(e){ if (e.key !== 'Escape') return; onClose(); } document.addEventListener('keydown', onKey)`——无 `e.defaultPrevented` 检查。已实测验证依赖链：radix-ui 的 useEscapeKeydown 以 `{capture:true}` 挂在 document（node_modules/@radix-ui/react-use-escape-keydown/dist/index.mjs），DismissableLayer 消费 Esc 时 `event.preventDefault(); onDismiss()`（react-dismissable-layer/dist/index.mjs 63-65 行）——capture 先于 bubble，事件到达本监听器时 defaultPrevented=true 但代码照样 onClose()。第二受害者：ConnectorsBrowser.tsx 1313-1319 行 connector 抽屉的 Esc 处理器用 `e.stopPropagation()` 试图保护外层——但 stopPropagation 对同一节点（document）上的其他监听器无效，且 SettingsDialog 的监听器注册更早、先执行，抽屉的防护完全落空。

**影响**　07-04 Radix Select 换装引入的回归：执行模式面板的模型/推理/快速填充/图片模型任一下拉展开时按 Esc（关闭下拉的肌肉记忆），整个设置页被拆掉回到主界面；连接器详情抽屉开着按 Esc 同样连环关闭。用户正在填的 BYOK 表单视角直接丢失（autosave 保住数据但页面上下文全没了），且原生 select 时代 Esc 只关下拉、不冒泡到页面，行为回退。

**优化方案**　SettingsDialog 的 onKey 开头加 `if (e.defaultPrevented) return;`——Radix 系（Select/Dialog/Popover）自动被豁免。对 connector 抽屉与其他手写弹层：把它们的 Esc 监听改为 `document.addEventListener('keydown', onKey, {capture:true})` 并在处理时调用 `e.preventDefault()`（capture 先跑，preventDefault 后外层 bubble 监听器读到 defaultPrevented 即跳过），删除无效的 stopPropagation。

---

#### 28. MCP section 的 dirty 防护未接线：切 section/关设置页静默丢弃未保存草稿

- **位置**：`apps/studio/src/canvas/components/SettingsDialog/SettingsDialog.tsx:2809`
- **类别**：正确性　·　**区域**：设置页迁移区　·　**验证置信度**：high

**证据**　SettingsDialog 渲染 `{activeSection === 'mcpClient' ? <McpClientSection /> : null}`（2809 行）——不传 ref 也不传 onDirtyChange，而 McpClientSection 专门为此暴露了 `McpClientSectionHandle{save,hasDirty}` 与 `onDirtyChange` prop（McpClientSection.tsx 42-50 行，注释"Surface the dirty/save state up to the dialog footer so a single Save button can drive both"）。SettingsDialog.tsx 343-344 行注释还声称"The dialog footer Save routes through this when the MCP tab is active"，但 footer Save 已删除，该 handle 全仓无人消费（IntegrationsView.tsx 123 行同样裸渲染）。条件渲染意味着切换侧栏 section 即卸载组件，所有本地 rows 草稿（新增的模板行、填了一半的 env/headers/token）直接丢失。

**影响**　设置页其余所有 section 都是 400ms autosave，唯独 MCP 是显式 Save——用户被其他面板训练出"改了就自动存"的预期后，在 MCP 面板加了服务器、填好 API token，顺手点侧栏别的项（或按 Esc、点返回），全部编辑零警告蒸发。与 finding 2 叠加（下拉开着按 Esc 整页关闭）时丢失面更大。

**优化方案**　把已有的基建接上：SettingsDialog 持一个 `useRef<McpClientSectionHandle>` + `mcpDirty` state，渲染时传 `ref` 与 `onDirtyChange={setMcpDirty}`；在 `setActiveSection` 与 Escape/onClose 路径上，若 `mcpDirty` 先弹确认（沿用 MediaProvidersSection 的 window.confirm 惯例即可："MCP 服务器有未保存的修改，离开将丢弃"），或者更彻底——把 MCP 保存也并进 autosave 流（rows 签名变化即 debounce 调 saveMcpServers），消灭这个孤岛交互。

---

#### 29. newProjectRequest 一次性 pending 标志泄漏，导致下次进首页误弹「新建项目」弹窗

- **位置**：`apps/studio/src/canvas/components/home/EntryShell.tsx:391`
- **类别**：功能缺陷　·　**区域**：canvas 状态与运行时　·　**验证置信度**：high

**证据**　EntryShell 的 effect（389-394 行）双通道消费 newProjectRequest 信箱：挂载分支 `if (consumeNewProjectRequest()) openNewProject();`（会清 pending），事件分支 `const onRequest = () => openNewProject();`——**事件分支只开弹窗、从不调 consumeNewProjectRequest()**。而 requestNewProject()（state/newProjectRequest.ts:20-23）总是先 `pending = true` 再 dispatch 事件。openNewProject()（422-425 行）也只是 setState 开弹窗，不碰 pending。

**影响**　当 AppRail 的「新建项目」按钮在 EntryShell **已挂载**时被点击（首页停留态，常见路径）：requestNewProject 置 pending=true + 派发事件 → onRequest 开弹窗，但 pending 残留为 true 永不清。随后用户关掉弹窗、导航进某个项目（EntryShell 卸载）、再返回首页（EntryShell 重挂载）→ 挂载 effect 的 consumeNewProjectRequest() 读到残留的 true → 无缘无故再弹一次「新建项目」弹窗。属于「异步事件 + 未清一次性标志」泄漏。

**优化方案**　让事件分支也吃掉一次性标志，避免残留：`const onRequest = () => { consumeNewProjectRequest(); openNewProject(); };`。这样无论按钮点击时 EntryShell 是否已挂载，pending 都在这一次被消费干净，下次重挂载不会误触发。

---

#### 30. 记忆总开关保存失败不回滚，UI 与 daemon 状态永久发散（隐私向）

- **位置**：`apps/studio/src/canvas/components/memory/MemorySection.tsx:1340`
- **类别**：功能缺陷　·　**区域**：canvas 组件：文件/项目/插件/记忆　·　**验证置信度**：high

**证据**　`const onToggleEnabled = useCallback(async (next: boolean) => { setEnabled(next); await setMemoryEnabled(next); }, []);`（L1340-1343）——setMemoryEnabled 返回的 resp.ok 被完全忽略。紧挨着的 onToggleChatExtraction（L1345-1349）做了正确处理：`const ok = await setMemoryChatExtractionEnabled(next); if (!ok) setChatExtractionEnabled((current) => !current);`，同一作者在相邻函数里知道要回滚，唯独总开关漏了。

**影响**　PATCH /api/memory/config 失败（daemon 重启窗口、网络抖动）时：用户点「关闭记忆」→ UI 显示已关（整个 section 变 is-disabled、banner 提示已禁用），但 daemon 仍在对每轮聊天做记忆提取——用户以为关掉了隐私采集实际没关。反向同理。直到下次 reload 前状态一直是错的，且 `enabled` 还 gating 扫描按钮等一串 UI。

**优化方案**　与 onToggleChatExtraction 对齐：`const ok = await setMemoryEnabled(next); if (!ok) setEnabled((current) => !current);`（或回滚到 next 取反前的值并弹 connectorError 类提示）。一行改动，消除隐私敏感的状态发散。

---

#### 31. fetchMemoryList 失败时伪造「enabled:true + 空 entries」默认值，瞬时 500 会把面板刷成假状态

- **位置**：`apps/studio/src/canvas/components/memory/MemorySection.tsx:169`
- **类别**：正确性　·　**区域**：canvas 组件：文件/项目/插件/记忆　·　**验证置信度**：high

**证据**　`async function fetchMemoryList() { const resp = await fetch('/api/memory'); if (!resp.ok) { return { enabled: true, chatExtractionEnabled: true, rootDir: '', index: '', entries: [], extraction: null }; } ... }`（L169-182）。reload()（L812-823）无条件把这份伪造响应写进所有 state：setEnabled(true)、setEntries([])、setRootDir('')。且 reload 不止 mount 时跑——SSE `/api/memory/events` 的每个 change 事件都触发（L873-884）。另外 fetch 网络异常时此函数不 catch，reload 整体 reject 被 `void reload()` 吞掉（unhandled rejection）。

**影响**　daemon 瞬时返回 500（重启中、索引重建）时：用户已禁用记忆 → 面板突然显示「已启用、0 条记忆」；已有几十条记忆 → 列表清空，用户以为数据全丢。若用户此刻基于假状态操作 toggle，会把错误状态真正 PATCH 回 daemon。

**优化方案**　fetchMemoryList 在 !resp.ok 时返回 null（与 fetchMemoryEntry 的约定一致），reload 里 `const list = await fetchMemoryList(); if (!list) return;` 保留上一次已知状态，不用伪造默认值覆盖；可选加一个轻量 error banner。同时给 reload 外层加 try/catch 消除 unhandled rejection。

---

#### 32. MCP 服务器 ID 撞车时保存后第二台服务器被静默吞掉

- **位置**：`apps/studio/src/canvas/components/settings/McpClientSection.tsx:274`
- **类别**：功能缺陷　·　**区域**：设置页迁移区　·　**验证置信度**：high

**证据**　`validateRow`（274-292 行）只校验 ID 字符模式（`ID_PATTERN.test(r.id)`）与 command/URL 必填，不查跨行重复；ID 输入框自由编辑（879-884 行 `onChange={(e) => onChange({ id: e.target.value })}`）。daemon 侧 `sanitizeMcpConfig` 按 id 静默去重（apps/daemon/src/mcp-config.ts：`if (seen.has(ok.id)) continue; // de-dupe by id`），不报错。保存成功后 UI 用 daemon 回包整体覆盖本地行：`const fresh = rowsFromServers(data.servers); setRows(fresh);`（406-407 行）——重复 id 的第二行连同其 command/args/env/headers 全部从界面消失，无任何提示。

**影响**　用户配了两台服务器（例如从同一模板加两个实例后手动改 ID 时不慎改成同名，或把 A 行 id 改成 B 行的 id），点 Save 显示成功，但第二台服务器及其全部配置（含手填的 token/env）静默蒸发，用户需要从头重配——典型的"保存成功却丢数据"。

**优化方案**　在 `save()` 的逐行校验后追加重复检测：`const ids = new Set(); for (const r of rows) { if (ids.has(r.id)) { setError(`Duplicate server ID: ${r.id}`); return false; } ids.add(r.id); }`（放在 validateRow 循环内即可复用现有 error 展示条）。这是纯前端 5 行修复，比改 daemon 语义（拒绝而非去重）风险低且立即挡住数据丢失。

---

#### 33. canvas 的 system 主题钉死 data-theme 又不订阅 matchMedia，OS 明暗切换在画布面漏更新

- **位置**：`apps/studio/src/canvas/state/appearance.ts:70`
- **类别**：功能缺陷　·　**区域**：canvas 状态与运行时　·　**验证置信度**：high

**证据**　applyAppearanceToDocument 在 system 分支里显式写死 data-theme（第 61-73 行）：`const dark = window.matchMedia('(prefers-color-scheme: dark)').matches; root.setAttribute('data-theme', dark ? 'dark' : 'light')`——只读一次快照，之后不再跟。而 canvas/App.tsx 的 useLayoutEffect 依赖是 `[config.theme, config.accentColor]`，OS 翻明暗时两者都不变，applyAppearanceToDocument 不重跑；canvas AppRoot/App 全树没有任何 `matchMedia(...).addEventListener('change', ...)` 订阅（grep 确认只有一次性读取）。同时 canvas CSS 的兜底分支 `@media (prefers-color-scheme: dark){ html:not([data-theme]){...} }`（base.css:212）被这次显式钉的 data-theme 永久压掉。对照 chat 侧 appearance.applier.ts:60-64 是有 matchMedia change 监听并双写 .dark + data-theme 的。

**影响**　用户处于「system」主题、且当前会话从未打开过 chat tab（SurfaceHost 惰挂：默认路由 `/` 是 canvas，`visited.current.chat` 为 false，chat 的 applier 及其 matchMedia 监听尚未挂载）。此时切换 macOS/系统外观明暗，画布面既拿不到 CSS @media 兜底（data-theme 被钉住），也没有 JS 监听重写标记，整个画布停在旧明暗，直到刷新、手动改主题、或首次进 chat 才自愈。

**优化方案**　在 canvas 根（canvas/App.tsx，与现有 od:appearance-changed 那个 effect 同级）加一个独立 effect：当 `config.theme === 'system'` 时 `const mql = window.matchMedia('(prefers-color-scheme: dark)')`，监听 `change` 事件重新 `applyAppearanceToDocument({ theme: 'system', accentColor: config.accentColor })`，卸载时移除监听；deps 含 config.theme/accentColor。这样与 chat applier 的 matchMedia 订阅对称，OS 明暗切换在任一面单独可见时都能即时跟。不要走「system 时不钉 data-theme」的路子——appearance.ts 头注释解释了钉 data-theme 是压 chat CSS 兜底所必需的，JS 监听是更安全的补法。

---

#### 34. 幻灯片预览的 ←/→ 翻页 window 监听漏判 contentEditable，在聊天输入框移动光标会连带翻页

- **位置**：`apps/studio/src/chat/components/chat/LivePreviewEditor.tsx:830`
- **类别**：功能缺陷　·　**区域**：chat 组件层　·　**验证置信度**：high

**证据**　`const onKey = (e: KeyboardEvent) => { const t = e.target as HTMLElement | null; if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return; if (e.key === 'ArrowLeft') stepSlide(-1); ... }; window.addEventListener('keydown', onKey)`（L827-836）。守卫只认 TEXTAREA/INPUT，而聊天 composer 是 ProseMirror contenteditable div（ProseMirrorComposerInput.tsx L25「with a contenteditable ProseMirror editor」），tagName 是 DIV。slides 模式下 LivePreviewEditor 与 composer 同屏共存（ThreadView 左聊天列 + 右 SlidesWorkspace）。

**影响**　用户在幻灯片预览打开时于聊天输入框编辑文字，按 ←/→ 移动光标，每按一次右侧预览就翻一页并触发 loadSlide fetch + followLatest 状态变化——光标照常移动（未 preventDefault），但预览页面在背后乱跳，用户pin住的页码丢失；打字修改长 prompt 时几乎必踩。

**优化方案**　守卫补上 contentEditable：`if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable || t.closest?.('[contenteditable="true"]'))) return`。更稳的做法是把监听挂到本组件根元素（tabIndex=-1 + focus 管理）或仅在 document.activeElement 位于预览面板内时响应。

---

#### 35. 全组件零 isComposing 守卫：拼音输入按 Esc 取消候选会中断整个 AI 回合，Enter 确认候选会误触发提交类动作

- **位置**：`apps/studio/src/chat/components/chat/ThinkingSpinner.tsx:101`
- **类别**：功能缺陷　·　**区域**：chat 组件层　·　**验证置信度**：high

**证据**　ThinkingSpinner：`const onKey = (e) => { if (e.key !== 'Escape') return; e.preventDefault(); void window.chatApi.abort({ sessionId }) }; window.addEventListener('keydown', onKey)`（L101-107），无 `e.isComposing` 检查、无焦点作用域。grep 证实整个 chat/components 目录 0 处 isComposing（`grep -rn isComposing` 无命中）。同族：SessionSearchDialog.tsx L197 `e.key === 'Enter' → pick(rows[selected])`、ThreadView.tsx ChatHeader 重命名 L990 `Enter → commitEdit`、ThreadListSidebar.tsx L484 `Enter → submitEdit`。中文输入法在 Chromium 里确认/取消候选会派发 isComposing=true 的 Enter/Escape keydown。

**影响**　这是中文优先的产品：① 冷启动前 30s（ThinkingSpinner 挂载的 pre-content gap 正是最长的窗口）用户在 composer 打拼音、按 Esc 清掉候选栏 → 当前回合被 abort；② ⌘K 搜索框里打中文按 Enter 上屏 → 直接跳转到高亮会话，输入被截断；③ 重命名会话时 Enter 上屏 → 半截拼音标题被提交保存。

**优化方案**　建立统一约定：所有自绘输入/全局键盘 handler 开头加 `if ((e as KeyboardEvent).isComposing || e.keyCode === 229) return`（React 事件用 e.nativeEvent.isComposing）。ThinkingSpinner 的 Esc-abort 还应加目标守卫（焦点在 input/textarea/contenteditable 时至少确认非合成状态），四处一次修完：ThinkingSpinner L101、SessionSearchDialog L189、ThreadView L989、ThreadListSidebar L483。

---

#### 36. 图片 lightbox 全屏 backdrop-blur-2xl 叠加 opacity 入退场动画，复现本仓库已归档的全屏模糊掉帧反模式

- **位置**：`apps/studio/src/chat/components/chat/ThreadView/ImagesPanel.tsx:473`
- **类别**：性能　·　**区域**：chat 组件层　·　**验证置信度**：high

**证据**　`<motion.div className="absolute inset-0 bg-background/60 backdrop-blur-2xl" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, ... }} transition={{ duration: 0.28 }} />`（L472-478）——全窗口 scrim 同一元素上同时挂重度 backdrop-filter（2xl≈40px）与 opacity 补间。同仓库 SessionSearchDialog.tsx L217-221 对同样场景的注释写明教训：「a full-window backdrop-filter re-samples the blur EVERY FRAME of the opacity fade… it single-handedly made the open animation stutter」，并因此刻意改用纯色 scrim；2026-07-03 的搜索弹窗卡顿 error 记录也是同一根因。

**影响**　打开/关闭图片大图预览的 0.28s 内每帧对整个视口重采样 40px 模糊，与共享元素 FLIP 飞行动画叠加，低端 GPU / 大窗口下开合动画明显卡顿掉帧；生成图片阶段用户会频繁开关 lightbox，体感放大。

**优化方案**　两选一：① 按 ⌘K 弹窗的定论把 scrim 换成纯色加深（bg-background/80，去掉 backdrop-blur-2xl），磨砂感由卡片自身的 bg-card 承担；② 保留磨砂但避免逐帧重模糊——blur 层不参与 opacity 动画（静态挂载），入场淡入放在其上叠加的一层纯色 tint 上。UserMessage.tsx L451-463 的同款 lightbox（backdrop-blur-lg + opacity 动画）建议一并处理。

---

#### 37. 文件 tab 流式写入时每个 delta 对全文重跑 hljs 高亮，O(n²) 主线程开销；未知扩展名还落到最贵的 highlightAuto

- **位置**：`apps/studio/src/chat/components/chat/ThreadView/WrittenFilesPanel.tsx:337`
- **类别**：性能　·　**区域**：chat 组件层　·　**验证置信度**：high

**证据**　`const html = useMemo(() => { ... if (language && hljs.getLanguage(language)) return hljs.highlight(file.content, ...).value; return hljs.highlightAuto(file.content).value }, [file.content, language, renderRich])`（L337-347）——流式期间 file.content 每个 delta 都变，memo 每次对**全量内容**重高亮。languageFromPath（codeViewUtils.ts）未覆盖的扩展（.txt/.csv/.log 等）走 highlightAuto（对全部 common 语法库逐一打分）。同仓库 AssistantMarkdown.tsx L554-558 的注释已明确记录「自动探测是 highlight.js 最贵的路径…是切换卡顿的主要成本之一」并刻意关掉了它；ToolCallCard 的 CodeFileView（L950-954）在历史恢复整屏 mount 时也有同样的 highlightAuto 兜底。

**影响**　slides 会话里 AI 流式写一个几千行的非 markdown 文件（如 .html/.py 工具脚本）且用户停在文件 tab（组件默认 auto-follow 最新写入）时：第 k 个 delta 重新高亮前 k 段全部内容，尾段单次可达数十 ms，叠加每 delta 的 React 渲染，整个写入过程 UI 掉帧、输入迟滞；扩展名不在映射表时成本再放大数倍。

**优化方案**　流式期间跳过高亮：`if (file.streaming) return escapeHtml(file.content)`（或 null 走纯文本 <pre>），仅在 `streaming` 翻 false 后跑一次完整 highlight——用户在跟随尾部滚动时本来也看不清着色。同时把 highlightAuto 兜底改为直接 escapeHtml（与 AssistantMarkdown 的 detect:false 决策对齐），CodeFileView L953 同改，消除历史恢复时的批量探测。

---

#### 38. appearance 每次 set() 无节流全量推 daemon + 自回声 re-GET，颜色拖动时风暴且乱序回包会回滚新值

- **位置**：`apps/studio/src/chat/stores/appearance.ts:316`
- **类别**：竞态　·　**区域**：chat 状态层与 hooks　·　**验证置信度**：medium

**证据**　L316-319 `useAppearanceStore.subscribe(() => { if (isHydrating) return; pushAppearanceToDaemon() })` 对任何 set() 都触发；SettingsView 的 `<input type="color" onChange={(e) => onChange(e.target.value)}>`（SettingsView.tsx L674）和 Contrast Slider 在拖动时每个 input 事件都调 patchTheme → 每 tick 一次 IPC+daemon PUT。PUT 成功后 L306 dispatch 'od:appearance-changed'，而 chat 自己的 App.tsx L111 也监听该事件 → `hydrateAppearanceFromDaemon()` 再 GET 一次自己刚写的数据；canvas 侧监听器再 GET 一次。hydrate（L261-274）拿到回包后无版本比较、无条件 setState 采纳 remote。

**影响**　拖动取色器/对比度滑杆时每 tick 产生 1 次 PUT + 2 次 GET（经 main 反代到 daemon HTTP），主进程和 daemon 被打满；更糟的是 GET 回包乱序：早先 PUT 触发的 echo-GET 在用户已拖到新值之后返回旧快照，hydrate 无条件采纳 → 界面颜色闪回旧值（下一个 PUT 的 echo 再拉回来，肉眼可见抖动）。若最新一次 PUT 恰好失败（daemon 瞬断），旧 echo-GET 覆盖本地后不会再推回（isHydrating 抑制），用户的修改被静默回滚丢失。

**优化方案**　三点：① pushAppearanceToDaemon 加 trailing debounce（~200ms）+ in-flight 去重（上一个 PUT 未返回则合并等待），拖动结束只落一次写；② 自己 dispatch 的 'od:appearance-changed' 带 `detail: { source: 'chat' }`，App.tsx 的 onSameDocChange 跳过 source==='chat' 的事件，消掉自回声 GET（canvas 仍收到）；③ hydrate 采纳 remote 前与当前 snapshotForDaemon 比较，相同则跳过 setState（顺带避免每次 hydrate 都换 light/dark 引用触发 applier 重写 inline token）。

---

#### 39. 被中断/出错的回合永不结算未完成 tool-call part，四个全量扫描 hooks 把它们当「永远在跑」

- **位置**：`apps/studio/src/chat/stores/chat.ts:1125`
- **类别**：功能缺陷　·　**区域**：chat 状态层与 hooks　·　**验证置信度**：high

**证据**　endAssistantMessage（L837-848）只翻 streaming/turn* 标志，从不结算未完成的 tool-call part；runtime 侧 'end'/'error' 事件也只调 endAssistantMessage（FusionRuntimeProvider.tsx L1243-1248）。而多个 hooks 对整个 transcript 做无回合作用域的扫描：useTurnActivity L1125 `if (p.result === undefined && typeof p.toolName === 'string') { runningTool = p.toolName; runningToolStartedAt = p.startedAt }`（任何历史回合的无 result part 都算 running）；useStreamingAskArgsText L1182 `p.argsComplete !== true`（中断的 AskUserQuestion 永远匹配，且取 transcript 里第一个匹配，会遮蔽后来新流式的问题）；useImageFeeds L1615 `typeof p.endedAt !== 'number'` → generating 永真；usePendingAskTiming 的 endedAt 永 undefined → 画布问题页计时器永远走。

**影响**　用户在工具执行中按 Esc 中止、或 fusion-code 崩溃触发 'error' 事件后，该 tool-call part 永远没有 result/endedAt/argsComplete。此后同会话每个新回合里，composer 状态条都会命中这个陈旧 part：显示错误的活动标签（如「执行中…」）和荒谬的耗时（从陈旧 startedAt 起算，几百上千秒），而且因为 runningTool 非空，连流式输出散文时本应隐藏的状态条也一直显示。slides 模式下：中断的 AskUserQuestion 留下永久的幽灵「问题」tab（无 requestId、无法回答也无法关掉，且新问题流式预览被它遮蔽）；图片 tab 的 generating 卡死为 true。

**优化方案**　在 endAssistantMessage 的 updater 里加一次结算清扫：遍历 slot.messages，对每个 `type==='tool-call'` 且缺 result 的 part 补 `endedAt ??= Date.now()`、`argsComplete = true`（可另加 interrupted 标记供卡片显示 ⊘），返回新数组。同时把 useTurnActivity L1125 的 running 判定改成 `p.result === undefined && typeof p.endedAt !== 'number'`（endedAt 已被清扫补上即视为 settled）。useStreamingAskArgsText/useImageFeeds/usePendingAskTiming 分别依赖 argsComplete/endedAt，清扫落地后自动修复。另建议 useStreamingAskArgsText 改成取最后一个匹配（与 usePendingAskTiming 的 'last wins' 语义一致），防御同类残留。

---

#### 40. 四个 slot 更新器的 changed 标志提升到外层 map，首个命中后所有后续消息被无谓换新引用

- **位置**：`apps/studio/src/chat/stores/chat.ts:624`
- **类别**：性能　·　**区域**：chat 状态层与 hooks　·　**验证置信度**：high

**证据**　appendToolCallArgsDelta L624-640：`let changed = false; const messages = slot.messages.map((m) => { ...const parts = (...).map((p) => { if (匹配) { changed = true; ... } return p }); if (!changed) return m; return { ...m, content: parts } })`。changed 在第 k 条消息命中后保持 true，第 k+1..n 条消息即使 parts 全是原引用也走 `return { ...m, content: parts }` —— 消息对象和 content 数组全部换新身份。同一模式复制在 finalizeToolCall（L652）、updateToolCallResult（L744）、updateToolCallTasks（L774）。

**影响**　高频路径 updateToolCallTasks 最疼：后台 Workflow/Task（run_in_background）的 task_update 进度事件持续到达，而它挂靠的 Task 卡片在 transcript 中间、后面还在不断追加新消息 —— 每个 task_update 事件把 Task 卡之后的所有消息全部换引用，assistant-ui 按消息引用做的 memo 全部失效，这些行（含 markdown 重渲染）整体重渲染一次。长 transcript + 长跑子代理场景下流式期间出现可感知卡顿。tool_use_delta（每 token 一次）与 tool_result 命中尾部消息时影响小，但同样浪费。

**优化方案**　四处统一改成内外两个标志：内层 `let msgChanged = false`（在 part 匹配处置 true），`if (!msgChanged) return m; changed = true; return { ...m, content: parts }`；外层 changed 只用于最后 `if (!changed) return slot` 的短路。语义完全不变，未命中的消息保持原引用。

---

#### 41. dist:*（宣称全量发布）只重建 contracts/registry-protocol 两个预构建包，漏掉同样被打进产物的 host/platform/plugin-runtime/sidecar/sidecar-proto/diagnostics/agui-adapter——改这些包源码后本地发版静默打进陈旧代码

- **位置**：`package.json:21`
- **类别**：正确性　·　**区域**：workspace 包与构建链　·　**验证置信度**：high

**证据**　根 package.json:21 `"prebuild:resources": "bun run --filter='@open-design/contracts' build && bun run --filter='@open-design/registry-protocol' build && bun run --filter='@open-design/daemon' build && bun run --filter='@claude-desktop/studio' build:next"`。但 daemon 源码实际 import 的 dist 包远不止这两个（grep 实测：plugin-runtime 6 处、sidecar-proto 5 处、platform 5 处、diagnostics 2 处、sidecar 1 处、agui-adapter 在 server.ts），prebundle-daemon.mjs 用 esbuild `bundle: true` 把这些包的 dist/index.mjs 全部内联进 daemon-cli.mjs；studio 前端另有 13 处 import '@open-design/host'（也是 types/main 指 dist 的预构建包），被 next build 内联进静态导出。这 6 个包只在 `bun install` 的 root postinstall 里构建，daemon 的 `build` 只是 `tsc -p tsconfig.json`（不重建依赖）。

**影响**　本地改了 packages/platform、packages/sidecar 或 packages/host 的源码后跑 `bun run dist:mac`（CLAUDE.md 明文说发版必须走 dist:*），打进安装包的 daemon bundle / 前端仍是上次 postinstall 时的旧 dist——零报错、typecheck 也过（读的同一份陈旧 .d.ts）。这正是仓库反复踩过的『build:mac 产物新鲜度』坑在 dist:* 里的新变种：dist:* 给人『全量重建』的安全感，实际只覆盖 8 个预构建包里的 2 个。CI 因为 fresh checkout + postinstall 全建不受影响，只咬本地发版。

**优化方案**　把 prebuild:resources 的重建清单补齐为全部 dist 型 workspace 包（与 scripts/postinstall.mjs 的 buildTargets 对齐），最省事的写法是复用 postinstall 的构建段：`"prebuild:resources": "node ./scripts/postinstall.mjs && bun run --filter='@open-design/daemon' build && bun run --filter='@claude-desktop/studio' build:next"`（postinstall 本身按叶→根顺序建 contracts/host/registry-protocol/agui-adapter/plugin-runtime/sidecar-proto/sidecar/platform/diagnostics，天然覆盖且顺序正确）；同时把根 package.json //note-dist 注释里『契约包(contracts/registry-protocol)』的表述改成『全部 dist 型包』，避免下一个人照旧只加两个。

---

#### 42. html.high-contrast 档只按暗色调值，亮色主题下开高对比反而让全 app 次级文字近乎不可见

- **位置**：`packages/design-tokens/tokens.css:260`
- **类别**：正确性　·　**区域**：CSS 双面泄漏审计　·　**验证置信度**：high

**证据**　tokens.css:260-265 `html.high-contrast { --border: 0 0% 32%; --input: 0 0% 32%; --ring: 210 100% 70%; --muted-foreground: 0 0% 80%; }`——注释自述「Ring stays on Apple Bright Blue, just luminance-lifted」，整套值是给暗底设计的（80% 亮度文字在 10% 亮度暖黑底上是提对比）。但挂类逻辑不分主题：appearance.applier.ts:163 `root.classList.toggle('high-contrast', overrides.contrast >= 60)`，且 :52 `applyThemeOverrides(root, isDark ? dark : light)` 说明 light 主题有自己的 contrast 值，亮色模式下滑杆过 60 同样挂类。亮色 --background 是 240 7% 97%（#f5f5f7），80% 亮度灰字对 97% 亮度底的对比度约 1.4:1。且污染跨面：canvas base.css:62-64 `--text-muted/-soft/-faint` 全部派生自 hsl(var(--muted-foreground))，整个 canvas 面的次级文字一起变淡。

**影响**　亮色主题用户把「对比度」滑杆调过 60（这是给视障用户的可及性功能），结果两面所有 muted 文字（时间戳、提示语、settings 说明文案、canvas 的 text-muted 系）从 40% 亮度灰直接跳到 80% 亮度灰，在近白底上几乎隐形——高对比开关起了反效果；--ring 的 70% 亮蓝 focus 环在白底上同样对比不足。

**优化方案**　把 high-contrast 档按明暗拆两套值：保留现块作为暗色档改成 `html.high-contrast.dark { ... }`（--muted-foreground: 0 0% 80% 等现值），另加亮色档 `html.high-contrast:not(.dark) { --border: 0 0% 45%→32% 可沿用; --ring: 211 100% 35%; --muted-foreground: 240 4% 25%; }`（亮底提对比 = 文字变深不是变浅）。因为 .dark 与 high-contrast 同挂在 html 上，组合选择器零成本；不需要动 applier。

---

### ⚪ 低 (Low)

#### 43. 发版流水线的 bun 版本用 latest 不钉版，bun 行为漂移会让打 tag 发版不可复现

- **位置**：`.github/workflows/build.yml:56`
- **类别**：可维护性　·　**区域**：workspace 包与构建链　·　**验证置信度**：high

**证据**　build.yml:53-56 `uses: oven-sh/setup-bun@v2` + `bun-version: latest`。整条链的关键行为都押在 bun 上：`bun install --frozen-lockfile` 的 trustedDependencies 原生编译（better-sqlite3 ABI 137）、isolated linker 产生的 node_modules/.bun store 布局（prebundle-daemon.mjs 的 findPkgDir 直接 readdir 这个目录，布局变了就 exit 1）、`bun run --filter` 语义（错误记录 2026-06-23 已经踩过 bun 1.3.x --filter 语义变化）。lockfile 冻结只锁依赖版本，锁不住 bun 自身的行为。

**影响**　bun 发一个改动 linker 默认值/store 布局/filter 语义的新版本后，下一次打 v* tag 的发版构建就可能失败（好的情况）或产出布局异常的包（坏的情况），而代码一行没改；两次相同 tag 重跑也可能因为窗口期 bun 版本不同而结果不同。

**优化方案**　把 `bun-version: latest` 钉成与本地开发一致的具体版本（root package.json engines 已声明 `"bun": ">=1.3.0"`，实测环境是 1.3.11，可钉 `bun-version: 1.3.11` 或提交 .bun-version 文件让 setup-bun 读取），升级 bun 时与 lockfile 一起走 PR 显式变更。

---

#### 44. 事件持久化的相邻去重会误吞合法的连续相同文本 delta，重载后转录缺字

- **位置**：`apps/daemon/src/db.ts:1024`
- **类别**：正确性　·　**区域**：daemon 核心服务　·　**验证置信度**：high

**证据**　appendMessageAgentEvent：`const last = events[events.length - 1]; if (last && JSON.stringify(last) === JSON.stringify(event)) { return events; }`——去重发生在 content 追加之前，第二个事件的 textDelta 也被跳过。而流式文本 chunk 完全可能连续相同（重复的 "\n\n"、markdown 表格的 "| " 片段、重复行代码等按 chunk 边界切出相同串），这不是重放而是真实内容。

**影响**　直播时 SSE 两条 delta 都发到了前端显示正常，但持久化转录少了一段；用户刷新/重开会话后从 DB 重建的消息文本与当时看到的不一致（缺重复片段），难以复现、易被当成「历史被截断」的灵异问题。

**优化方案**　去重只应针对真正的重复投递：给持久化事件带上单调递增的 seq（send() 层生成）参与比较，或干脆只对 kind==='status' 保留相邻去重（appendMessageStatusEvent 已单独处理 status），kind==='text'/'thinking' 的 delta 一律追加不去重。

---

#### 45. refreshExternalMcpServers 的去重把 waitForDaemon 语义一并吞掉：等待请求可能被在飞的非等待请求打发走，spawn 落空 MCP 配置

- **位置**：`apps/studio/electron/main/core/engine.ts:525`
- **类别**：竞态　·　**区域**：ChatEngine 核心　·　**验证置信度**：high

**证据**　L525 `if (this.externalMcpRefresh) return this.externalMcpRefresh` 不区分 opts——构造函数在 L506 先发了一个非等待刷新（loadExternalMcpServers 对非等待调用 deadline = Date.now()+0，externalMcp.ts L159，daemon 不可达时单次 fetch 失败即返回 {}）；若 send()/warmup 的 `{waitForDaemon:true}` 调用在它还在飞时到达，就被去重到这个「不等」的任务上，拿到 {} 后继续 spawn。而代码自己的注释（L931-935、L1636-1642）强调：CLI 起来后不再重载 MCP 配置，空缓存 spawn 意味着这个 runtime 整个生命周期都没有 --mcp-config。

**影响**　冷启动 daemon 正在起（端口未监听时 ECONNREFUSED 很快，窗口小；但 daemon 已 listen 而响应慢时 fetchOnce 可挂满 3s 超时，窗口显著）+ 用户快速恢复会话即发消息：该会话的 fusion-code 拿不到用户在设置里配的外部 MCP 服务器，且本轮会话内无法自愈——正是 waitForDaemon 注释声称要防住的场景被去重逻辑绕开。

**优化方案**　让去重感知模式：externalMcpRefresh 旁边记录 `refreshWaits: boolean`；当新请求要求 waitForDaemon 而在飞任务是非等待版时，不直接返回旧 promise，而是链式追加——`this.externalMcpRefresh = task.then(() => (Object.keys(this.externalMcpServers).length ? undefined : loadExternalMcpServers({waitForDaemon:true}).then(s => { this.externalMcpServers = s })))`，即旧任务结束后若缓存仍空再跑一次等待版。反向（等待版在飞、来了非等待请求）维持现状直接复用即可。

---

#### 46. dev 重载的 removeHandler 清单漂移：7 个已注册通道不在清理列表，二次注册必抛错中断后续初始化

- **位置**：`apps/studio/electron/main/ipc/register.ts:218`
- **类别**：功能缺陷　·　**区域**：主进程服务与 IPC handler　·　**验证置信度**：high

**证据**　文件头的清理块（register.ts 218-264）逐条 removeHandler，但后文实际 `ipcMain.handle` 注册的 SESSION_LIST_ACTIVE_RUNTIMES(937)、SESSION_CLOSE_RUNTIME(948)、WORKSPACE_OPEN(1029)、TRANSCRIBE_AUDIO(1060)、LOGS_SUBSCRIBE(1345)、LOGS_UNSUBSCRIBE(1348)、LOGS_REVEAL(1355) 都不在清理列表里。同文件 LANG_CHANGED 的注释明确说这个函数在「dev HMR reloads where this function runs more than once per process lifetime」会跑多次——这正是清理块存在的理由。

**影响**　registerIpcHandlers 第二次运行时，`ipcMain.handle(SESSION_LIST_ACTIVE_RUNTIMES)` 同步抛 'Attempted to register a second handler'，其后所有 handler（tab 管理、appearance、logs、transcribe、settings 后端切换等约 25 个通道）全部注册不上——渲染层对应 invoke 全部 reject，dev 下表现为重载后半个 app 的 IPC 静默失效。手工维护的双清单必然继续漂移（这次已经漏了 7 个）。

**优化方案**　删掉手工枚举，改为在注册前对全部通道常量批量清理：`for (const ch of Object.values(IPC_CHANNELS)) ipcMain.removeHandler(ch)`（removeHandler 对未注册通道是 no-op，对 on 型通道无害；LANG_CHANGED 的 removeAllListeners 保留）。一行代码永久消除清单漂移这一整类 bug。

---

#### 47. 三个孤儿 handler（APPEARANCE_BROADCAST、SETTINGS_CLI_BACKEND_GET/SET）：调用方已随 settings overlay 物理下线，preload 未暴露、前端零引用

- **位置**：`apps/studio/electron/main/ipc/register.ts:1227`
- **类别**：可维护性　·　**区域**：preload 与 IPC 契约一致性　·　**验证置信度**：high

**证据**　register.ts 1227（APPEARANCE_BROADCAST）、1376/1399（SETTINGS_CLI_BACKEND_GET/SET）三个 handler 仍注册，其文档写明的唯一调用方是「settings overlay 的 syncConfigToDaemon / embedded web settings page」——而 1326-1328 行自己的注释确认该 overlay「已随 apps/web 物理下线」。preload/index.ts 没有暴露任何对应方法，grep 整个 src/ app/ 对 'appearance:broadcast' 和 'settings:cli-backend' 零命中。现在 canvas 的 syncConfigToDaemon（src/canvas/state/config.ts 864-866）改走 window 事件 + 已死的 `window.electronSettings?.notifyAppearanceChanged?.()` 可选链 no-op，链路上没人会 invoke 这三个通道。

**影响**　纯死代码但不是零成本：ipc-channels.ts 里 APPEARANCE_BROADCAST 的长注释仍描述一条「settings overlay 直写 daemon 后靠它广播」的活链路，误导后续维护者以为该路径存在；SETTINGS_CLI_BACKEND_SET 是一个能改全局 app 设置并重启所有 runtime 的可调用面，在 finding 1 的 window.electron.ipcRenderer 泄漏下成为多余攻击面（chatApi 从未打算暴露它）。

**优化方案**　删除这三个 handler、对应的 removeHandler 行和 IPC_CHANNELS 常量（及 ipc-channels.ts 里描述 overlay 链路的注释）；CLI backend 的正路已由 engine 绑定的 CLI_BACKEND_GET/SET 覆盖（前端 chatApi.getCliBackend/setCliBackend 各有活跃调用点）。同批可顺手清掉只剩注释引用的死组件 TabBar.tsx / UserInfoBar.tsx（它们调用的 SETTINGS_WINDOW_OPEN 已是 no-op handler）。

---

#### 48. app:// 静态文件路径的 decodeURIComponent 遇畸形百分号编码会抛 URIError，请求变 ERR_FAILED 而非 404

- **位置**：`apps/studio/electron/main/services/appProtocol.ts:66`
- **类别**：正确性　·　**区域**：主进程服务与 IPC handler　·　**验证置信度**：high

**证据**　`const rel = decodeURIComponent(pathname).replace(/^\/+/, '')`（appProtocol.ts 66）没有 try/catch 包裹；pathname 含畸形序列（如 `/%zz`、`/%E0%A4%A`）时 decodeURIComponent 同步抛 URIError，protocol.handle 的 async handler 变成 rejected promise。

**影响**　prod 下页面里任何一个带畸形百分号编码的资源引用（AI 生成的 markdown 链接、拼接出错的 img src 都可能出现），对应请求以 net::ERR_FAILED 失败并在主进程刷 unhandled 错误日志，而不是走到 SPA fallback/404 的正常降级路径；SPA fallback 分支（164 行 fileResponse(staticDir, '/index.html')）不受影响但畸形 URL 的整页导航会直接白屏。

**优化方案**　把 fileResponse 里的 decode 包进 try/catch：`let rel: string; try { rel = decodeURIComponent(pathname).replace(/^\/+/, '') } catch { return null }`——返回 null 让上层落入现有的 404/SPA fallback 分支，畸形 URL 降级为标准 404 而非协议层报错。

---

#### 49. 五个 exposeInMainWorld 仍共用一个 try/catch——第一个抛错会连带静默丢掉 chatApi/tabApi/desktopLogs

- **位置**：`apps/studio/electron/preload/index.ts:597`
- **类别**：正确性　·　**区域**：preload 与 IPC 契约一致性　·　**验证置信度**：high

**证据**　596-608 行：`try { exposeInMainWorld('electron',…); ('api',…); ('chatApi',…); ('tabApi',…); ('desktopLogs',…) } catch (error) { console.error(…) }`。2026-07-03 HostGate 事故的根因之一正是这个结构（当时的修复只给 catch 加了日志前缀，604-607 行注释也自认「任何一个 expose 抛错都会让后续的整体跳过」），结构性问题未除：核心的 chatApi 排在最没价值的 'electron'/'api' 之后。

**影响**　只要第一或第二个 expose 抛错（重复 key、不可序列化值等），排在后面的 chatApi/tabApi/desktopLogs 全部消失，页面侧 HostGate 判定「浏览器直开」，整个 app 不可用——次要对象的失败把核心桥一起拖死，且只有终端里一行 error 可查。

**优化方案**　拆成每个 expose 一个独立 try/catch（或一个 `safeExpose(name, obj)` 辅助函数循环调用），并把 chatApi/tabApi/desktopLogs 排在最前，保证核心桥的暴露不被次要对象的异常连坐。若同时采纳第 1 条 finding 删掉 'electron'，抛错面本身也大幅缩小。

---

#### 50. findPkgDir 在 .bun store 里取『第一个前缀匹配』，store 存在多版本/陈旧残留时可能把错误版本的原生包打进安装包

- **位置**：`apps/studio/scripts/prebundle-daemon.mjs:85`
- **类别**：正确性　·　**区域**：workspace 包与构建链　·　**验证置信度**：high

**证据**　prebundle-daemon.mjs:81-89 `const entries = readdirSync(bunStore); const match = entries.find((e) => e === pkg || e.startsWith(`${pkg}@`))`——对 better-sqlite3/blake3-wasm/bindings/file-uri-to-path 各取 readdir 顺序里的第一个匹配。而这个 store 实测会累积历史版本不清理：当前就同时存着 @anthropic-ai+claude-agent-sdk@0.2.98 / 0.2.141 / 0.3.186、react@18.3.1 / 19.2.5 / 19.2.6 等多版本残留。四个目标包今天恰好各只有一个版本，但只要某次升级让 store 里出现第二个 `bindings@…` 或旧的 `better-sqlite3@…` 残留，find 取哪个取决于 readdirSync 的目录序，可能拷走旧版本（连带旧 ABI 的 .node），后续的存在性检查只验证文件在不在、不验证版本。

**影响**　升级 better-sqlite3（或其依赖链）之后、没删过 node_modules 的机器上本地发版：prebundle 可能静默把 store 里残留的旧版本 .node 打进 Resources/prebundled，daemon 在用户机器上 dlopen 旧 ABI 失败或行为回退到旧版——与已归档的 ABI 事故同一死法，但这次源头是拷贝了错误的 store 目录。CI fresh install 无残留，不受影响。

**优化方案**　不要 readdir 猜目录，改用真实解析：`createRequire(join(repoRoot,'apps/daemon/package.json'))` 后 `dirname(require.resolve('better-sqlite3/package.json'))` 拿到 daemon 实际链接的那个包目录（bindings/file-uri-to-path 则从 better-sqlite3 的目录再 resolve），保证拷的永远是 lockfile 选中的版本；退一步至少在拷贝后读被拷 package.json 的 version 与 apps/daemon/package.json 里钉死的 12.10.0 比对，不一致就硬失败。

---

#### 51. 媒体提供商强制同步失败后无上限重试，daemon 掉线时每 ~2 秒空转且状态永远卡在"保存中"

- **位置**：`apps/studio/src/canvas/components/SettingsDialog/SettingsDialog.tsx:1073`
- **类别**：性能　·　**区域**：设置页迁移区　·　**验证置信度**：high

**证据**　autosave catch 分支（1066-1084 行）：forceMediaProviderSync 失败时 `setAutosaveStatus('pending')` 并 1500ms 后 `setAutosaveRetryTick((tick) => tick + 1)`——effect 依赖 autosaveRetryTick（1096 行）重新跑，又排 400ms debounce 再 persist，失败再进同一 catch。没有重试次数上限、没有退避，只要 cfg 不再变化且 daemon 持续不可达，`400ms debounce + 请求 + 1500ms retry` 无限循环。

**影响**　daemon 崩溃/重启期间用户停在设置页：每 ~2 秒一次失败的 PUT（syncMediaProvidersToDaemon throwOnError + syncConfigToDaemon），网络与日志持续刷错误；autosave 指示器被刻意钉在"保存中/pending"而非 error，用户得不到"存不上"的信号，可能以为已保存而关页。

**优化方案**　给重试加计数与封顶：catch 里维护 `autosaveRetryCountRef`，超过如 5 次后停止调度 retryTimer、`setAutosaveStatus('error')` 让指示器如实报错（成功路径归零计数）；或改为指数退避（1.5s→3s→6s，封顶 30s）。同时 error 态可考虑在指示器旁提供手动"重试"入口，替代无声空转。

---

#### 52. 自动滚动 effect 每个流式 flush 全量拷贝 messages 数组并对整段累计内容做字符串扫描

- **位置**：`apps/studio/src/canvas/components/chat/ChatPane.tsx:486`
- **类别**：性能　·　**区域**：canvas 组件：home/chat/composer　·　**验证置信度**：high

**证据**　effect（:469-508）依赖 `[messages, error, streaming]`，流式期间每个 rAF flush 都跑一遍：`const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant')`（:486）复制整个数组再反转，接着 `lastAssistantMsg?.content.includes('<question-form')`（:487）对流式消息不断增长的完整 content 做 O(n) 扫描；命中时还会 `el.querySelectorAll('.msg.assistant')`。顶部 :384 的 `lastAssistantId` 同款 `[...messages].reverse().find(...)` 每次渲染也复制一遍。PinnedTodoSlot（:1145-1152）每次渲染调 latestTodoWriteInputForPinnedCard 反向扫全部消息 events + JSON.stringify。

**影响**　单独看每项都不致命，但都叠在与 finding 1 相同的 60Hz flush 热路径上：长回复（content 数百 KB）时 includes 扫描随流式进度呈二次方总开销，数组拷贝在长对话下每帧产生垃圾，放大 GC 压力和帧时间。修完 finding 1 后这里会成为下一个热点。

**优化方案**　① 找最后一条 assistant 用倒序 for 循环替代 `[...messages].reverse().find`（:384、:440、:486 三处），零拷贝。② `<question-form` 检测不必扫全文：question form 是完整标签块，只需在文本落地时机（或对 content 的末尾窗口/缓存的布尔 state）判断一次——最简单是在 ProjectView 的 flush 回调里增量检测并把 hasQuestionForm 挂在 message 上，effect 直接读字段。③ PinnedTodoSlot 的 latestTodoWriteInputForPinnedCard+stringify 包 useMemo([messages])。

---

#### 53. 记忆条目预览无陈旧响应守卫，快速切换条目可能显示错误正文

- **位置**：`apps/studio/src/canvas/components/memory/MemorySection.tsx:1032`
- **类别**：竞态　·　**区域**：canvas 组件：文件/项目/插件/记忆　·　**验证置信度**：high

**证据**　`const openPreview = useCallback(async (id: string) => { if (previewId === id) { ... return; } setPreviewId(id); setPreviewBody(null); const entry = await fetchMemoryEntry(id); setPreviewBody(entry?.body ?? ''); }, [previewId]);`（L1032-1045）——await 后直接 setPreviewBody，没有比对「这个响应对应的 id 是否仍是当前 previewId」。

**影响**　用户点开条目 A（请求慢）随即点条目 B（请求快先回）：B 的正文先渲染，随后 A 的响应迟到覆盖 → B 的展开卡片里显示 A 的 markdown 正文。renderExtractionCard 的 writtenIds 按钮（L1518-1527）也走 openPreview，同样中招。数据不损坏但展示错内容，用户可能基于错误正文去编辑/删除。

**优化方案**　在 openPreview 内 capture id 并在写回前校验：组件里加 `const previewReqRef = useRef<string | null>(null);`，openPreview 中 `previewReqRef.current = id; const entry = await fetchMemoryEntry(id); if (previewReqRef.current !== id) return; setPreviewBody(...)`。与本文件其它 fetch effect 的 cancelled 守卫模式保持一致。

---

#### 54. useTurnActivity 的「流散文时隐藏」检查不区分角色，用户消息尾部 text part 也会吞掉状态条

- **位置**：`apps/studio/src/chat/stores/chat.ts:1138`
- **类别**：正确性　·　**区域**：chat 状态层与 hooks　·　**验证置信度**：high

**证据**　L1120-1139 的遍历 `for (const m of s.messages)` 不过滤 role，`lastPartType = p.type` 会被最后一条【用户】消息的 'text' part 命中；随后 `if (runningTool === undefined && lastPartType === 'text') return { active: false, ... }`。而 send 路径（FusionRuntimeProvider L453-471）是 appendUserMessage 后立即 startAssistantMessage 预翻 streaming=true —— 此时 transcript 尾部就是用户的 text part。

**影响**　发送纯文本消息后到第一个 assistant part 到达前（冷启动 3-8s、首回合更久），composer 状态条和随 active 一起出现的绿色边框整段缺席；而带图发送（尾 part 是 image）却会显示「思考中」—— 同一阶段两种行为不一致，说明该分支只想匹配 assistant 的散文尾部而误伤了用户消息。线程内 ThinkingSpinner 仍有兜底反馈，故仅低危。

**优化方案**　遍历时只对 `m.role === 'assistant'` 的消息更新 lastPartType（runningTool/lastSettledAt 的采集本就只可能来自 assistant 消息，不受影响），或在循环外单判「最后一条 assistant 消息的尾 part」。这样开场思考阶段按注释预期显示 active:true + startedAt=turnStartedAt，散文流式时的隐藏行为保持不变。

---

#### 55. chat 链 `* { scrollbar-width: thin }` 全局规则静默禁用 canvas 全部 ::-webkit-scrollbar 定制（含 chat 自己的）

- **位置**：`apps/studio/src/chat/styles/main.css:27`
- **类别**：功能缺陷　·　**区域**：CSS 双面泄漏审计　·　**验证置信度**：high

**证据**　main.css:27-30 `* { scrollbar-width: thin; scrollbar-color: hsl(var(--foreground) / 0.18) transparent; }`（未分层，通配全 document）。Chromium ≥121（本项目 Electron 35 = Chromium 134）的规则是：元素上只要 scrollbar-width/scrollbar-color 为非 auto，该滚动容器的所有 ::-webkit-scrollbar 伪元素样式一律忽略。于是 canvas 侧凡是只写 webkit 伪元素、没同时写标准属性的定制全部死掉：settings-v2.css:129-137 `.sv2-nav::-webkit-scrollbar { width: 8px }` + text-faint thumb、:249-257 `.sv2-content::-webkit-scrollbar { width: 10px }`、plugin-detail-extras.css:235-238 的 thumb 配色。连 main.css 自己 32-59 行那一整段 ::-webkit-scrollbar/track/thumb/corner 也被自家 27 行的 `*` 规则判成死代码。（配了 `scrollbar-width: none` 的隐藏类定制不受影响——类选择器压过通配。）

**影响**　视觉级：settings V2 的导航/内容区滚动条不是设计的 8/10px + text-faint 圆角 thumb，而是全局 thin + foreground/0.18 的样子；插件条 thumb 配色失效。所有失效零报错，且以后任何人再往 canvas 写 ::-webkit-scrollbar 定制都会莫名不生效。

**优化方案**　统一收敛到标准属性这一套：① 删掉 main.css:32-59 的死代码段（::-webkit-scrollbar 全家）；② canvas 侧需要差异化滚动条的地方（.sv2-nav/.sv2-content/plugin rail）改写 `scrollbar-width: thin; scrollbar-color: var(--text-faint) transparent;`，删除对应 ::-webkit-* 规则；③ 在 main.css:27 的 `*` 规则旁补注释说明「本规则会禁用全文档 webkit 滚动条伪元素，新定制一律用标准属性」，防止下次再踩。

---

## 验证阶段拦下的误报

以下条目由审计员报出、但被对抗验证者读代码后驳回——多因触发前提不存在或归因错误。列出以佐证留下的问题经得起推敲。

- **apps/studio/electron/main/ipc/register.ts — 7 个 ipcMain.handle 缺 dev-reload removeHandler 守卫——二次注册会中途抛错、打掉后半段约 30 个通道**
  - 7 个通道确实缺 removeHandler，但触发前提「同进程二次执行」不存在：registerIpcHandlers 只有一个调用点且在 app.whenReady()（每进程一次），而 electron-vite 2.x 的 main 重载实测（node_modules dist 源码 lib-t2ExBjL5.mjs）是 ps.kill()+startElectron 全进程重启（且本项目 dev 未开 --watch，main 改动根本不重建），新进程 ipcMain 为空永不撞「second handler」——注释里的「HMR 下会跑多次」本身是错的，整个 removeHandler 块是死防御代码，缺失只是清单漂移的卫生问题而非可触发 bug。

- **apps/studio/src/canvas/styles/base.css — base.css [data-theme=dark] 镜像的 6 个 shadcn 三元组在级联上反向压住 tokens.css 的 .dark 档，palette 改版时 chat 会被静默钉在旧值**
  - 核心机制被反驳：chat 的 appearance.applier.ts（App.tsx:73 无条件挂载）把这 6 个 token 以 inline style 写在 documentElement 上（第154-160行），inline 优先级压过任何选择器规则——同时覆盖 tokens.css 的 .dark 和 base.css 的 [data-theme=dark]。所以 chat 面这些 token 的运行时取值既不来自 base.css 也不来自 tokens.css，而来自 appearance.ts 的 DARK_DEFAULTS。因此「base.css 镜像在级联上压住 tokens.css 把 chat 钉在旧值」这个断言对 chat 面不成立（两处 CSS 都被 inline 覆盖）；而「只改 tokens.css 后 chat 不变」这一预言其实与 base.css 无关，早已成立（chat 读 inline，不读 tokens.css）。真正的重复源是 appearance.ts 常量，被误归因为 base.css。存在的只是三份暗色 palette 的弱重复（已有配对注释），远弱于所报机制。

- **apps/studio/src/canvas/components/shared/AgentIcon.tsx — 已提交代码引用 /agent-icons/*，但整个 apps/studio/public/ 目录未提交——CI/新 clone 构建出的包所有 agent 品牌图标 404**
  - 核心前提已失效：apps/studio/public/ 的 18 个 agent-icons 文件已全部纳入版本控制（git ls-files 可见，当前 HEAD 7e90f366 "feat(studio): agent icons 资源库" 正是提交该目录的 commit，git status 对该路径干净）——审计者依据的是会话开始时的陈旧 gitStatus 快照。仅剩第 9 行注释写旧路径 apps/web/public/ 属文档小瑕疵，不构成 bug。

---

### 方法说明

Workflow 编排：pipeline 逐区域 fan-out → 每条 finding 并行派独立验证者（对抗式，默认倾向驳回）→ 存活项按严重度排序。审计员 prompt 注入了本项目 CLAUDE.md 声明的刻意不变量与历史踩坑模式，以压低对已知设计的误报。

> 本报告为静态快照，修复前请复核当前代码。