# 微信群聊面板插件 —— 设计与开发说明

> 目标：在 Snow App 侧边栏里提供**微信群聊信息流面板**与**总结面板**。
> 数据全部来自本机已安装的 **wechat MCP server**（im-mcp 的 `wechat-mcp`），面板**只读**。
>
> 本文档同时是「未来扩展方案」与「开发避雷点」清单，写代码前先读它。

---

## 1. 结论：为什么走「面板插件（ESM）」

| 方案 | 结论 |
|---|---|
| **面板插件（`renderMode: "esm"`）** | ✅ 采用。官方结构化入口：右侧面板容器 + 主题/i18n + React 主树渲染，天然满足「信息流 + 总结」双面板需求 |
| 脚本插件（userscript） | ❌ 不采用。定位是「改宿主界面」，不适合承载独立业务面板 |
| 独立本地 HTTP 服务 + `api.net.fetch` | ❌ 不采用（仅作备选）。需额外声明 `network`、额外维护进程，且绕开了宿主已有的 MCP 会话管理 |

**数据桥 = `api.write.mcpTools.call`**，直接复用宿主已装的 wechat MCP 18 个工具，不另起服务。

---

## 2. 已核实的关键契约（Snow App 0.4.27）

### 2.1 面板入口

- 入口被当作 **ES 模块**动态导入，可任选其一：
  - **方式一（推荐）**：`export default function Panel({ api, locale, panelId, panel, pluginId, isActive, inputText })` —— React 组件
  - **方式二**：`export function mount(container, api)` —— 返回清理函数或 `{ unmount }`
- 挂载前宿主注入全局 `window.SnowAppPlugin`，含 `React` / `createElement` / `icons` / `api` / `locale` / `plugin`
- `panels[]` 字段：`id`（必填）、`title`（或 `name`，缺省为 `id`）、`entry`（缺省沿用顶层 `entry`）、`icon`（缺省沿用插件图标）、`widthHint`（原样透传）

### 2.2 MCP 工具调用（本次 spike 的核心）

```js
const res = await api.write.run("mcpTools.call", {
  toolFullName: "wechat-get_sync_status",   // = <serverName>-<toolName>
  args: { /* 工具入参对象 */ },
});
```

- **`toolFullName` 写法已核实**：`toolFullName` 被 `nativeHandlers.ts` 原样透传给 `native.callMcpTool`，无任何 server 前缀拼接。宿主自身调用示例为 `config-list`、`memory-save`、`config-set`，即 **`<serverName>-<toolName>`**。
  - 本机 wechat server 的 `serverId = global:wechat`、`name = wechat` → **`wechat-<toolName>`**，例如 `wechat-get_messages_by_range`。
  - ⚠️ **不要**写成 `global:wechat:xxx`，**不要**写成裸名 `get_sync_status`。
- **`scope = "mcpSecrets"`**（源码 `src/renderer/plugins/writes/domains/admin.ts:1101`）→ 必须在 `plugin.json` 的 `privacy.scopes` 里声明，否则 `denied.reason = "write-declaration-missing"`。
- **⚠️ 动作 id 是「域限定」的**（实测踩坑）：`api.write.domains()` 返回的 `actions[].id` 形如 **`"mcpTools.call"`**，**不是** `"call"`。
  - 调用用 `api.write.run("mcpTools.call", {...})` 或语法糖 `api.write.mcpTools.call({...})`；
  - 自查 `granted` 时必须按**全 id** 匹配 `a.id === "mcpTools.call"`，按 `"call"` 匹配会误判成「动作不存在」。
  - 同理：`conversations.create` / `conversations.sendMessage` / `conversations.activate` 的 scope 都是 `conversations`。
