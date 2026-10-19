# snow-wechat-panel

Snow App 插件：**微信群聊面板**（信息流 + 统计/总结，单面板双视图）。

数据来自本机已安装的 **wechat MCP server**（[im-mcp](https://github.com/stkoecn/im-mcp) 的 `wechat-mcp`），面板**只读**，
不访问网络，不向微信发送任何消息。

> 当前版本 **`0.11.0`**（v0.10.1 修掉 hooks 顺序崩溃；v0.10.2/0.10.3 重做顶栏控制行；v0.10.4 修掉悬停时消息行「跳一下」的布局位移；v0.10.5 信息流改时间倒序；v0.11.0 新增「聊天记录」展开 + 头像首次加载重试）：**单一面板**「微信群聊」，内部分段切换 **信息流 / 总结 / MCP 工具台** 三个视图（群选择与日期范围共用）。
>
> **图片直出**：`[图片]` 消息渲染时**自动**调上游 `get_message_image`，按消息 id 解密导出真实图片文件，再由宿主 `readFileContent` 渲染成 `<img>`。密钥已在 `~/.wechat_mcp/all_keys.json`，解密是确定性操作，**不需要点击任何按钮**；并发由内部闸门限到 3，失败可重试。本插件**不自带任何图片工具**——v0.6.0 那套 `find_message_covers` / `find_message_images` / `read_media_data_url` 已删除（上游 im-mcp 已有等价且更完善的实现）。
>
> **发言者头像**：调上游 `get_user_avatars` 批量取 `head_image.db` 头像并渲染圆形缩略图；未缓存的成员回退「首字母 + 稳定色」色块。
>
> **手动同步**：顶栏「同步微信数据」按钮 → 调上游 `sync_wechat_database(redecrypt=true)`（**先重新解密源库再重建索引**），这是本插件唯一的写操作。
> 完整的架构设计、契约细节与开发避雷点见 **[DESIGN.md](./DESIGN.md)**。

---

## ⚠️ 硬性前置依赖：必须先装 wechat MCP

**本插件不内置任何微信数据采集能力**，全部数据来自本机安装的 **wechat MCP 服务器**。
没装 / 没启用时，两个面板都会显示安装引导页（不会空白或报错）。

四步：

1. 安装提供 `wechat-mcp` 的包（im-mcp 项目）——`pip install im-mcp` 或 `uv tool install im-mcp`
2. **以管理员身份**初始化本地微信索引（需微信已登录）——`wechat-init`
3. 在 Snow App → **设置 → MCP 服务器** 添加 stdio 服务器，**名称必须为 `wechat`**：

```json
{
  "mcpServers": {
    "wechat": {
      "command": "wechat-mcp",
      "args": [],
      "env": { "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8" }
    }
  }
}
```

4. 若该 MCP 会话已在运行，重启应用 / 重连会话，然后回面板点「重新检测」

> 名称必须是 `wechat`：插件按 `wechat-<toolName>` 的形式调用工具（`toolFullName = <serverName>-<toolName>`）。

---

## 它做什么

### 视图一：信息流（`feed`）

- **群选择器**：拉取会话列表（默认只列群聊，含消息总数）
- **时间范围 + 关键词**：`get_messages_by_range`（按范围）/ `search_wechat_messages`（关键词搜索）
- **过滤**：只看媒体 / 只看 @ 提及
- **按天分组**（日期分隔线）；**发言者头像**（`get_user_avatars` 真头像圆形缩略图；缺缓存回退「首字母 + 稳定色」色块，同一人恒定同色）
- **类型徽标**：图片 / 视频 / 文件 / 语音 / 表情 / 链接
- 单次查询上限 200 条，触顶会提示缩小范围

### 视图二：总结（`digest`）

- **零 token 统计快路径**（纯前端聚合，不消耗模型 token）：
  - 概览卡：消息数 / 活跃人数 / 峰值时段 / 天数
  - 24 小时分布柱状图
  - 活跃发言者排行（横向条形图，配色与信息流一致）
  - 消息类型占比
  - 高频片段（2-gram 近似，中文无分词依赖）
- **AI 深度总结**：新建一个 Agent 会话并把总结任务交给它（提示词里带上 `session_id` 与时间范围，要求它用 wechat MCP 取数），完成后可一键跳转到该会话。
  - 提示词可在面板内展开预览
  - 面板内流式渲染 Agent 回复属于 P4 计划（见 [DESIGN.md](./DESIGN.md)）

### 视图三：MCP 工具台（`mcp`）

把 wechat MCP 的 **20 个工具**直接摆到面板里，每个都能改参数、直接调用、看原始返回：

- 工具卡片列出**工具名 + 中文用途**，点开展开参数框（JSON，已按当前选中的群 / 日期预填 `session_id`、`start`、`end`）
- 「调用」后显示 **ok / 失败 · 耗时 ms · 返回条数**，以及完整返回体（可滚动）
- **同步微信数据**（`sync_wechat_database`，默认 `redecrypt: true`：先重新解密源库再重建索引）标记为**写操作**，需要点两次确认
- **定时自动同步**（`set_auto_sync`）与 **定时同步状态**（`get_auto_sync_status`）也在工具台里，可直接开关
- 顶部显示本地索引规模（messages / sessions / contacts / media / avatars）

> 面板内调用与 Agent 用的是**同一套 wechat MCP**；除「同步微信数据 / 定时自动同步」外全部只读，不会向微信发送任何消息。

完整的架构设计、契约细节与开发避雷点见 **[DESIGN.md](./DESIGN.md)**。

### 聊天记录展开（v0.11.0）

`[聊天记录] …` 这类**合并转发消息**在本地索引里只有一行标题，被合并的正文要按需回取：

- 消息体渲染成折叠卡片（`ChatRecord`），默认收起；点开才发**一次** `get_chat_record(message_id)`
  （一屏可能几十条，不做预取）。
- 展开后逐条列出「谁 · 什么时候 · 内容」；图片 / 视频 / 文件等非文本条目给类型标签 + 文字占位。
- 读不到源库（解密快照缺失 / 该行已被清理）时只在卡片里提示错误，不影响其它消息渲染。

### 同步（v0.10.3）

- **顶栏控制行「同步」按钮**（在「查询」右侧）：一次完整同步 = **重新解密微信源库 → 重建本地索引**（实测约 16 秒），跑完显示绿条「同步完成 · N 条消息」。按钮自带旋转图标，同步中变为「同步中…」。
- **顶栏控制行「重置」按钮**：把群选择、日期范围（回到最近 7 天）、关键词、只看媒体 / 只看 @ 一次性恢复默认，并清空当前结果。
- **为什么必须重新解密**：微信源库是加密的，本地索引读的是**解密快照**。只重建 ETL 而不重新解密，拿到的永远是旧快照（这正是「今天一条消息都没有」的根因）。
- **定时同步**：面板与 Agent 都可通过 `set_auto_sync(enabled, interval_minutes)` 开启，间隔钳制 5–1440 分钟；`get_auto_sync_status` 查看开关、间隔、运行次数与上次结果。定时器随 MCP 进程存活（Snow App 启停）。

---

## 环境要求

- **Snow App** ≥ 0.4.27（面板插件 ESM 契约；`api.write.mcpTools` 可用）
- 本机已安装并启用 **wechat MCP server**（见上节，名称必须为 `wechat`）
- 本地微信索引已建立（`wechat-init` 完成）

---

## 安装

**方式 A —— 客户端 UI（推荐）**

设置 → **插件** → 「面板插件」小标签 → **从目录安装** → 选择本目录。

**方式 B —— 通过 AI / config 工具**

```
config-set  scope=plugins  key="new"  value={ "sourceDir": "H:/GitHub/snow-wechat-panel" }
```

安装后：顶栏 **加号菜单 → 插件 → 微信 MCP 探针**，或右侧面板的插件入口。

---

## ⚠️ 隐私声明

本插件在 `plugin.json` 中声明了 **`mcpSecrets`** 隐私域。

- **为什么需要**：`api.write.mcpTools.call` 的 `scope` 是 `mcpSecrets`，未声明则调用会被拒绝（`denied.reason = "write-declaration-missing"`）。
- **风险提示**：**ESM 面板等价于本地代码，没有沙箱**。插件页会为此显示**琥珀色标签**。
- **本插件的实际行为**：只通过 wechat MCP 工具**读取**本地微信消息索引，用于渲染信息流与统计；渲染 `[图片]` 消息时自动调 MCP `get_message_image` 把 `.dat` 解密导出成真实图片文件，再经 `filesystem` 域用宿主 `window.snow.readFileContent(path)` 读取该文件并转成 `data:` URL 显示；顶栏「同步微信数据」会调 `sync_wechat_database`（**本插件唯一的写操作**，先重新解密源库再重建本地索引）；不读取 API 密钥，不访问网络，不发送消息。完整声明见 `plugin.json` 的 `privacy.note`。
- **作用域**：`mcpSecrets`（调用 MCP 工具）、`conversations`（AI 深总结时新建会话）、`filesystem`（读取 MCP 解密导出的本地图片文件）。

---

## 开发

入口 `index.js` 为**单文件 ESM**（`format: esm` + `bundle: true` + `splitting: false`），
React 取自 `window.SnowAppPlugin.React`，**不要打包 React / lucide-react**。

修改 `plugin.json` 后需要 **重新读取清单**（`rescan`），否则新声明不生效。

### 测试

数据层（解包 / 取数组 / 消息分类 / 高频片段 / 配色 / 格式化）有回归测试，不依赖宿主即可运行：

```bash
node test/helpers.test.js
```

其中「JSON 字符串信封 → 数组」这条用例是**历史 bug 的回归锁**：早期解包器只处理对象信封，遇到字符串信封会静默返回非数组，导致群列表空白且不报错。

---

## 许可证

MIT