- **MCP 返回需解包**：`api.write.run("mcpTools.call", ...)` 的 `data` 是 MCP 结果信封 —— 优先取 `data.structuredContent.result`，其次把 `data.content[]` 中 `type:"text"` 的 `text` 逐条 `JSON.parse`（多 P 工具如 `list_wechat_sessions` 会返回**多个 text 块**，需合并成数组）。
- 可选参数：`projectId` / `checkpointIds` / `checkpointWorkDir` / `sensitiveAuthorizationToken` / `interactionId` / `subAgentAllowedTools` / `planMode` / `planApproved` / `conversationId`
- 另有 `mcpTools.abort`（需 `toolExecutionId`）与 `mcpTools.writeStdin`（需 `sessionId` + `input`），同为 `mcpSecrets`。

### 2.3 返回结构（`api.write` 永不抛异常）

| 字段 | 说明 |
|---|---|
| `ok` | 是否成功 |
| `action` | `domain.action` |
| `data` | 成功返回值（无返回值时为 `null`） |
| `denied` | `{ reason, scope? }`，`reason` ∈ `write-declaration-missing` / `unknown-action` / `unsupported-runtime` |
| `error` | 失败说明；**参数非法只有 `ok:false` + `error`，没有 `denied`** |

---

## 2.4 前置依赖（硬要求）

**本插件不内置任何微信数据采集能力。** 全部数据来自本机安装的 **wechat MCP 服务器**；
未安装 / 未启用时，两个面板都会显示「需要先安装 wechat MCP」的引导页，而不是空白或报错。

插件启动时执行**四级依赖预检**（`useDependency`），任一级失败即进入引导页：

| 级别 | 检查内容 | 失败判定 |
|---|---|---|
| 1 | 宿主是否提供 `api.write.mcpTools.call` | `kind: "no-host"` |
| 2 | 该动作是否 `granted`（即 `privacy` 是否声明 `mcpSecrets`） | `kind: "no-declaration"` |
| 3 | `api.metadata.get("mcp")` 的 `servers[]` 中是否存在 `name === "wechat"` 且 `enabled !== false` | `kind: "no-server"` / `"server-disabled"` |
| 4 | 真实探针：调用 `wechat-get_sync_status` | `kind: "probe-failed"` |

> 第 3 级拿不到 `servers` 时（字段级剥离 / 宿主差异）**自动跳过**，交给第 4 级真实探针兜底 —— 不把「读不到配置」误判成「没装」。

引导页给出四步安装指引：安装 im-mcp → 管理员运行 `wechat-init` → 在 MCP 设置里添加**名称必须为 `wechat`** 的 stdio 服务器 → 重连后点「重新检测」。

---

## 3. 面板功能设计

> **v0.3.0 起合并为单一面板**（`panels[].id = "wechat"`）；**v0.4.0 起为三个视图**：
> 「信息流 / 总结 / MCP 工具台」，用顶部分段控件切换。
> **群选择与日期范围被信息流与总结共用** —— 不用为看统计再开一个面板标签。
> 下面 3.1 / 3.2 / 3.3 分别描述这三个视图。

### 3.1 信息流视图（`feed`）

- **群选择器**：`wechat-list_wechat_sessions`（可按 keyword / session_type 过滤）
- **时间范围 + 关键词 + 过滤**：`wechat-get_messages_by_range`（带 `offset` 分页）/ `wechat-search_wechat_messages`
- **按天分组**，长列表虚拟滚动；**单次 ≤ 200 条**，用 `offset` 翻页（工具已支持）
- **发言者色块**：wxid 稳定 hash → 固定配色
- **类型徽标**：图片 / 文件 / 引用 / 撤回 / 语音
- **引用消息**渲染成胶囊，可跳原文
- **媒体项**点击走 `panels.openFile` 打开本地文件（来自 `wechat-search_media_files` 返回的磁盘路径）
- 辅助工具：`wechat-list_chatroom_members`（成员名单）、`wechat-list_favorites`、`wechat-list_emoticons`

### 3.2 总结视图（`digest`）—— 两条路径

**① 零 token 快路径（纯前端聚合）**

- `wechat-get_chat_activity_stats` → 活跃 ID 排行、按小时/按天分布
- 本地再聚合：高频词、被 @ 未回复
- 不消耗任何模型 token，打开即出

**② AI 深总结（走 Agent 会话）**

```js
// 建一个带 autoReply 的会话，提示词里让 Agent 自己用 wechat MCP 取数
const r = await api.write.run("conversations.create", {
  directoryId,                       // 当前项目 directoryId
  title: "群总结：<群名> <日期>",
  text: "请用 wechat MCP 工具读取会话 <session_id> 在 <范围> 的消息，总结……",
  autoReply: true,                   // ⚠️ autoReply:true 必须带非空 text
});
// 用 messages 元数据域订阅该会话，把流式回复实时渲染进面板
api.metadata.subscribe("messages", { params: { conversationId: r.data.conversationId } }, (payload) => { /* ... */ });
```

- 流式渲染：thinking 折叠、`toolCallsJson` 显示成「正在调用工具…」
- **结构化图表（v0.14.0）**：提示词要求 Agent 在 Markdown 正文之后追加**一个** `json` 代码块（`topics` / `heat_hours` / `todos` / `risks`）；面板用 ```` ```json ```` 正则提取并 `JSON.parse`，成功则渲染话题条形图、Agent 热度条、待办与风险卡片，失败则只展示 Markdown（不报错）
- **本地词频退场（v0.14.0）**：删除面板侧的 2-gram「高频片段」——语义类指标交给 Agent；本地只保留 SQL 能全量算准的确定性指标（发言人数 / 每小时活跃 / 参与度分桶 / 类型分布 / 24×7 热力）
- 落盘：`filesystem.writeFile`（导出 MD / HTML 长图，v0.31.0 起「存备忘录」出口已移除）；定时：`scheduledTasks.create` + `runNow`；完成通知：`system.notify`；跳转：`conversations.activate`

### 3.3 MCP 工具台视图（`mcp`）—— 让 MCP 能力在面板里可见、可操作

这是 v0.4.0 新增的视图，解决「插件装了 MCP，但用户看不到 MCP 到底能干什么」的问题。

- **工具目录**：`TOOLS` 常量内联 28 个 wechat 工具（`name` / 中文用途 / 默认参数），保证即使读不到宿主的工具清单也能用。
- **参数预填**：展开某工具时，按当前选中的群与日期预填 `session_id` / `chatroom_id` / `start` / `end` / `date`，用户可手改 JSON。
- **调用与展示**：走同一条 `mcpTools.call` 通路；结果显示 `ok|失败`、耗时 ms、返回条数，以及完整返回体（可滚动 `pre`）。
- **写操作护栏**：`sync_wechat_database`（面板显示名「同步微信数据」，默认 `redecrypt: true`）标记 `dangerous`，按钮首次点击只进入「确认执行」态，第二次点击才真正提交。
- **定时同步工具**：`set_auto_sync`（`enabled` select + `interval_minutes` number）与 `get_auto_sync_status`（无参）同样内联在目录里。
- **规模概览**：顶部 pill 显示 `messages / sessions / contacts / media_files / avatars`，来自依赖预检时那次 `get_sync_status`。

> 设计取舍：工具目录**内联**而非从 `api.metadata.get("mcp")` 动态读取 —— 后者字段级敏感且形态随宿主版本变化；
> 内联保证了可用性，代价是新增 MCP 工具时需要同步更新 `TOOLS`。

### 3.4 只读定位（不可破坏）

面板**只读**微信数据；**不提供「从面板发消息到微信」**。所有外发只走 Agent 会话（`conversations.*`）。

---

### 3.5 图片渲染（v0.10.0：直出，无需点击）

> **历史**：v0.6.0 本插件曾自带一套图片模块（`find_message_covers` / `find_message_images` / `read_media_data_url`）。
> 上游 im-mcp 后来合并了等价且更完善的实现（`8620a55`）。**v0.8.0 起完全抛弃我方实现，只调上游工具**，
> 插件不再依赖任何非上游 MCP 工具。**v0.10.0 起改为挂载即直出**（去掉「点击加载」按钮）。

**上游工具契约（实测，源码 `src/wechat_mcp/adapters/images.py:129-279`）：**

```
get_message_image(message_id: int, include_base64: bool = False)
  → 成功 { success:true, message_id, md5, format, size_bytes, file_path, base64? }
      file_path = 解密后的真实图片文件绝对路径（~/.wechat_mcp/images/{message_id}_{md5}.{fmt}）
  → 失败 { error, md5, dat_path, hint }          # V2 缺 image_aes_key 时
  → 非图片 { error: "Message id X is not an image message (local_type=...)" }
```

**渲染链路（`index.js` 的 `McpImage` 组件）：**

1. **直出（v0.10.0）**：`McpImage` 挂载即自动发起调用 —— `const [state, setState] = useState(() => hasId ? { phase:"loading" } : { phase:"none" })` + `useEffect(() => { if (hasId) load(); }, [hasId, messageId])`。密钥已在 `all_keys.json`，解密是确定性操作，**不再有「点击加载」这一步**。
2. **并发闸门** `withImageSlot`（`IMG_CONCURRENCY = 3`）把同时在跑的图片调用限到 3 个 —— 一屏可能挂几十个 `McpImage`，无限并发会打爆 MCP。
3. `mcpTools.call` 调 `wechat-get_message_image({ message_id })` → 成功拿到 `file_path`（真实 `.jpg`）→ 宿主 `window.snow.readFileContent(path)` → `data:` URL → `<img src>`（带 LRU 缓存）。
4. 失败 → 显示 `error` + 上游 `hint`，并提供「重试」与「打开原文件」（用返回的 `dat_path`）。
5. ⚠️ **不要退回「点击展开」**：需求方已明确「既然已经拿到密钥就应该直接展示」。`swf-imgchip` 样式与 `idle` 分支已在 v0.10.0 删除。

**发言者头像（v0.10.0，`avatarNode`）：** 每次加载信息流后，把本页消息里出现过的 `sender_username` 去重后**一次性**传给上游 `get_user_avatars(usernames)`（一次调用批量返回），再把每个 `file_path` 经 `loadImageDataUrl` 读成 data URL，得到 `{username: dataUrl}`；有头像渲染 `<img className="swf-av-img">`，没有则回退「首字母 + 稳定色」色块，续行留 ghost 占位。缺缓存的成员静默缺失（覆盖率群 53%–100%），**不要为此报错或阻塞渲染**。

**手动同步（v0.10.0）：** 顶栏「同步微信数据」按钮 → `callToolRaw(api, "sync_wechat_database", { redecrypt: true })` → 成功后 bump `sessionsNonce`（触发群列表重取）并 `loadFeed()`，同时显示绿条 / 红条提示。

**⚠️ Hooks 顺序铁律（v0.10.1 修掉的真实崩溃）：** 所有 `useState` / `useEffect` / `useMemo` / `useCallback` **必须写在组件的任何提前 `return` 之前**。v0.10.0 曾把 `runSync`（`useCallback`）追加到 `WechatPanel` 末尾，而该组件在 `dep.phase === "checking" / "blocked"` 时会提前 `return` —— 检测态少一个 hook、ready 态多一个，React 直接抛 **Minified React error #310（Rendered more hooks than during the previous render）**，整个面板白屏。**教训：新增 hook 一律往组件顶部放，绝不图省事追加到函数末尾。**

**参考实现（来自已安装的官方/第三方插件，非猜测）：**

| 插件 | 写法 | 用途 |
|---|---|---|
| `com.github.xqchencn.snow-file-explorer`（官方 ESM 面板） | `const r = await window.snow.readFileContent(path); r.isImage ? "data:" + (r.mimeType \|\| "image/png") + ";base64," + r.content : null` | 本地文件 → `<img src>` |
| `com.seagull.snow-anon-chat` | `"img-proxy://localhost/" + encodeURIComponent(url)` | 外链 http(s) 图片 |

**宿主读盘写法**：与官方 `com.github.xqchencn.snow-file-explorer` 一致 —— `const r = await window.snow.readFileContent(path); r.isImage ? "data:" + (r.mimeType || "image/png") + ";base64," + r.content : null`。本插件**只**对「MCP 解密导出的真实图片文件」用这条通道（**不再有 MCP 回落分支**）。

**已核实契约：**

- `privacy.scopes` 必须含 **`filesystem`**（官方 file-explorer 用的就是该 token；不声明则宿主不注入 `window.snow.readFileContent`）。
- 宿主通道 `workspace-directories:read-file` → `native.readFileContent(filePath.trim())`（`src/main/ipc/handlers/workspaceHandlers.ts:526-531`），**对路径无根目录限制**。
- `native.readFileContent` 按**扩展名**判 `isImage`（`src/main/utils/fileReader.ts:41`，`png|jpg|jpeg|gif|bmp|webp|ico|svg`）；非图片扩展名的二进制返回 `content = base64` + `encoding:"base64"`。
- 因此 `.dat` 拿不到 `isImage` → **必须先由 MCP `get_message_image` 解密导出成真实图片文件**，宿主才能读。
- **md5 定位（上游方式，比我们旧实现更准）**：先查 `decrypted/message/message_resource.db` 的 `MessageResourceInfo`（按 `message_create_time` + `message_local_id`），再回退查 `decrypted/message/{source_file}` 的 `Msg_*` 表（按 `local_id`），从 `packed_info` 里正则抽 32 位 hex。
- 上游密钥来源是 `~/.wechat_mcp/all_keys.json` 的 **`image_aes_key`** 字段（**本机当前不存在**）。

**微信图片的真实存储（全部实测，非推断）：**

- 消息表 `messages(...)` **只有** `content` 占位符 `[图片]`，**没有 md5 / 路径**。
- 原图在 `msg/attach/<chat_hash>/<YYYY-MM>/Img/<md5>.dat`，其中 **`chat_hash == md5(session_username)`**（104/104 命中）。
- `.dat` 容器结构：`[15B 头 = 签名(6) + aes_size(u32LE) + xor_size(u32LE) + pad(1)] + [AES-ECB 段] + [16B 固定标记] + [单字节 XOR 段]`，且 `15 + aes_size + 16 + xor_size == 文件长度`（30/30 精确吻合）。
- **V1 的 AES 密钥是硬编码常量**（`cfcd208495d565ef`）→ 可离线解码；**V2 的 AES 密钥是账号级、只存在于运行中的微信进程内存**。本机 5 万余个 `.dat` **全部是 V2**；DB `enc_key`/`salt`/`md5(wxid)`/全 256 单字节 XOR/已知明文攻击均已实测排除。
- ⚠️ **`cache/<月>/Message/<hash>/Thumb/*.jpg` 是 appmsg 封面图，不是 `[图片]` 消息原图**：844 张里 637 张属链接卡片、62 张视频号、**仅 1 张**属 `type=3`。曾误判为「原图」，已纠正。
- ⚠️ `img-proxy://` **只放行真实图片扩展名**（`png|jpe?g|webp|gif|bmp|svg|ico|avif`）且 ≤512 字符、不含 `..` → `.dat` 必然被拒，**不要**尝试用它绕。

**⚠️ 已知坑（本机实测）：**

- `~/.wechat_mcp/all_keys.json` **没有 `image_aes_key` 字段** → 微信 4.x V2 加密图一律返回
  `{ error: "WeChat 4.x V2 image encryption requires image_aes_key (not currently loaded)", md5, dat_path, hint }`
  （实测 4 条图片消息 `success = 0/4`）。
- md5 定位本身 100% 可用（实测 4/4 命中），卡点只在密钥。
- 上游 `hint` 给的解法：**先在微信客户端打开 1–2 张图片把密钥载入内存，再跑上游图片密钥提取**
  （`key_tool.py`，passphrase 文件 `~/.wcdb-key-tool/`），把 `image_aes_key` 写进 `all_keys.json`。
- 解密依赖 `pycryptodome`（本机已装 4.0.0）。

**「打开原文件」走 `panels.openFile`**：`api.write.run("panels.openFile", { filePath })`，`scope: null`，**必须绝对路径**（`/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/`），不接受 `\0`。

## 3.x 总结与报告：三层分工（v0.17.0）

面板**只有一个** `digest` 视图，不再把「总结」和「报告」拆成两个标签页：

| 层 | 负责 | 具体 |
|---|---|---|
| MCP（通用数据层） | 全量聚合、结构化返回 | `get_chat_activity_stats` 扩展字段、`get_group_digest`、`get_member_profile` |
| 面板（展示层） | 报告类型、趋势粒度、图表、Markdown 拼装 | 日/周/月/年/自定义 → 时间窗；趋势按类型切小时/天/月；成员榜、互动网络、成员画像、报告预览 |
| Snow App（平台层） | 落盘与宿主能力 | `filesystem.writeFile`、`panels.openFile`、`system.writeClipboardText`、`conversations.create` + `messages` |

铁律：

- MCP 不返回展示文案、不猜称号、不耦合面板；称号 / 情感 / 争议由 Agent 或面板派生。
- MCP 只接受 `start` / `end`，**不认识「日报/周报」**；时间窗与趋势粒度是面板语义。
- 面板不重复实现 MCP 已有的聚合；点击成员才按需调 `get_member_profile`。
- 报告只拼装当前 `stats` + `aiData` / `aiText`，不引入第二套统计口径。

## 4. 开发避雷点（⚠️ 必读）

### 4.1 打包与入口

- 入口**必须单文件打包**：`format: esm` + `bundle: true` + `splitting: false`；每个入口独立打包。
- **相对 import 与裸模块名都不可解析** —— 所有依赖必须内联进单文件。
- **React 必须映射到宿主** `window.SnowAppPlugin.React`，**不要**把 React 打进包。
- 图标用 `api.ui.icon()`（或 `icon: "lucide:Xxx"` 字符串），**不要**打包 `lucide-react`。
- CSS 走 `styles: ["xxx.css"]` 声明为独立文件。
- **⚠️ 主题色绝不能写死**（实测踩坑）：宿主是**明暗双主题**，且**不保证提供 `--vscode-*` 变量**。早期版本用 `var(--vscode-editor-background, #1e1e1e)` 之类写深色回退值，在浅色主题下渲染出**黑底日期条 + 浅灰字配米色背景**，看起来"内容很乱"。
  - 正确做法（与官方参考插件 `com.seagull.tps-metrics` 一致）：**不设文字色、不设背景色**，让文字色从宿主继承；底色/边框/悬停一律用中性 `rgba(128,128,128,0.1~0.35)`；"变淡"用 `opacity: 0.6` 而不是换颜色；只有强调色（按钮、柱状图）用固定品牌色 `#3b82f6`。
  - 另外：**不要用 `position: sticky` + `background: inherit` 做吸顶分组头** —— 祖先透明时会透出滚动内容；直接做成普通标题最稳。
- 体积上限：单文件 ≤ 8MB、插件目录 ≤ 128MB。

### 4.2 宿主能力探测（不要猜版本）

- 面板级：`api.ui.messageFooterVersion === 1`、`api.ui.toolCallRendererVersion === 1`
- `chatInputMenuActions` / `chatInputSettings` 等**需要配套宿主构建**，当前安装包可能没有 —— 旧宿主会**忽略**新字段，所以**不要猜 `minAppVersion`**，一律运行时探测后再启用对应 UI。

### 4.3 权限与隐私

- **ESM 面板等价本地代码（无沙箱）**：`privacy` 必须如实声明 `mcpSecrets`（读微信数据还会用到 `conversations`、`messages`），用户在插件页会看到**琥珀色标签**——README 必须写清用途。
- `api.metadata` 敏感域未声明 → `denied: { reason: "privacy-declaration-missing", scope }`；`domains` 里根本不会出现该域。
- 字段级敏感字段（`apiKey` / `visionApiKey` / `secret` / `password` / `token` / `credentials` 等）命中名称即被剥离，路径记录在 `withheld[domain]`。
- 36 个只读域里**没有任何微信数据域**，微信数据唯一通路就是 `api.write.mcpTools.call`。

### 4.4 运行时细节

- `api.write` **不抛异常**：`await` 后判 `res.ok` / `res.denied` 即可，无需 try/catch。
- 插件私有存储是**字符串**（`app_plugin_values` 表），JSON 用 `api.storage.getJson/setJson`。
- 改了 `plugin.json` 后需「**重新读取清单**」（`config-set` 的 `{ rescan: true }`），否则新声明不生效。
- `api.log` 输出前缀为 `[plugin:<id>]`，可用于验证；日志落 Snow App SQLite（见 `docs/zh-CN/3-参考手册/4-数据存储位置.md`）。
- 插件目录：`~/.snowapp/plugins/<pluginId>/`；登记在 `app_plugins` 表；应用库 `~/.snowapp/snowapp.db`。

### 4.5 本机环境特例（踩过的坑）

- **git push 必须**：`git -c http.sslBackend=openssl -c http.version=HTTP/1.1 push`（schannel 与代理 `127.0.0.1:10809` 不兼容）。
- **PowerShell 无 heredoc**：commit message 先写文件，再 `git commit -F <file>`。
- 写入工具传的反斜杠可能被转义 —— 含反斜杠的源码用 raw string 承载；补丁脚本须处理 CRLF。
- **任何 git 操作前必须获得用户确认**（工作区可能存在未提交删除项，勿随意 `checkout` / `clean`）。

---

## 5. 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0** | spike 探针：验证 `mcpTools.call` 契约 + 返回体积 | ✅ 已完成（并借此发现「动作 id 是域限定的」这一契约细节） |
| **P1** | 信息流视图 `feed`：群选择 + 时间/关键词过滤 + 按天分组 + 发言者配色 + 类型徽标 | ✅ 已实现（v0.2.0） |
| **P2** | 总结视图 `digest` 快路径（零 token：活跃排行 / 小时分布 / 类型占比 / 高频片段） | ✅ 已实现（v0.2.0） |
| **P3** | 依赖预检 + 缺失引导页 | ✅ 已实现（v0.2.0） |
| **P3.5** | 合并为单面板 + 明暗双主题适配（修掉写死的深色回退值） | ✅ 已实现（v0.3.0） |
| **P3.6** | 信息流排版重做（头像列 + 同人连续消息折叠 + 卡片化统计）+ **MCP 工具台视图** | ✅ 已实现（v0.4.0） |
| **P3.7** | 发言者**真头像**（`get_user_avatars` 批量）+ 图片**直出**（去点击）+ 顶栏**手动同步**按钮 | ✅ 已实现（v0.10.0） |
| **P3.8** | 修 `runSync` 的 hooks 顺序崩溃（`useCallback` 落在提前 `return` 之后 → React #310 白屏） | ✅ 已修复（v0.10.1） |
| P4 | AI 深总结的**流式渲染**：`api.metadata.subscribe("messages", ...)` 把 Agent 回复实时画进面板，并支持 `filesystem.writeFile` 导出 MD | ✅ 已实现（v0.12.0） |
| P5 | 引用消息胶囊跳原文；媒体项点击 `panels.openFile` 打开本地文件；`offset` 无限滚动 | 待开发 |
| P6 | 定时任务 `scheduledTasks.create` + `runNow` ✅ 已实现（v0.23.0）；i18n（`locales/`）评估后不做（主控件双语骨架已覆盖，数据标签与报告正文保持中文）；`system.notify` 因宿主签名未确认不做（改用面板内状态条）；「存备忘录」出口 v0.31.0 已移除（宿主备忘录不渲染 Markdown，与导出 MD / HTML 长图重复）；插件市场上架 | 部分实现 |

---

## 6. 安装与验证

```powershell
# 方式 A：AI / 命令行安装（plugins 域）
#   config-set scope=plugins key="new" value={sourceDir:"H:/GitHub/snow-wechat-panel"}
# 方式 B：客户端「设置 → 插件 → 面板插件 → 从目录安装」
```

安装后：顶栏 **加号菜单 → 插件 → 微信 MCP 探针** 打开面板，点击探针按钮，观察面板输出与 `[plugin:com.shiroeirin.wechat-feed]` 日志。
