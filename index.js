// 微信群聊面板（单面板三视图：信息流 / 总结 / MCP 能力）
//
// 数据源：本机 wechat MCP 服务器（serverId = global:wechat），只读。
// 数据桥：api.write.run("mcpTools.call", { toolFullName: "wechat-<tool>", args })
//
// 契约要点（Snow App 0.4.27，实测 + 源码核实）：
//   - ESM 入口，默认导出 React 组件；React 取 window.SnowAppPlugin.React
//   - api.write 不抛异常：{ ok, action, data, denied, error }
//   - api.write.domains() 的动作 id 是「域限定」的：mcpTools.call（不是 call）
//   - mcpTools.call 的 scope = mcpSecrets；conversations.* 的 scope = conversations
//   - MCP 返回可能是 JSON 字符串 / {content:[{text}]} / {structuredContent:{result}}，必须逐层解包

const host = window.SnowAppPlugin;
const React = host.React;
const h = React.createElement;
const { useState, useEffect, useMemo, useCallback, useRef } = React;
// React 18 才有 useLayoutEffect；极老运行时回退到 useEffect，避免 undefined 调用
const useLayoutEffect = React.useLayoutEffect || React.useEffect;

const MCP_SERVER = "wechat";
const PAGE_LIMIT = 200;
const ACCENT = "#3b82f6";
// 深度分析：assistant 消息视为「已完成」的状态白名单；轮询兜底的超时上限
const AI_DONE_STATUSES = ["done", "completed", "complete", "finished", "success", "succeeded", "idle", "error", "failed"];
const AI_POLL_TIMEOUT_MS = 10 * 60 * 1000;
// 同步成功的提示 3 秒后淡出（与 style.css 的 .swf-syncmsg-ok 动画时长对齐）
const SYNC_OK_FADE_MS = 3000;
// 成员检索结果分页：MCP 的 list_chatroom_members 没有 offset（服务端分页不存在），
// 所以一次取全量、前端按页渲染，避免 500 人群一次铺满
const MEMBER_PAGE_SIZE = 30;
// AI 分析维度：开关决定提示词要求哪些结构化字段（关掉的维度 Agent 不生成，报告也不出现）
const AI_DIMS = [
  ["topics", "话题"],
  ["todos", "待办"],
  ["risks", "风险"],
  ["sentiment", "情绪"],
  ["controversies", "争议"],
  ["titles", "称号"],
  ["quotes", "金句"],
  ["profile", "群画像"],
];
const AI_SETTINGS_DEFAULT = {
  dims: { topics: true, todos: true, risks: true, sentiment: true, controversies: true, titles: true, quotes: true, profile: true },
  limits: { topics: 8, titles: 5, quotes: 5 },
  extra: "",
  // 深挖流水线：segments = 0 表示按跨度与消息量自动决定段数；verify = 交叉验证强度（0 = 不验证，1 = 每视角一轮）
  deep: { segments: 0, verify: 1 },
};
function cloneAiSettings(s) {
  return JSON.parse(JSON.stringify(s));
}
// 合并已保存的设置：只接受合法键与合法值，避免旧版本 / 脏数据把面板带崩
function mergeAiSettings(base, saved) {
  const out = cloneAiSettings(base);
  if (!saved || typeof saved !== "object") return out;
  if (saved.dims && typeof saved.dims === "object") {
    for (const k of Object.keys(out.dims)) {
      if (typeof saved.dims[k] === "boolean") out.dims[k] = saved.dims[k];
    }
  }
  if (saved.limits && typeof saved.limits === "object") {
    for (const k of Object.keys(out.limits)) {
      const v = Number(saved.limits[k]);
      if (Number.isFinite(v)) out.limits[k] = Math.max(1, Math.min(50, Math.round(v)));
    }
  }
  if (typeof saved.extra === "string") out.extra = saved.extra;
  // 深挖设置：段数只接受 0（自动）/ 2 / 4 / 6 / 8；验证强度钳到 0-1
  if (saved.deep && typeof saved.deep === "object") {
    const segs = Math.round(Number(saved.deep.segments));
    if (DEEP_SEGMENT_CHOICES.indexOf(segs) >= 0) out.deep.segments = segs;
    const vf = Math.round(Number(saved.deep.verify));
    if (Number.isFinite(vf)) out.deep.verify = Math.max(0, Math.min(1, vf));
  }
  return out;
}

/* ======================= 深挖流水线：常量与纯函数 =======================
   三层分工在这里的落点：MCP 只给数据，Agent 只做语义，面板负责**编排与对账**。
   深挖把「一轮写完整报告」拆成四个阶段，阶段之间串行（有强依赖），
   阶段内部由该阶段的 Agent 用 sub-agents-activate 并行派子代理
   （面板没有激活子代理的写动作，并行必须由 Agent 自己发起）。 */

// 深挖阶段：分段读事实 → 多视角挖掘 → 交叉验证 → 汇总成稿
const DEEP_STAGE_LABELS = { segment: "分段读事实", lens: "多视角挖掘", verify: "交叉验证", final: "汇总成稿" };
// 每个阶段独立超时：阶段 1 要并行读完全量消息，给得宽一点
const DEEP_STAGE_TIMEOUT_MS = 15 * 60 * 1000;
const DEEP_POLL_INTERVAL_MS = 2000;
// 段数可选值（0 = 自动）
const DEEP_SEGMENT_CHOICES = [0, 2, 4, 6, 8];
// 档位推荐阈值：跨度 ≤ 3 小时且消息不多 → 单会话足够，深挖是浪费
const DEEP_RECOMMEND = { shortHours: 3, busyMessages: 800 };
// 进度标记：阶段内并行子代理完成一个就报一行，面板据此更新进度
const DEEP_PROGRESS_RE = /\[PROGRESS\]\s*(.+)/g;

/** 正文里是否已经有「完整可解析」的 JSON 对象。
    Agent 经常直接吐裸 JSON（没有 ``` 围栏），只认围栏会让面板一直停在「生成中」，
    直到 10 分钟超时才收敛 —— 所以这里补一条：整段能 JSON.parse 出来就算完成。 */
function hasCompleteJson(text) {
  const t = String(text || "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start + 1) return false;
  try {
    const v = JSON.parse(t.slice(start, end + 1));
    return !!v && typeof v === "object";
  } catch (err) {
    return false;
  }
}

/** 把正文里的结构化数据块剔掉。
    支持两种写法：`<<<AI_JSON>>> … <<<END>>>`（推荐）与 ```json 围栏，
    另外围栏体以 { [ " 开头的代码块也当作数据块剔掉。
    （Agent 有时会把数据块插到正文中间、甚至吐成残片。） */
function stripAiJson(text) {
  const s = String(text || "");
  return s
    .replace(/<<<AI_JSON>>>[\s\S]*?<<<END>>>/gi, "")
    .replace(/```([a-zA-Z]*)\r?\n([\s\S]*?)```/g, (all, lang, body) => {
      const t = String(body || "").trim();
      if (/^json$/i.test(String(lang || "").trim())) return "";
      if (/^["{\[]/.test(t)) return "";
      return all;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 从一段混杂文本里取出**最后一个能解析**的 JSON 对象 —— 用来补救模型把 json 写残的情况。 */
function lastJsonObject(text) {
  const s = String(text || "");
  for (let end = s.lastIndexOf("}"); end > 0; end = s.lastIndexOf("}", end - 1)) {
    for (let start = s.lastIndexOf("{", end); start >= 0; start = s.lastIndexOf("{", start - 1)) {
      try {
        const v = JSON.parse(s.slice(start, end + 1));
        if (v && typeof v === "object" && !Array.isArray(v)) return v;
      } catch (err) {
        /* 继续往前找 */
      }
    }
  }
  return null;
}

/** 从 messages 域载荷里读出「最后一条 assistant 消息」的正文与完成状态。
    单轮深度分析与深挖流水线共用，避免两处完成判定分叉。 */
function readAiMessage(data) {
  if (!data || typeof data !== "object") return null;
  const items = Array.isArray(data.items) ? data.items : [];
  const assistants = items.filter((m) => m && m.role === "assistant");
  const last = assistants[assistants.length - 1];
  if (!last) return null; // 还没产出 assistant 消息
  const text = String(last.content || "");
  const status = String(last.status || "").toLowerCase();
  return {
    text: text,
    status: status,
    // 有 toolCallsJson 但正文还空 = Agent 正在调工具（区别于「什么都没开始」）
    toolPending: !text && !!last.toolCallsJson,
    // 完成判定：状态白名单命中，或正文已带 ```json 围栏，或正文本身就是完整 JSON
    done: !!text && (AI_DONE_STATUSES.indexOf(status) >= 0 ||
      /```json[\s\S]*?```/i.test(text) ||
      hasCompleteJson(text)),
  };
}

/** 深挖的「视角」：每个视角一个子代理，按分析维度开关裁剪（关掉的维度不跑，省 token）。 */
const DEEP_LENSES = [
  ["topics", "话题脉络", "讨论了哪些话题、各自如何演变、最后落在什么结论上"],
  ["todos", "决策与待办", "有哪些明确结论、谁答应了做什么、什么还没定下来"],
  ["people", "人物与关系", "谁在推动讨论、谁在潜水、互动结构与角色分工"],
  ["sentiment", "情绪走向", "群氛围如何变化、哪些时段出现明显情绪转折"],
  ["risks", "争议与风险", "有哪些冲突点、潜在隐患、被压下去的不同意见"],
  ["quotes", "金句与原文", "值得留存的原文摘录（必须逐字摘录，不要改写）"],
];

/** 按当前维度开关过滤出要跑的视角。 */
function activeDeepLenses(dims) {
  const d = dims || {};
  return DEEP_LENSES.filter(([key]) => {
    if (key === "people") return !!d.titles || !!d.profile;
    if (key === "risks") return !!d.risks || !!d.controversies;
    return !!d[key];
  });
}

/** 统计基线文本：面板手里的全量 SQL 聚合，注入每一轮当「测谎仪」。
    这是面板独有、MCP 与 Agent 都给不出的东西 —— Agent 说「某人今天很活跃」时，
    这里就是能当场对账的那本账。 */
function buildStatsBrief(stats, current, sessionId, rangeStart, rangeEnd) {
  const lines = [];
  lines.push("会话：" + ((current && current.display_name) || sessionId) + "（session_id: " + sessionId + "）");
  lines.push("时间范围：" + rangeStart + " ~ " + rangeEnd);
  if (!stats || typeof stats !== "object") {
    lines.push("（本次未加载统计基线：定性结论请自行回原文核对。）");
    return lines.join("\n");
  }
  const total = Number(stats.total_messages) || 0;
  lines.push("消息总量：" + total + " 条；发言人数：" + (Number(stats.unique_senders) || 0) + " 人");
  const rank = stats.member_rank || stats.top_senders || [];
  if (Array.isArray(rank) && rank.length) {
    const top = rank.slice(0, 20).map((m) => {
      const who = (m && (m.display_name || m.sender || m.name)) || "?";
      const n = Number((m && (m.count != null ? m.count : m.messages)) || 0);
      return who + "(" + n + ")";
    });
    lines.push("成员发言量 Top20（权威，用于对账）：" + top.join("、"));
  }
  const types = stats.type_distribution;
  if (Array.isArray(types) && types.length) {
    lines.push("消息类型分布：" + types.map((x) => (x && x.label ? x.label : "?") + " " + (Number(x && x.count) || 0)).join("、"));
  }
  const daily = stats.daily_distribution;
  if (daily && typeof daily === "object") {
    const pairs = Object.keys(daily).sort().map((k) => k + " " + (Number(daily[k]) || 0));
    if (pairs.length) lines.push("按天消息量：" + pairs.join("、"));
  }
  const sys = stats.system_events;
  if (sys && typeof sys === "object") {
    lines.push("撤回类 / 系统消息：" + (Number(sys.withdrawn) || 0) + " / " + (Number(sys.system) || 0));
  }
  return lines.join("\n");
}

/** 深挖分段规划：日报按小时切、周报按天切、月报按等分切；消息量太小就减半。
    返回 [{ start, end }]，至少 2 段、最多 8 段。 */
function planDeepSegments(rangeStart, rangeEnd, stats, want) {
  const from = new Date(String(rangeStart || "").replace(" ", "T"));
  const to = new Date(String(rangeEnd || "").replace(" ", "T"));
  const single = [{ start: rangeStart, end: rangeEnd }];
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) return single;
  const hours = (to.getTime() - from.getTime()) / 3600000;
  const days = hours / 24;
  let n = Number(want) || 0;
  if (!n) {
    if (days <= 1.01) n = 4; // 日报：按小时切 4 段
    else if (days <= 7.5) n = Math.min(8, Math.max(2, Math.round(days))); // 周报：按天切
    else n = 8; // 月报及更长：等分 8 段
    const msgs = Number(stats && stats.total_messages) || 0;
    if (msgs && msgs < 400 && n > 2) n = Math.max(2, Math.floor(n / 2));
  }
  n = Math.max(2, Math.min(8, n));
  const step = (to.getTime() - from.getTime()) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = new Date(from.getTime() + step * i);
    const e = new Date(from.getTime() + step * (i + 1) - 1000);
    out.push({ start: fmtDateTime(s), end: fmtDateTime(i === n - 1 ? to : e) });
  }
  return out;
}

/** Date → 'YYYY-MM-DD HH:MM:SS'（MCP 接受的时间格式）。 */
function fmtDateTime(d) {
  const p = (x) => String(x).padStart(2, "0");
  return (
    d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
  );
}

/** 从 Agent 正文里摘掉末尾的结构化 json 块，只留给人看的 Markdown。 */
function stripJsonBlock(text) {
  return String(text || "").replace(/```json[\s\S]*?```/i, "").trim();
}

/** 收集正文里的进度标记（子代理完成一个报一行）。 */
function readProgressMarks(text) {
  const out = [];
  const src = String(text || "");
  let m;
  DEEP_PROGRESS_RE.lastIndex = 0;
  while ((m = DEEP_PROGRESS_RE.exec(src)) !== null) {
    const line = String(m[1] || "").trim();
    if (line) out.push(line.slice(0, 120));
  }
  return out;
}
/** Agent 结构化结果的图表渲染（单轮深度分析与深挖汇总共用：schema 相同 → 渲染也共用）。
    内部沿用单轮管线的变量名，便于与既有代码逐行对应；返回节点数组，调用方展开。 */
function aiChartNodes(data) {
  const aiData = data;
  return [
      // 导语卡：AI 的「一句话摘要」放最前当视觉焦点（原「Agent 热度图」已删除）
      aiData && typeof aiData.summary === "string" && aiData.summary.trim()
        ? h("div", { className: "swf-lead" }, aiData.summary.trim())
        : null,
      aiData && Array.isArray(aiData.topics) && aiData.topics.length
        ? h(
            "div",
            null,
            h("div", { className: "swf-sub" }, h("span", { className: "swf-ico" }, "🗂️"), "话题分布（Agent）"),
            (() => {
              const maxW = aiData.topics.reduce((a, x) => Math.max(a, Number(x && x.weight) || 0), 1);
              return aiData.topics.map((x, i) =>
                h(
                  "div",
                  { className: "swf-bar-row", key: "topic-" + i },
                  h("div", { className: "swf-bar-label", title: x.name }, h("span", { className: "swf-bar-name" }, x.name)),
                  h(
                    "div",
                    { className: "swf-bar-track" },
                    h("div", { className: "swf-bar-fill", style: { width: Math.max(3, ((Number(x.weight) || 0) / maxW) * 100) + "%", background: ACCENT } }),
                  ),
                  h("div", { className: "swf-bar-num" }, String(Number(x.weight) || 0)),
                ),
              );
            })(),
            h(
              "div",
              { className: "swf-words" },
              aiData.topics.flatMap((x, i) => (x.keywords || []).slice(0, 4).map((k, j) => h("span", { className: "swf-word", key: "kw-" + i + "-" + j }, k))),
            ),
          )
        : null,
      aiData && Array.isArray(aiData.todos) && aiData.todos.length
        ? h(
            "div",
            null,
            h("div", { className: "swf-sub" }, h("span", { className: "swf-ico" }, "✅"), "待办"),
            aiData.todos.map((x, i) => h("div", { className: "swf-todo", key: "todo-" + i }, h("b", null, x.who || "?"), " · ", String(x.what || ""))),
          )
        : null,
      aiData && Array.isArray(aiData.risks) && aiData.risks.length
        ? h(
            "div",
            null,
            h("div", { className: "swf-sub" }, h("span", { className: "swf-ico" }, "⚠️"), "风险 / 争议"),
            aiData.risks.map((r, i) => h("div", { className: "swf-risk", key: "risk-" + i }, "• ", String(r))),
          )
        : null,
      aiData && Array.isArray(aiData.sentiment) && aiData.sentiment.length
        ? h(
            "div",
            null,
            h("div", { className: "swf-sub" }, h("span", { className: "swf-ico" }, "📈"), "情绪曲线（-100 负面 / +100 正面）"),
            h(
              "div",
              { className: "swf-senti" },
              aiData.sentiment.slice(0, 14).map((x, i) => {
                const score = Math.max(-100, Math.min(100, Number(x.score) || 0));
                return h(
                  "div",
                  { className: "swf-senti-col", key: "senti-" + i, title: String(x.period || "") + "：" + score },
                  h("div", {
                    className: "swf-senti-bar",
                    style: {
                      height: Math.max(4, Math.abs(score)) + "%",
                      background: score >= 0 ? ACCENT : "rgba(239,68,68,0.72)",
                    },
                  }),
                  h("div", { className: "swf-senti-k" }, String(x.period || "").slice(-5)),
                );
              }),
            ),
          )
        : null,
      aiData && Array.isArray(aiData.controversies) && aiData.controversies.length
        ? h(
            "div",
            null,
            h("div", { className: "swf-sub" }, h("span", { className: "swf-ico" }, "⚔️"), "争议指数"),
            aiData.controversies.map((x, i) =>
              h(
                "div",
                { className: "swf-risk", key: "ctr-" + i },
                "• ",
                String(x.topic || ""),
                " ",
                "★".repeat(Math.max(0, Math.min(5, Number(x.level) || 0))) +
                  "☆".repeat(Math.max(0, 5 - Math.max(0, Math.min(5, Number(x.level) || 0)))),
                x.reason ? " — " + String(x.reason) : "",
              ),
            ),
          )
        : null,
      aiData && Array.isArray(aiData.titles) && aiData.titles.length
        ? h(
            "div",
            null,
            h("div", { className: "swf-sub" }, h("span", { className: "swf-ico" }, "🏅"), "称号评定"),
            h(
              "div",
              { className: "swf-words" },
              aiData.titles.map((x, i) =>
                h("span", { className: "swf-word", key: "title-" + i, title: x.reason || "" }, x.who + " · " + x.title),
              ),
            ),
          )
        : null,
      aiData && Array.isArray(aiData.quotes) && aiData.quotes.length
        ? h(
            "div",
            null,
            h("div", { className: "swf-sub" }, h("span", { className: "swf-ico" }, "💬"), "金句"),
            aiData.quotes.map((x, i) =>
              h(
                "div",
                { className: "swf-quote-card", key: "quote-" + i },
                h("b", null, x.who || "?"),
                "：",
                String(x.text || ""),
                x.why ? h("span", { className: "swf-note" }, "（" + String(x.why) + "）") : null,
              ),
            ),
          )
        : null,
      aiData && aiData.profile && typeof aiData.profile === "object"
        ? h(
            "div",
            null,
            h("div", { className: "swf-sub" }, h("span", { className: "swf-ico" }, "👥"), "群画像"),
            aiData.profile.summary ? h("div", { className: "swf-note" }, String(aiData.profile.summary)) : null,
            aiData.profile.style ? h("div", { className: "swf-note" }, "风格：" + String(aiData.profile.style)) : null,
            Array.isArray(aiData.profile.advice) && aiData.profile.advice.length
              ? h(
                  "div",
                  null,
                  aiData.profile.advice.map((a, i) => h("div", { className: "swf-risk", key: "advice-" + i }, "→ ", String(a))),
                )
              : null,
          )
        : null,
  ];
}

/** 24×7 热力网格：数据来自 MCP 的 weekday_hourly（本地 SQL 精确聚合，weekday: 0=周日）。
    面板与长图共用同一份数据与配色 —— 这类「可数的指标」必须由代码算，不能让模型去估。 */
function heatGrid(stats) {
  const cells = (stats && stats.weekday_hourly) || [];
  const map = new Map();
  let max = 0;
  let total = 0;
  for (const c of cells) {
    const v = Number(c && c.count) || 0;
    map.set(String(c.weekday) + "-" + String(c.hour), v);
    if (v > max) max = v;
    total += v;
  }
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  return {
    hasData: cells.length > 0,
    max: max,
    total: total,
    rows: weekdays.map((label, wi) => ({
      label: label,
      cells: Array.from({ length: 24 }, (_, hi) => {
        const hour = pad2(hi);
        return { hour: hour, count: map.get(String(wi) + "-" + hour) || 0 };
      }),
    })),
  };
}

/** 热力单元格配色（蓝底 + 透明度映射；无数据给中性灰）。 */
function heatColor(count, max) {
  if (!count) return "rgba(128,128,128,0.10)";
  const a = 0.15 + 0.85 * (count / Math.max(1, max));
  return "rgba(59,130,246," + a.toFixed(3) + ")";
}

/** 结构化输出的字段清单：单轮深度分析与深挖汇总共用，避免两处 schema 分叉
    （分叉会让深挖结果画不出图表，而且很难察觉）。 */
function aiJsonFields(dims, limits) {
  const d = dims || {};
  // summary 永远输出：它是长图 / 面板的导语卡，也是「AI 只做语义」的最小载体。
  // 注意 heat_hours 已移除 —— 小时热度由本地 SQL 精确聚合，让模型去「估热度」既不准也浪费 token。
  const fields = ['  "summary": "一句话摘要（30 字以内，抓住当天最核心的事）"'];
  if (d.topics) fields.push('  "topics": [{"name": "话题名", "weight": 0, "keywords": ["关键词"]}]');
  if (d.todos) fields.push('  "todos": [{"who": "谁", "what": "要做什么"}]');
  if (d.risks) fields.push('  "risks": ["风险或争议点"]');
  if (d.sentiment) fields.push('  "sentiment": [{"period": "2026-10-01", "score": 0}]');
  if (d.controversies) fields.push('  "controversies": [{"topic": "争议话题", "level": 0, "reason": "为什么"}]');
  if (d.titles) fields.push('  "titles": [{"who": "谁", "title": "称号", "reason": "依据"}]');
  if (d.quotes) fields.push('  "quotes": [{"who": "谁", "text": "原话", "why": "为什么值得记住"}]');
  if (d.profile) fields.push('  "profile": {"summary": "群画像一句话", "style": "交流风格", "advice": ["行动建议"]}');
  return fields;
}

/** 结构化输出的取值约束（与 aiJsonFields 成对使用）。 */
function aiJsonConstraints(dims, limits) {
  const d = dims || {};
  const lim = limits || {};
  const out = ["- summary 是一句话导语（30 字以内），不要复述下面的结构，要能让人一眼知道当天发生了什么。"];
  if (d.topics) out.push("- topics 3-" + (lim.topics || 8) + " 个（weight 取 0-100 的相对重要度）。");
  if (d.sentiment) out.push("- sentiment 按天或按周给分（-100 到 100，负=负面，正=正面），最多 14 个点。");
  if (d.controversies) out.push("- controversies level 取 0-5。");
  if (d.titles) out.push("- titles 1-" + (lim.titles || 5) + " 个（可以是趣味称号，但必须给依据）。");
  if (d.quotes) out.push("- quotes 1-" + (lim.quotes || 5) + " 条，必须是原文摘录。");
  if (d.profile) out.push("- profile.advice 2-4 条，面向群管理员或参与者。");
  out.push("- 没有数据的字段给空数组 / 空对象，不要编造。");
  return out;
}

/** 时间窗声明：所有阶段共用。实测过的坑 —— 群里有人转发往期简报时，
    模型会据此说「本次涵盖两天 / 时间范围不明」，必须显式钉死窗口。 */
const DEEP_WINDOW_NOTE =
  "注意：记录里若出现「转发的往期简报 / 旧文章 / 历史截图」，一律视为「当天分享的资料」，不要据此推断时间范围，也不要写「本次涵盖多天」。";

/** 排版约定：AI 只写 Markdown 语义，样式由面板统一提供（不让模型手写 HTML/CSS）。 */
const AI_FORMAT_RULES = [
  "排版约定（样式由面板统一提供，**不要自己写 HTML 或 CSS**）：",
  "- 值得重点提示的内容用 callout 语法（第一行是类型标记）：",
  "  > [!TIP] 小标题",
  "  > 内容",
  "  可用类型：TIP（值得一试）/ INFO（说明）/ WARN（注意）/ DANGER（风险）/ SUCCESS（结论）/ QUOTE（原话）",
  "- 关键人名、工具名、结论用 **加粗**",
  "- 原文摘录用引用块或 QUOTE callout，必须逐字摘录",
  "- 表格只用于真正的多列对照，不要为了排版而表格",
];

/** 子代理的公共纪律：子代理没有父会话上下文，必须自带全部信息；且它默认是编码助手，要明确禁止写操作。 */
const DEEP_SUBAGENT_RULES = [
  "子代理 prompt 必须自带完整上下文（它看不到你的对话历史），并写明：",
  "- 禁止事项：只读分析；不许写文件、不许执行 git 或构建命令、不许向微信发送任何消息",
  "- 产出格式：正文 + 末尾一个 json 代码块（三个反引号 + json）",
];

/** 阶段 1：并行分段读事实（只提取事实，禁止下结论）。 */
function deepSegmentPrompt(o) {
  const segs = o.segments || [];
  const lines = [
    "你是「群聊记录读取员」。任务：把指定时间范围内的聊天记录**完整读一遍**，产出结构化「事实底稿」。",
    "",
    "会话：" + o.sessionName + "（session_id: " + o.sessionId + "）",
    "时间范围：" + o.rangeStart + " ~ " + o.rangeEnd + "（这是本次分析的唯一时间窗）",
    DEEP_WINDOW_NOTE,
    "本次分成 " + segs.length + " 段。",
    "",
    "## 强制做法：并行分段（不要自己串行读）",
    "请用 sub-agents-activate **一次性**派 " + segs.length + " 个子代理（agentId 用 agent_general），每人只负责一段：",
  ];
  segs.forEach((s, i) => {
    lines.push("  子代理 " + (i + 1) + "：[" + s.start + " ~ " + s.end + "]");
  });
  lines.push("");
  DEEP_SUBAGENT_RULES.forEach((x) => lines.push(x));
  lines.push(
    "",
    "子代理取数要求：",
    '- get_messages_by_range(session_id, start, end, limit=500, offset, order="asc") 反复翻页直到取完该段全部消息，不要只看第一页',
    "- 消息量大时优先记录有信息量的内容（讨论、结论、争议、数据、链接、文件名），表情与系统提示只需计数",
    "",
    "每个子代理完成后，你输出一行进度标记（面板据此显示进度）：",
    "[PROGRESS] 第 k/" + segs.length + " 段完成（消息 N 条）",
    "",
    "## 铁律：只提取事实，禁止下结论",
    "- 允许：谁在什么时候说了什么、讨论了什么主题、出现了什么数字/链接/文件、消息条数",
    "- 禁止：评价与总结性判断（如「讨论很热烈」「大家达成共识」）、猜测动机、编造未出现的内容",
    "- 引用必须原文逐字摘录，不要改写",
    "",
    "## 输出",
    "第一部分：Markdown（每段一节，写时间线要点）",
    "第二部分：在最后追加一个 json 代码块，只放结构化事实，不要注释：",
    "{",
    '  "segments": [',
    '    {"range": "起始~结束", "message_count": 0,',
    '     "timeline": [{"time": "HH:MM", "who": "谁", "what": "发生了什么（事实陈述）"}],',
    '     "participants": [{"who": "谁", "messages": 0}],',
    '     "quotes": [{"who": "谁", "time": "HH:MM", "text": "原文"}],',
    '     "numbers": ["出现的关键数字 / 链接 / 文件名"]}',
    "  ]",
    "}",
    "约束：timeline 每段最多 25 条，只留信息量最大的；quotes 每段最多 8 条且必须原文；没有的字段给空数组。",
    "除正文里的这一个 json 块外，不要再输出其它代码块。",
  );
  const extra = String(o.extra || "").trim();
  if (extra) lines.push("", "补充要求（用户自定义，优先遵守）：", extra);
  return lines.join("\n");
}

/** 阶段 2：多视角并行挖掘（每条结论必须可溯源）。 */
function deepLensPrompt(o) {
  const lenses = o.lenses || [];
  const lines = [
    "你是「群聊分析师」。上一阶段已把全量聊天记录并行读成「事实底稿」，现在按多个视角分别深挖。",
    "",
    "会话：" + o.sessionName + "（session_id: " + o.sessionId + "）",
    "时间范围：" + o.rangeStart + " ~ " + o.rangeEnd,
    DEEP_WINDOW_NOTE,
    "",
    "## 统计基线（面板对全量数据做的 SQL 聚合，权威，不得与之矛盾）",
    o.statsBrief,
    "",
    "## 事实底稿（上一阶段产出）",
    o.prev,
    "",
    "## 强制做法：并行分视角",
    "请用 sub-agents-activate **一次性**派 " + lenses.length + " 个子代理（agentId 用 agent_general），每人只做一个视角：",
  ];
  lenses.forEach(([, label, hint], i) => {
    lines.push("  子代理 " + (i + 1) + "：「" + label + "」——" + hint);
  });
  lines.push("");
  DEEP_SUBAGENT_RULES.forEach((x) => lines.push(x));
  lines.push(
    "每个子代理的 prompt 必须**原样带上上面的统计基线与事实底稿**，并写明它自己的视角与产出要求。",
    "允许子代理回原文取证：",
    "- search_wechat_messages(query, session_id, start, end, sender, limit, offset)",
    "- get_messages_by_range(session_id, start, end, sender, limit, offset, order)",
    "- get_member_profile(member, session_id, start, end, include_samples=30)",
    "",
    "每个子代理完成后输出一行：[PROGRESS] 视角 k/" + lenses.length + " 完成",
    "",
    "## 铁律：每条结论必须可溯源",
    "- 每条 finding 必须给 evidence：哪一段、哪句原话、或哪个统计数字",
    "- 拿不出依据的，evidence 写「无据」，不要编造依据",
    "- 与统计基线冲突的定性判断（例如说某人很活跃、但此人不在 Top20），必须放弃或改写",
    "",
    "## 输出",
    "第一部分：Markdown（每个视角一节）",
    "第二部分：末尾一个 json 代码块：",
    "{",
    '  "lenses": [',
    '    {"lens": "视角名",',
    '     "findings": [{"claim": "结论", "evidence": "依据", "confidence": 0}],',
    '     "open_questions": ["还没弄清楚的问题"]}',
    "  ]",
    "}",
    "约束：confidence 取 0-100；每个视角 findings 3-10 条，宁缺毋滥；没有的字段给空数组。",
    "除正文里的这一个 json 块外，不要再输出其它代码块。",
  );
  const extra = String(o.extra || "").trim();
  if (extra) lines.push("", "补充要求（用户自定义，优先遵守）：", extra);
  return lines.join("\n");
}

/** 阶段 3：对抗式交叉验证（用基线对账 + 回原文取证）。 */
function deepVerifyPrompt(o) {
  const lenses = o.lenses || [];
  const lines = [
    "你是「审查员」。你的任务是**推翻**上一阶段的结论，而不是复述它。",
    "",
    "会话：" + o.sessionName + "（session_id: " + o.sessionId + "）",
    "时间范围：" + o.rangeStart + " ~ " + o.rangeEnd,
    DEEP_WINDOW_NOTE,
    "",
    "## 统计基线（权威，用于对账）",
    o.statsBrief,
    "",
    "## 事实底稿",
    o.facts,
    "",
    "## 待审查的结论",
    o.prev,
    "",
    "## 强制做法：并行分视角审查",
    "请用 sub-agents-activate 派 " + lenses.length + " 个子代理，每人只审查一个视角：",
  ];
  lenses.forEach(([, label], i) => {
    lines.push("  子代理 " + (i + 1) + "：审查「" + label + "」");
  });
  lines.push("");
  DEEP_SUBAGENT_RULES.forEach((x) => lines.push(x));
  lines.push(
    "每个子代理必须完成四件事，缺一不可：",
    "1. **对账**：结论里的每个数字 / 名次 / 人数，与统计基线逐项核对，不一致就列为 issue",
    "2. **查无据**：evidence 为「无据」或明显撑不起 claim 的，列为 issue",
    "3. **找遗漏**：该视角明显该提却没提的（例如有撤回、有争议却一字未提）",
    "4. **找矛盾**：同一视角内部、或跨视角互相打架的结论",
    "",
    "取证要求：鼓励用 search_wechat_messages / get_messages_by_range 回原文确认；凡断言「原文里没有」，必须先实际查过。",
    "",
    "每个子代理完成后输出一行：[PROGRESS] 审查 k/" + lenses.length + " 完成",
    "",
    "## 输出",
    "第一部分：Markdown（逐视角列问题）",
    "第二部分：末尾一个 json 代码块：",
    "{",
    '  "reviews": [',
    '    {"lens": "视角名",',
    '     "issues": [{"kind": "对账|无据|遗漏|矛盾", "detail": "问题", "fix": "怎么改"}],',
    '     "corrections": [{"claim": "修正后的结论", "evidence": "依据"}],',
    '     "confidence": 0,',
    '     "missing": ["需要补读但本轮没读到的部分"]}',
    "  ]",
    "}",
    "约束：issues 只列**真问题**，不要为了凑数把站得住的结论也标成问题；confidence 取 0-100（该视角结论的可信度）。",
    "除正文里的这一个 json 块外，不要再输出其它代码块。",
  );
  const extra = String(o.extra || "").trim();
  if (extra) lines.push("", "补充要求（用户自定义，优先遵守）：", extra);
  return lines.join("\n");
}

/** 阶段 4：汇总成稿（保留分歧，删除被判无据的结论，输出沿用既有 schema）。 */
function deepFinalPrompt(o) {
  const dims = o.dims || {};
  const limits = o.limits || {};
  const lines = [
    "你是「报告主笔」。把前面阶段的结论与审查意见合并成最终报告（只读，不要向微信发送任何消息）。",
    "",
    "会话：" + o.sessionName + "（session_id: " + o.sessionId + "）",
    "时间范围：" + o.rangeStart + " ~ " + o.rangeEnd,
    DEEP_WINDOW_NOTE,
    "",
    "## 统计基线（权威）",
    o.statsBrief,
    "",
    "## 已验证的结论与审查意见",
    o.prev,
    "",
    "## 写作要求",
    "- 被审查判为「无据」或与统计基线冲突的结论**必须删掉**，不得写进报告",
    "- 合并后仍存在分歧的地方要如实写出（标注「存在分歧」并给双方依据），不要强行统一",
    "- 结论置信度低时明确标注（如「置信度较低」）",
    "- 面向人读：先给一句话结论再展开；不要复述审查过程、不要提「子代理」「阶段」这些内部概念",
    "",
    "第一部分：Markdown 正文，按下面的结构写：",
    "",
    "开头导语：1-2 句话概括这段时间最核心的内容（让人 30 秒抓住重点，不要复述下面的分类）。",
    "",
    "分类要点：根据实际内容**自行归纳** 3-6 个分类，每个分类标题带一个贴切的 emoji。",
    "（分类名要贴合实际内容；没有内容的分类不要出现；同一话题多人讨论要归并）",
    "",
  ];
  AI_FORMAT_RULES.forEach((x) => lines.push(x));
  lines.push("", "附加章节（按需，没有就不写）：");
  let idx = 1;
  if (dims.topics) lines.push(idx++ + ". 主要议题（分点，标注参与人）");
  if (dims.todos) lines.push(idx++ + ". 关键结论 / 待办 / 需要谁跟进");
  if (dims.risks) lines.push(idx++ + ". 争议点与风险");
  if (dims.sentiment) lines.push(idx++ + ". 群氛围与情绪走向（结合统计与原文，不要编造）");
  lines.push("", "第二部分：在正文最后追加一个 json 代码块（用三个反引号包裹，标注 json），只放结构化数据，不要写注释：", "{");
  lines.push(aiJsonFields(dims, limits).join(",\n"));
  lines.push("}");
  lines.push("", "约束：");
  aiJsonConstraints(dims, limits).forEach((x) => lines.push(x));
  lines.push("除正文里的这一个 json 块外，不要再输出其它代码块。");
  const extra = String(o.extra || "").trim();
  if (extra) lines.push("", "补充要求（用户自定义，优先遵守）：", extra);
  return lines.join("\n");
}

/* ============================ 基础工具 ============================ */

function log(api, msg) {
  try {
    api.log("[wechat] " + msg);
  } catch (err) {
    /* ignore */
  }
}

function errText(err) {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  return String(err.message || err);
}

function pretty(v, max) {
  let s;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v, null, 2);
    } catch (err) {
      s = String(v);
    }
  }
  if (s === undefined || s === null) s = String(s);
  const limit = max || 0;
  if (limit && s.length > limit) return s.slice(0, limit) + "\n…(共 " + s.length + " 字符)";
  return s;
}

function preview(v, n) {
  return pretty(v, n || 700);
}

/** 逐层解包 MCP 返回：JSON 字符串 → 信封 → 真实载荷 */
function unwrapMcp(payload) {
  let cur = payload;
  for (let depth = 0; depth < 6; depth++) {
    if (cur === undefined || cur === null) return null;
    if (typeof cur === "string") {
      const s = cur.trim();
      if (!s) return "";
      try {
        cur = JSON.parse(s);
      } catch (err) {
        return cur;
      }
      continue;
    }
    if (Array.isArray(cur)) return cur;
    if (typeof cur !== "object") return cur;
    if (cur.structuredContent && cur.structuredContent.result !== undefined) {
      cur = cur.structuredContent.result;
      continue;
    }
    if (Array.isArray(cur.content)) {
      const texts = [];
      for (const item of cur.content) {
        if (item && item.type === "text" && typeof item.text === "string") texts.push(item.text);
      }
      if (texts.length === 1) {
        cur = texts[0];
        continue;
      }
      if (texts.length > 1) {
        const out = [];
        for (const t of texts) {
          try {
            out.push(JSON.parse(t));
          } catch (err) {
            out.push(t);
          }
        }
        return out;
      }
    }
    if (cur.result !== undefined) {
      cur = cur.result;
      continue;
    }
    if (cur.data !== undefined && (Array.isArray(cur.data) || (cur.data && typeof cur.data === "object"))) {
      cur = cur.data;
      continue;
    }
    return cur;
  }
  return cur;
}

/** 宽松取数组 */
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    for (const k of ["result", "data", "items", "sessions", "messages", "list", "rows"]) {
      if (Array.isArray(v[k])) return v[k];
    }
    if (v.session_id || v.id) return [v];
  }
  return [];
}

async function callToolRaw(api, toolName, args) {
  const full = MCP_SERVER + "-" + toolName;
  const res = await api.write.run("mcpTools.call", { toolFullName: full, args: args || {} });
  if (!res || !res.ok) {
    const reason = res && res.denied ? res.denied.reason : res && res.error ? res.error : "未知错误";
    throw new Error(full + "：" + reason);
  }
  return res.data;
}

async function callTool(api, toolName, args) {
  return unwrapMcp(await callToolRaw(api, toolName, args));
}

/* ============================ 图片渲染 ============================
   参考 com.github.xqchencn.snow-file-explorer 的官方做法：
   ESM 面板与渲染进程同上下文，可直接用 window.snow.readFileContent(path)
   拿到 { isImage, content(base64), mimeType }，拼成 data: URL 交给 <img>。
   宿主该通道对路径无限制（workspace-directories:read-file → native.readFileContent），
   但按扩展名判定 isImage —— 微信的 .dat 不是图片扩展名，会回落 MCP 解码。
   ------------------------------------------------------------------ */

const IMG_EXT_RE = /\.(png|jpe?g|gif|bmp|webp|ico|avif|svg)$/i;
const IMG_CACHE_MAX = 120;
const _imgCache = new Map();

/* 图片解密并发闸门：图片改为直出后，一屏可能同时挂几十个 McpImage，
   一起打 MCP 会让解密串成长队、拖慢首屏。这里全局排队，最多 3 个并发。 */
const IMG_CONCURRENCY = 3;
let _imgRunning = 0;
const _imgQueue = [];
function withImageSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      _imgRunning++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          _imgRunning--;
          const next = _imgQueue.shift();
          if (next) next();
        });
    };
    if (_imgRunning < IMG_CONCURRENCY) run();
    else _imgQueue.push(run);
  });
}

/* 头像批量查询的失败重试次数。MCP 服务随 App 启动时，首次工具调用可能失败 / 超时；
   一次失败就返回空 Map 会让头像整屏消失（刷新才恢复），所以重试几次。 */
const AVATAR_RETRY = 3;
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDatPath(p) {
  return /\.dat$/i.test(String(p || ""));
}

function isRealImagePath(p) {
  return IMG_EXT_RE.test(String(p || ""));
}

/** 这个字符串值看起来像可以直接渲染的图片路径吗（表格里判定用） */
function isImageLikePath(p) {
  const s = String(p || "");
  if (!s || s.length > 480) return false;
  if (/\s/.test(s)) return false;
  return isDatPath(s) || isRealImagePath(s);
}

/** 宿主读盘通道（不可用时返回 null，由调用方回落 MCP） */
function hostReadFile(path) {
  try {
    const snow = window.snow;
    if (!snow || typeof snow.readFileContent !== "function") return null;
    return snow.readFileContent(path);
  } catch (err) {
    return null;
  }
}

/**
 * 把磁盘上的「真实图片文件」读成 data URL（宿主读盘，零 MCP 往返 + LRU 缓存）。
 * 注意：微信 .dat 是私有容器，宿主按扩展名判定不会认作图片，必须先用 MCP
 * get_message_image 解密导出成真实图片文件，再把该 file_path 交给本函数。
 * @returns Promise<{ok:true,dataUrl,via}|{ok:false,error}>
 */
function loadImageDataUrl(api, absPath) {
  const key = String(absPath || "");
  if (!key) return Promise.resolve({ ok: false, error: "空路径" });
  const cached = _imgCache.get(key);
  if (cached) return cached;

  const task = (async () => {
    const pending = hostReadFile(key);
    if (pending) {
      try {
        const res = await pending;
        if (res && res.isImage && res.content) {
          return {
            ok: true,
            dataUrl: "data:" + (res.mimeType || "image/png") + ";base64," + res.content,
            via: "host",
          };
        }
      } catch (err) {
        /* 宿主拒绝（路径不是图片扩展名等）→ 交给调用方提示 */
      }
    }
    // 无 MCP 回落：.dat 是私有容器，必须先经 MCP 解密导出成真实图片文件才能被宿主读盘。
    return { ok: false, error: "宿主未读到图片（.dat 私有容器需先经 MCP 解密导出）" };
  })();

  if (_imgCache.size >= IMG_CACHE_MAX) {
    const oldest = _imgCache.keys().next().value;
    if (oldest !== undefined) _imgCache.delete(oldest);
  }
  _imgCache.set(key, task);
  return task;
}

/** 批量取发言者头像：一次 MCP 调用换回整页 username 的头像文件路径，再并发读盘成 data URL。
 *  缺失（群成员头像没缓存过 / 头像库里没有该 username）静默跳过，由调用方回退到首字母色块。
 *  ⚠️ MCP 服务随 App 启动时，**首次**工具调用可能失败 / 超时。若一次失败就返回空 Map，
 *  表现就是「打开面板头像全丢、手动刷新一下又有了」。因此这里对失败做有限重试。 */
async function fetchAvatarMap(api, usernames) {
  const list = Array.from(new Set((usernames || []).filter(Boolean)));
  if (!list.length) return {};
  let lastErr = null;
  for (let attempt = 0; attempt < AVATAR_RETRY; attempt++) {
    if (attempt) await sleepMs(250 * attempt);
    try {
      const raw = await callToolRaw(api, "get_user_avatars", { usernames: list });
      const r = unwrapMcp(raw);
      const map = (r && r.avatars) || {};
      const out = {};
      await Promise.all(
        Object.keys(map).map(async (u) => {
          const fp = map[u] && map[u].file_path;
          if (!fp) return;
          const img = await loadImageDataUrl(api, fp);
          if (img && img.ok) out[u] = img.dataUrl;
        }),
      );
      log(api, "avatars " + Object.keys(out).length + "/" + list.length + (attempt ? " (第 " + (attempt + 1) + " 次)" : ""));
      return out;
    } catch (err) {
      lastErr = err;
      log(api, "avatars 第 " + (attempt + 1) + "/" + AVATAR_RETRY + " 次失败：" + errText(err));
    }
  }
  log(api, "avatars 最终失败：" + errText(lastErr));
  return {};
}

/** 发言者头像节点：有真头像用 <img>，否则回退到「首字母 + 稳定色」色块（续行留空占位） */
function avatarNode(sender, cont, dataUrl) {
  const cls = "swf-av" + (cont ? " swf-av-ghost" : "");
  if (cont) return h("div", { className: cls }, "");
  if (dataUrl) return h("div", { className: cls }, h("img", { className: "swf-av-img", src: dataUrl, alt: "" }));
  return h("div", { className: cls, style: { background: speakerColor(sender) } }, avatarChar(sender));
}

/** 「聊天记录」合并转发消息：本地索引里只剩 `[聊天记录] 标题`，被合并的正文要按需回 MCP 取。
 *  默认收起，点开才发一次 get_chat_record（避免一屏几十条一起打 MCP）。 */
function ChatRecord({ api, messageId, title }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState("idle"); // idle | loading | ready | error
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    setPhase("loading");
    setErr("");
    callToolRaw(api, "get_chat_record", { message_id: messageId })
      .then((raw) => {
        const r = unwrapMcp(raw);
        if (r && r.error) {
          setErr(String(r.error));
          setPhase("error");
        } else {
          setData(r || null);
          setPhase("ready");
        }
      })
      .catch((e) => {
        setErr(errText(e));
        setPhase("error");
      });
  }, [api, messageId]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && phase === "idle") load();
  };

  const items = (data && data.items) || [];
  const count = data && typeof data.count === "number" ? data.count : items.length;

  return h(
    "div",
    { className: "swf-rec" + (open ? " swf-rec-open" : "") },
    h(
      "button",
      { type: "button", className: "swf-rec-head", onClick: toggle },
      h("span", { className: "swf-rec-ico" }, open ? "▾" : "▸"),
      h("span", { className: "swf-rec-title" }, title || "聊天记录"),
      phase === "ready" ? h("span", { className: "swf-rec-n" }, count + " 条") : null,
    ),
    open
      ? h(
          "div",
          { className: "swf-rec-body" },
          phase === "loading"
            ? h("div", { className: "swf-rec-hint" }, "读取中…")
            : phase === "error"
              ? h("div", { className: "swf-rec-hint swf-rec-err" }, err || "读取失败")
              : items.length
                ? items.map((it, i) =>
                    h(
                      "div",
                      { className: "swf-rec-item", key: String(i) },
                      h(
                        "div",
                        { className: "swf-rec-meta" },
                        h(
                          "span",
                          { className: "swf-rec-who", style: { color: speakerColor(it.sender || "?") } },
                          it.sender || "?",
                        ),
                        it.time ? h("span", { className: "swf-rec-time" }, it.time) : null,
                        it.type && it.type !== "text" ? h("span", { className: "swf-rec-kind" }, it.type) : null,
                      ),
                      h("div", { className: "swf-rec-desc" }, it.desc || "[" + (it.type || "内容") + "]"),
                    ),
                  )
                : h("div", { className: "swf-rec-hint" }, "（无内容）"),
        )
      : null,
  );
}

/** 用内置右侧阅读器打开原文件（panels.openFile 是公开 UI 导航动作，filePath 须绝对路径） */
async function openLocalFile(api, absPath) {
  const p = String(absPath || "");
  if (!p) return;
  try {
    const res = await api.write.run("panels.openFile", { filePath: p });
    if (!res || !res.ok) {
      log(api, "openFile 失败：" + ((res && (res.error || (res.denied && res.denied.reason))) || "未知"));
    }
  } catch (err) {
    log(api, "openFile 异常：" + errText(err));
  }
}

/** 图片渲染组件：骨架 → 真实图片；失败给出可操作的原因 + 打开文件 */
function ImagePreview({ api, path, title, onOpen, compact }) {
  const [state, setState] = useState(path ? { phase: "loading" } : { phase: "none" });

  useEffect(() => {
    let alive = true;
    if (!path) {
      setState({ phase: "none" });
      return undefined;
    }
    setState({ phase: "loading" });
    loadImageDataUrl(api, path).then((res) => {
      if (!alive) return;
      if (res && res.ok) setState({ phase: "ready", dataUrl: res.dataUrl, via: res.via });
      else setState({ phase: "fail", needKey: !!(res && res.needKey), error: (res && res.error) || "无法渲染" });
    });
    return () => {
      alive = false;
    };
  }, [api, path]);

  const box = "swf-imgbox" + (compact ? " swf-imgbox-compact" : "");

  if (state.phase === "none") return null;
  if (state.phase === "loading") {
    return h("div", { className: box + " swf-imgbox-loading" }, "加载图片…");
  }
  if (state.phase === "ready") {
    return h(
      "div",
      { className: box },
      h("img", {
        className: "swf-img",
        src: state.dataUrl,
        alt: title || "图片",
        loading: "lazy",
        title: onOpen ? "点击用内置阅读器打开原文件" : title || "",
        onClick: onOpen && path ? () => onOpen(path) : undefined,
      }),
    );
  }
  return h(
    "div",
    { className: box + " swf-imgbox-fail" },
    h("span", { className: "swf-imgfail-t" }, state.needKey ? "加密原图" : "无法渲染"),
    h("span", { className: "swf-imgfail-d", title: state.error }, state.error),
    onOpen && path
      ? h("button", { className: "swf-btn swf-btn-mini", onClick: () => onOpen(path) }, "打开文件")
      : null,
  );
}

/**
 * [图片] 消息渲染组件（拥抱上游 MCP 实现）。
 *
 * 链路：消息 id → MCP `get_message_image` 解密导出真实图片文件 → 宿主 readFileContent → data:URL → <img>
 *   - 直出：挂载即自动解密导出（密钥已在 all_keys.json），并发由 withImageSlot 限到 3；失败可重试。
 *   - 成功：上游返回 { success:true, file_path } → 交给 loadImageDataUrl 读成 data URL。
 *   - 失败：上游返回 { error, md5, dat_path, hint }（V2 未载入密钥时）→ 显示原因 + hint + 打开原文件。
 */
function McpImage({ api, messageId, title, onOpen }) {
  // 图片直出：密钥已在 all_keys.json，解密是确定性操作，不再需要「点击加载」这一步。
  // 挂载即自动发起（经 withImageSlot 限流），失败时仍保留「重试」。
  const hasId = !(messageId === undefined || messageId === null || messageId === "");
  const [state, setState] = useState(() => (hasId ? { phase: "loading" } : { phase: "none" }));
  const box = "swf-imgbox";

  const load = useCallback(async () => {
    if (messageId === undefined || messageId === null || messageId === "") {
      setState({ phase: "none" });
      return;
    }
    setState({ phase: "loading" });
    try {
      const raw = await withImageSlot(() => callToolRaw(api, "get_message_image", { message_id: messageId }));
      const r = unwrapMcp(raw);
      if (r && r.success && r.file_path) {
        const img = await loadImageDataUrl(api, r.file_path);
        if (img && img.ok) setState({ phase: "ready", dataUrl: img.dataUrl, filePath: r.file_path });
        else setState({ phase: "fail", error: (img && img.error) || "无法读取解密后的图片", filePath: r.file_path });
        return;
      }
      setState({
        phase: "fail",
        error: (r && r.error) || "上游未返回图片",
        hint: (r && r.hint) || "",
        datPath: (r && r.dat_path) || "",
      });
    } catch (err) {
      setState({ phase: "fail", error: errText(err) });
    }
  }, [api, messageId]);

  // V2 图片密钥只在该账号查看图片时临时缓存于微信进程内存，因此失败卡片上提供
  // 「提取密钥」一键操作：先在微信客户端点开图片 → 点此扫描 → 成功后自动重试解密。
  const extractKey = useCallback(async () => {
    setState({ phase: "extracting" });
    try {
      const raw = await callToolRaw(api, "extract_image_key", {});
      const r = unwrapMcp(raw);
      if (r && r.ok) {
        load();
        return;
      }
      setState({ phase: "fail", error: (r && r.error) || "未找到图片密钥" });
    } catch (err) {
      setState({ phase: "fail", error: errText(err) });
    }
  }, [api, load]);

  // 直出：挂载即拉取（并发由 withImageSlot 限到 3）；messageId 变化时重新拉取
  useEffect(() => {
    if (hasId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasId, messageId]);

  if (state.phase === "none") {
    return h("div", { className: box + " swf-imgbox-none" }, h("span", null, "图片 · 该消息没有可用的 id"));
  }
  if (state.phase === "loading") {
    return h("div", { className: box + " swf-imgbox-loading" }, "解密导出中…");
  }
  if (state.phase === "extracting") {
    return h("div", { className: box + " swf-imgbox-loading" }, "提取图片密钥中…（请保持微信运行）");
  }
  if (state.phase === "ready") {
    return h(
      "div",
      { className: box },
      h("img", {
        className: "swf-img",
        src: state.dataUrl,
        alt: title || "图片",
        loading: "lazy",
        title: onOpen && state.filePath ? "点击用内置阅读器打开" : title || "",
        onClick: onOpen && state.filePath ? () => onOpen(state.filePath) : undefined,
      }),
    );
  }
  // 失败：如实说原因。注意——**不给「打开原文件」**：.dat 是加密容器，
  // 内置阅读器打开只是一坨二进制，给了反而误导。只有真拿到解密后的真实文件才给「打开文件」。
  const openTarget = state.filePath || "";
  // 缺 V2 密钥是可自助修复的（先去微信看图，再扫内存），单独给一条中文引导 + 按钮，
  // 否则用户只能对着一行英文报错发愣。
  const needKey = /image_aes_key/i.test(state.error || "");
  return h(
    "div",
    { className: box + " swf-imgbox-fail" },
    h("span", { className: "swf-imgfail-t" }, "图片未解密"),
    h("span", { className: "swf-imgfail-d", title: state.error }, state.error || "未知原因"),
    needKey
      ? h(
          "span",
          { className: "swf-imgfail-d" },
          "微信 4.x 的图片密钥只在该账号查看图片时临时缓存：请先在微信客户端点开 1-2 张图片，再点「提取密钥」。",
        )
      : null,
    state.hint ? h("span", { className: "swf-imgfail-d" }, state.hint) : null,
    state.datPath
      ? h("span", { className: "swf-imgfail-d", title: state.datPath }, "加密原图：…" + String(state.datPath).slice(-44))
      : null,
    h(
      "div",
      { className: "swf-imgfail-ops" },
      h("button", { className: "swf-btn swf-btn-mini", onClick: load }, "重试"),
      needKey ? h("button", { className: "swf-btn swf-btn-mini", onClick: extractKey }, "提取密钥") : null,
      openTarget && onOpen
        ? h("button", { className: "swf-btn swf-btn-mini", onClick: () => onOpen(openTarget) }, "打开文件")
        : null,
    ),
  );
}

/* 表情消息（[表情]）：按 md5 从本地明文表情库取图并渲染。
 *
 * 链路：消息 emoticon_md5 → MCP `get_emoticon_image` → 本地明文表情文件 → 宿主读盘 → <img>
 *   - 表情文件是账号级加密的，解密已在 MCP 侧由 `prepare_emoticons` 一次性做好；
 *     wxgf 私有容器会在首次取用时现转码（约 1 秒），之后命中缓存。
 *   - **取不到时静默回退成 `[表情]` 文本**，不弹错误框：历史消息的表情大多已被
 *     微信清理，属正常情况，弹错只会让整屏消息变吵。
 */
function McpEmoticon({ api, md5, title, onOpen }) {
  const [state, setState] = useState(() => ({ phase: md5 ? "loading" : "none" }));

  useEffect(() => {
    let alive = true;
    if (!md5) {
      setState({ phase: "none" });
      return undefined;
    }
    (async () => {
      try {
        const raw = await withImageSlot(() => callToolRaw(api, "get_emoticon_image", { md5: md5 }));
        const r = unwrapMcp(raw);
        if (!alive) return;
        if (r && r.success && r.file_path) {
          const img = await loadImageDataUrl(api, r.file_path);
          if (!alive) return;
          if (img && img.ok) {
            setState({ phase: "ready", dataUrl: img.dataUrl, filePath: r.file_path });
            return;
          }
        }
        setState({ phase: "none" });
      } catch (err) {
        if (alive) setState({ phase: "none" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, md5]);

  if (state.phase === "ready") {
    return h("img", {
      className: "swf-emo",
      src: state.dataUrl,
      alt: title || "表情",
      loading: "lazy",
      title: onOpen && state.filePath ? "点击用内置阅读器打开" : title || "",
      onClick: onOpen && state.filePath ? () => onOpen(state.filePath) : undefined,
    });
  }
  return h("span", { className: "swf-emo-txt" }, "[表情]");
}

/* ---------- 文本解析 ---------- */

const MEDIA_TAGS = ["图片", "视频", "文件", "语音", "表情", "链接"];

function extractBetween(s, open, close) {
  const i = s.indexOf(open);
  if (i < 0) return "";
  const j = s.indexOf(close, i + open.length);
  if (j < 0) return "";
  return s.slice(i + open.length, j);
}

/** 取出 `<![CDATA[ ... ]]>` 里的内容；没有 CDATA 就原样返回 */
function cdata(s) {
  const i = String(s || "").indexOf("<![CDATA[");
  if (i < 0) return String(s || "");
  const j = String(s).indexOf("]]>", i + 9);
  if (j < 0) return String(s).slice(i + 9);
  return String(s).slice(i + 9, j);
}

/** 把模板里的 $username$ / $names$ 之类占位符，按 <link name="…"> 分组里的昵称填回去 */
function fillPlaceholders(text, groups, sep) {
  let out = "";
  let i = 0;
  const s = String(text || "");
  for (;;) {
    const a = s.indexOf("$", i);
    if (a < 0) {
      out += s.slice(i);
      break;
    }
    const b = s.indexOf("$", a + 1);
    if (b < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, a);
    const key = s.slice(a + 1, b);
    const g = groups.find((x) => x.name === key);
    out += g && g.nicks.length ? g.nicks.join(sep) : "";
    i = b + 1;
  }
  return out;
}

/**
 * 把 `<sysmsg>` 系统消息（入群提示、撤回、群公告等）解析成一句人话。
 * 返回 null 表示不是系统消息。
 */
function sysmsgText(content) {
  const c = String(content === undefined || content === null ? "" : content);
  if (c.indexOf("<sysmsg") < 0) return null;

  let text = cdata(extractBetween(c, "<template>", "</template>"));
  if (!text) text = extractBetween(c, "<plain>", "</plain>");
  if (!text) return "系统消息";

  // 收集每个 <link name="…"> 段里的昵称
  const groups = [];
  let from = 0;
  for (;;) {
    const i = c.indexOf("<link ", from);
    if (i < 0) break;
    const j = c.indexOf("</link>", i);
    if (j < 0) break;
    const seg = c.slice(i, j);
    const nm = extractBetween(seg, 'name="', '"');
    const nicks = [];
    let k = 0;
    for (;;) {
      const a = seg.indexOf("<nickname>", k);
      if (a < 0) break;
      const b = seg.indexOf("</nickname>", a);
      if (b < 0) break;
      const nick = cdata(seg.slice(a + 10, b)).trim();
      if (nick) nicks.push(nick);
      k = b + 11;
    }
    groups.push({ name: nm, nicks: nicks });
    from = j + 7;
  }

  const sep = cdata(extractBetween(c, "<separator>", "</separator>")) || "、";
  let out = fillPlaceholders(text, groups, sep).trim();

  // 兜底：还有没替换掉的占位符就用分组里的第一个昵称顶上
  const all = [];
  for (const g of groups) for (const n of g.nicks) if (all.indexOf(n) < 0) all.push(n);
  if (out.indexOf("$") >= 0) out = fillPlaceholders(out.replace(/\$/g, ""), groups, sep).trim();
  if (!out && all.length) out = all.join(sep);
  return out || "系统消息";
}

/** 拆出引用前缀：`[引用 原文: 说话人] 正文` */
function splitQuote(text) {
  const s = String(text === undefined || text === null ? "" : text);
  if (s.indexOf("[引用") !== 0) return null;
  const i = s.indexOf("]");
  if (i < 0) return null;
  const body = s.slice(i + 1).replace(/^\s+/, "");
  return { quote: s.slice(1, i), body: body };
}

/** 再拆一层引用块本身：`引用 昵称: 内容` → { author, text }（用于定位原消息） */
function parseQuote(raw) {
  const s = String(raw || "").replace(/^引用\s*/, "");
  const i = s.indexOf(": ");
  if (i < 0) return { author: "", text: s };
  return { author: s.slice(0, i), text: s.slice(i + 2) };
}

/** 归一化文本用于引用匹配：去掉所有空白，只比内容不看排版 */
function squashText(v) {
  return String(v === undefined || v === null ? "" : v).replace(/\s+/g, "");
}

function classify(content) {
  const c = String(content === undefined || content === null ? "" : content);
  if (c.indexOf("<sysmsg") >= 0) return { tag: "系统", text: c };
  // 引用消息的 tag 只看**正文**：`[引用: [图片]] 正文` 本身是文本消息，
  // 不能被引用块里的 [图片] 带偏 —— 否则面板会把它当图片去调 get_message_image，
  // 那条消息根本没有图片元数据，于是弹出「图片未解密 / 重试」。
  const q = splitQuote(c);
  const b = q ? q.body : c;
  if (b.indexOf("[图片]") >= 0 || b.indexOf("[照片]") >= 0) return { tag: "图片", text: c };
  if (b.indexOf("[视频]") >= 0) return { tag: "视频", text: c };
  if (b.indexOf("[文件]") >= 0 || b.indexOf("[文档]") >= 0) return { tag: "文件", text: c };
  if (b.indexOf("[语音]") >= 0) return { tag: "语音", text: c };
  if (b.indexOf("[动画表情]") >= 0) return { tag: "表情", text: c };
  if (b.indexOf("[聊天记录]") >= 0) return { tag: "聊天记录", text: c };
  if (b.indexOf("http://") >= 0 || b.indexOf("https://") >= 0) return { tag: "链接", text: c };
  if (b.length > 0 && b.length <= 12 && b.charAt(0) === "[" && b.charAt(b.length - 1) === "]") {
    return { tag: "表情", text: c };
  }
  return { tag: "文本", text: c };
}

function isMedia(content) {
  return MEDIA_TAGS.indexOf(classify(content).tag) >= 0;
}

function speakerColor(name) {
  const s = String(name || "?");
  let acc = 0;
  for (let i = 0; i < s.length; i++) acc = (acc * 31 + s.charCodeAt(i)) % 360;
  return "hsl(" + acc + " 62% 50%)";
}

function avatarChar(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  return Array.from(s)[0];
}

function dayKeyOf(time) {
  return String(time || "").slice(0, 10);
}
function hhmmOf(time) {
  return String(time || "").slice(11, 16);
}
function minuteOf(time) {
  const t = String(time || "");
  if (t.length < 16) return -1;
  const d = Number(t.slice(8, 10));
  const hh = Number(t.slice(11, 13));
  const mm = Number(t.slice(14, 16));
  if (!Number.isFinite(d) || !Number.isFinite(hh) || !Number.isFinite(mm)) return -1;
  return d * 1440 + hh * 60 + mm;
}
/** 同一人在 5 分钟内连续发言 → 折叠头像与昵称 */
function sameBurst(a, b) {
  const ma = minuteOf(a);
  const mb = minuteOf(b);
  if (ma < 0 || mb < 0) return false;
  return Math.abs(ma - mb) <= 5;
}

function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  if (v >= 1000000) return (v / 1000000).toFixed(1) + "M";
  if (v >= 10000) return (v / 1000).toFixed(1) + "k";
  return String(v);
}
function fmtPct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? (n * 100).toFixed(1) + "%" : "—";
}
/* 横条榜：items = [{name, count, suffix}]；条长按最大值归一，opts.max 可覆盖分母 */
function bars(items, opts) {
  const o = opts || {};
  const list = (items || []).filter((x) => x && (x.name || x.label) && Number(x.count) > 0);
  if (!list.length) return null;
  const max = Number(o.max) > 0 ? Number(o.max) : list.reduce((a, x) => Math.max(a, Number(x.count) || 0), 1);
  return list.map((x, i) => {
    const name = String(x.name || x.label || "");
    const n = Number(x.count) || 0;
    const color = typeof o.color === "function" ? o.color(name) : o.color || ACCENT;
    return h(
      "div",
      { className: "swf-bar-row", key: (o.key || "bar") + "-" + i },
      h(
        "div",
        { className: "swf-bar-label", title: name },
        o.rank !== false && i < 3 ? h("span", { className: "swf-rank-medal swf-rank-" + (i + 1) }, ["🥇", "🥈", "🥉"][i]) : null,
        h("span", { className: "swf-bar-name" }, name),
      ),
      h(
        "div",
        { className: "swf-bar-track" },
        h("div", {
          className: "swf-bar-fill",
          // 最小 2.5%：小条目（如类型分布里的「文件 3 条」）否则几乎不可见
          style: { width: Math.max(2.5, Math.min(100, (n / max) * 100)) + "%", background: color },
        }),
      ),
      h("div", { className: "swf-bar-num" + (o.wideNum ? " swf-bar-num-wide" : "") }, fmtNum(n) + (x.suffix || "")),
    );
  });
}
function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}
/* 消息类型分布：MCP 按 local_type 分组返回（保留原始类型是刻意的），展示层必须按 label 合并 ——
   复合 local_type 的高 32 位是 appmsg 子类型，会映射到同一 label（例如两个「视频」），
   不合并就会在同一张图 / 同一份报告里出现两行同名条目。返回 [[label, count]] 降序。 */
function mergeTypeRows(rows) {
  const merged = new Map();
  for (const r of rows || []) {
    const key = String((r && (r.label || r.local_type)) || "其他");
    merged.set(key, (merged.get(key) || 0) + (Number(r && r.count) || 0));
  }
  return Array.from(merged.entries()).sort((a, b) => b[1] - a[1]);
}
/* ============================ 报告 HTML 长图 ============================ */
/* 自包含 HTML（样式内联 + 头像 data URL），用于在浏览器里打开、截图与分享。
   ⚠️ 面板没有截图能力，这里只到 HTML，不生成 PNG —— 不要承诺做不到的形态。 */
function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ============================ 轻量 Markdown 渲染 ============================
   面板是单文件 ESM（无构建、不引第三方依赖），所以自研一个够用的子集：
     块级：ATX 标题 / 水平线 / 引用 / 无序列表 / 有序列表 / 表格 / 围栏代码块 / 段落
     行内：**粗体** / *斜体* / `行内代码` / [文本](链接) / ~~删除线~~
   一份解析、两个后端：React 节点（面板内）与 HTML 字符串（报告长图），
   避免同一段 AI 正文在两处各写一套渲染。
   ------------------------------------------------------------------------- */

/** 行内标记 → 片段数组 [{t:"text"|"strong"|"em"|"code"|"del"|"link", v, href?}] */
function mdInline(text) {
  const src = String(text === undefined || text === null ? "" : text);
  // 斜体必须落在 ASCII 边界上：否则 wechat_daily_report.md / a * b * c 这类文本会被误判
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|(?<![A-Za-z0-9*])\*([^*\s][^*]*?)\*(?![A-Za-z0-9*])|(?<![A-Za-z0-9_])_([^_\s][^_]*?)_(?![A-Za-z0-9_])|\[([^\]]+)\]\((https?:[^)\s]+)\)/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) parts.push({ t: "text", v: src.slice(last, m.index) });
    if (m[1] !== undefined) parts.push({ t: "code", v: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) parts.push({ t: "strong", v: m[2] !== undefined ? m[2] : m[3] });
    else if (m[4] !== undefined) parts.push({ t: "del", v: m[4] });
    else if (m[5] !== undefined || m[6] !== undefined) parts.push({ t: "em", v: m[5] !== undefined ? m[5] : m[6] });
    else parts.push({ t: "link", v: m[7], href: m[8] });
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push({ t: "text", v: src.slice(last) });
  return parts.length ? parts : [{ t: "text", v: "" }];
}

const MD_H_RE = /^\s*(#{1,6})\s+(.*)$/;
const MD_HR_RE = /^\s*([-*_])\s*(\1\s*){2,}$/;
const MD_UL_RE = /^\s*[-*+]\s+/;
const MD_OL_RE = /^\s*\d+[.)]\s+/;
/** Callout 类型表：Markdown 里写 > [!TIP] 标题，样式由渲染后端提供。
    这是「AI 只写语义、CSS 负责好看」的落点 —— 不让模型手写 HTML/CSS，
    否则每次输出的样式都不一样、体积膨胀，还容易写出坏标签。 */
const CALLOUT_KINDS = {
  TIP: { key: "tip", icon: "💡", label: "提示" },
  INFO: { key: "info", icon: "ℹ️", label: "说明" },
  NOTE: { key: "note", icon: "📝", label: "备注" },
  SUCCESS: { key: "success", icon: "✅", label: "结论" },
  QUOTE: { key: "quote", icon: "💬", label: "原话" },
  WARN: { key: "warn", icon: "⚠️", label: "注意" },
  WARNING: { key: "warn", icon: "⚠️", label: "注意" },
  CAUTION: { key: "warn", icon: "⚠️", label: "注意" },
  DANGER: { key: "danger", icon: "🚨", label: "风险" },
  ERROR: { key: "danger", icon: "🚨", label: "风险" },
};
const MD_CALLOUT_RE = /^\s*\[!(\w+)\]\s*(.*)$/;

const MD_QUOTE_RE = /^\s*>\s?/;
const MD_FENCE_RE = /^\s*```\s*([\w+#-]*)\s*$/;

function mdSplitRow(line) {
  return String(line)
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((s) => s.trim());
}

function mdIsTableSep(line) {
  return /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/.test(String(line));
}

/** Markdown → 块数组 */
function mdBlocks(md) {
  const lines = String(md === undefined || md === null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = MD_FENCE_RE.exec(line);
    if (fence) {
      const lang = fence[1] || "";
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过闭合围栏
      out.push({ t: "code", lang: lang, v: buf.join("\n") });
      continue;
    }
    if (MD_HR_RE.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    const h = MD_H_RE.exec(line);
    if (h) {
      out.push({ t: "h", level: h[1].length, v: h[2].trim() });
      i++;
      continue;
    }
    if (line.indexOf("|") >= 0 && i + 1 < lines.length && mdIsTableSep(lines[i + 1]) && lines[i + 1].indexOf("-") >= 0) {
      const head = mdSplitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0 && !MD_H_RE.test(lines[i])) {
        rows.push(mdSplitRow(lines[i]));
        i++;
      }
      out.push({ t: "table", head: head, rows: rows });
      continue;
    }
    if (MD_QUOTE_RE.test(line)) {
      const buf = [];
      while (i < lines.length && MD_QUOTE_RE.test(lines[i])) {
        buf.push(lines[i].replace(MD_QUOTE_RE, ""));
        i++;
      }
      // > [!TIP] 标题 → callout（GitHub / Obsidian 同款语法，模型零学习成本）
      const mark = MD_CALLOUT_RE.exec(buf[0] || "");
      if (mark) {
        out.push({ t: "callout", kind: String(mark[1]).toUpperCase(), title: String(mark[2] || "").trim(), v: buf.slice(1).join("\n").trim() });
      } else {
        out.push({ t: "quote", v: buf.join("\n") });
      }
      continue;
    }
    if (MD_UL_RE.test(line)) {
      const items = [];
      while (i < lines.length && MD_UL_RE.test(lines[i])) {
        items.push(lines[i].replace(MD_UL_RE, ""));
        i++;
      }
      out.push({ t: "ul", items: items });
      continue;
    }
    if (MD_OL_RE.test(line)) {
      const items = [];
      while (i < lines.length && MD_OL_RE.test(lines[i])) {
        items.push(lines[i].replace(MD_OL_RE, ""));
        i++;
      }
      out.push({ t: "ol", items: items });
      continue;
    }
    // 段落：连续普通行合并（遇到任何块级起始就停）
    const buf = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (
        !next.trim() ||
        MD_FENCE_RE.test(next) ||
        MD_H_RE.test(next) ||
        MD_HR_RE.test(next) ||
        MD_QUOTE_RE.test(next) ||
        MD_UL_RE.test(next) ||
        MD_OL_RE.test(next)
      ) {
        break;
      }
      buf.push(next);
      i++;
    }
    out.push({ t: "p", v: buf.join(" ") });
  }
  return out;
}

/** 后端一：React 节点（面板内渲染） */
function mdNodes(parts, keyBase) {
  return parts.map((p, i) => {
    const key = keyBase + "-" + i;
    if (p.t === "strong") return h("strong", { key: key }, p.v);
    if (p.t === "em") return h("em", { key: key }, p.v);
    if (p.t === "code") return h("code", { key: key, className: "swf-md-code" }, p.v);
    if (p.t === "del") return h("del", { key: key }, p.v);
    if (p.t === "link") {
      return h("a", { key: key, className: "swf-md-link", href: p.href, target: "_blank", rel: "noreferrer" }, p.v);
    }
    return p.v;
  });
}

function mdBlockNode(b, i) {
  const key = "md-" + i;
  if (b.t === "hr") return h("hr", { key: key, className: "swf-md-hr" });
  if (b.t === "h") {
    return h("div", { key: key, className: "swf-md-h swf-md-h" + b.level }, mdNodes(mdInline(b.v), key));
  }
  if (b.t === "code") {
    return h(
      "pre",
      { key: key, className: "swf-md-pre" },
      b.lang ? h("div", { className: "swf-md-lang" }, b.lang) : null,
      h("code", null, b.v),
    );
  }
  if (b.t === "callout") {
    const k = CALLOUT_KINDS[b.kind] || CALLOUT_KINDS.NOTE;
    return h(
      "div",
      { key: key, className: "swf-md-callout swf-md-callout-" + k.key },
      h("div", { className: "swf-md-callout-h" }, k.icon + " " + (b.title || k.label)),
      b.v ? h("div", { className: "swf-md-callout-b" }, mdNodes(mdInline(b.v), key + "-b")) : null,
    );
  }
  if (b.t === "quote") return h("blockquote", { key: key, className: "swf-md-quote" }, mdNodes(mdInline(b.v), key));
  if (b.t === "ul" || b.t === "ol") {
    const tag = b.t === "ul" ? "ul" : "ol";
    return h(
      tag,
      { key: key, className: "swf-md-list" },
      b.items.map((it, j) => h("li", { key: key + "-" + j }, mdNodes(mdInline(it), key + "-" + j))),
    );
  }
  if (b.t === "table") {
    return h(
      "table",
      { key: key, className: "swf-md-table" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          b.head.map((c, j) => h("th", { key: key + "-h" + j }, mdNodes(mdInline(c), key + "-h" + j))),
        ),
      ),
      h(
        "tbody",
        null,
        b.rows.map((r, j) =>
          h(
            "tr",
            { key: key + "-r" + j },
            r.map((c, k) => h("td", { key: key + "-r" + j + "-" + k }, mdNodes(mdInline(c), key + "-r" + j + "-" + k))),
          ),
        ),
      ),
    );
  }
  return h("p", { key: key, className: "swf-md-p" }, mdNodes(mdInline(b.v), key));
}

/** Markdown → React 节点（空文本返回 null，便于调用处三元判断） */
function mdToReact(md, opts) {
  const o = opts || {};
  const blocks = mdBlocks(md);
  if (!blocks.length) return null;
  return h("div", { className: "swf-md" + (o.className ? " " + o.className : "") }, blocks.map(mdBlockNode));
}

/** 后端二：HTML 字符串（报告长图，样式由长图自己的 <style> 提供） */
function mdInlineHtml(text) {
  return mdInline(text)
    .map((p) => {
      if (p.t === "strong") return "<strong>" + escHtml(p.v) + "</strong>";
      if (p.t === "em") return "<em>" + escHtml(p.v) + "</em>";
      if (p.t === "code") return '<code class="md-code">' + escHtml(p.v) + "</code>";
      if (p.t === "del") return "<del>" + escHtml(p.v) + "</del>";
      if (p.t === "link") return '<a href="' + escHtml(p.href) + '">' + escHtml(p.v) + "</a>";
      return escHtml(p.v);
    })
    .join("");
}

/** Markdown → HTML 字符串 */
function mdToHtml(md) {
  return mdBlocks(md)
    .map((b) => {
      if (b.t === "hr") return "<hr>";
      if (b.t === "h") return "<h" + b.level + ">" + mdInlineHtml(b.v) + "</h" + b.level + ">";
      if (b.t === "code") return '<pre class="md-pre">' + escHtml(b.v) + "</pre>";
      if (b.t === "callout") {
        const k = CALLOUT_KINDS[b.kind] || CALLOUT_KINDS.NOTE;
        return (
          '<div class="callout callout-' +
          k.key +
          '"><div class="callout-h">' +
          k.icon +
          " " +
          escHtml(b.title || k.label) +
          "</div>" +
          // 与 React 后端保持一致：没有正文行就不输出空的 callout-b
          (b.v ? '<div class="callout-b">' + mdInlineHtml(b.v) + "</div>" : "") +
          "</div>"
        );
      }
      if (b.t === "quote") return "<blockquote>" + mdInlineHtml(b.v) + "</blockquote>";
      if (b.t === "ul" || b.t === "ol") {
        const tag = b.t === "ul" ? "ul" : "ol";
        return "<" + tag + ">" + b.items.map((it) => "<li>" + mdInlineHtml(it) + "</li>").join("") + "</" + tag + ">";
      }
      if (b.t === "table") {
        return (
          "<table><thead><tr>" +
          b.head.map((c) => "<th>" + mdInlineHtml(c) + "</th>").join("") +
          "</tr></thead><tbody>" +
          b.rows.map((r) => "<tr>" + r.map((c) => "<td>" + mdInlineHtml(c) + "</td>").join("") + "</tr>").join("") +
          "</tbody></table>"
        );
      }
      return "<p>" + mdInlineHtml(b.v) + "</p>";
    })
    .join("");
}

/** 长图公共样式：群报告与成员画像共用同一套（样式只在这里维护；
    AI 正文的 callout / md 系列样式也由它提供，模型只写语义不写样式）。 */
const REPORT_CSS =
    "*{box-sizing:border-box}" +
    "body{margin:0;padding:24px 16px;background:#eef1f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#1f2328}" +
    ".card{max-width:760px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 6px 28px rgba(15,23,42,.10)}" +
    // Hero：渐变底 + 群名 + 范围 + 导语 + KPI
    ".hero{background:linear-gradient(135deg,#16a34a 0%,#0f9d58 55%,#0b7a43 100%);color:#fff;padding:26px 30px 22px}" +
    ".hero-tag{display:inline-block;font-size:11px;letter-spacing:.08em;background:rgba(255,255,255,.18);padding:3px 9px;border-radius:999px;margin-bottom:10px}" +
    ".hero h1{margin:0;font-size:23px;line-height:1.3;font-weight:700}" +
    ".hero-range{font-size:12px;opacity:.86;margin-top:6px;font-variant-numeric:tabular-nums}" +
    ".hero-lead{margin-top:14px;font-size:13.5px;line-height:1.7;background:rgba(255,255,255,.14);border-radius:10px;padding:11px 13px;border-left:3px solid rgba(255,255,255,.55)}" +
    ".kpis{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}" +
    ".kpi{flex:1 1 116px;background:rgba(255,255,255,.14);border-radius:10px;padding:9px 12px}" +
    ".kpi .k{font-size:11px;opacity:.85}" +
    ".kpi .v{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px}" +
    ".body{padding:6px 30px 26px}" +
    // 章节标题：左侧色条（emoji 由 AI 写在标题里，样式统一由这里给）
    ".sec{margin:26px 0 12px;font-size:14px;font-weight:700;color:#111827;padding-left:10px;border-left:3px solid #16a34a;line-height:1.4}" +
    ".sec small{font-weight:400;color:#6b7280;font-size:11.5px;margin-left:6px}" +
    ".muted{color:#6b7280;font-size:12px}" +
    ".row{display:flex;align-items:center;gap:10px;margin:6px 0}" +
    ".lbl{flex:0 0 36%;display:flex;align-items:center;gap:6px;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".medal{flex:0 0 auto;font-size:13px}" +
    ".track{flex:1 1 auto;height:12px;border-radius:6px;background:#eceef1;overflow:hidden}" +
    ".track i{display:block;height:100%;border-radius:6px}" +
    ".num{flex:0 0 auto;width:52px;text-align:right;font-size:11.5px;color:#6b7280;font-variant-numeric:tabular-nums}" +
    ".face{width:18px;height:18px;border-radius:50%;object-fit:cover;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#fff;flex:0 0 auto}" +
    ".chart{display:flex;align-items:flex-end;gap:3px;height:120px;padding:0 2px;border-bottom:1px solid #eceef1}" +
    ".col{flex:1 1 0;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px}" +
    ".bar{width:100%;min-height:2px;border-radius:3px 3px 0 0;background:linear-gradient(180deg,#22c55e,#16a34a)}" +
    ".x{font-size:9px;color:#9ca3af;white-space:nowrap}" +
    // 24×7 热力（本地精确数据）
    ".heat{display:flex;flex-direction:column;gap:3px;margin-top:4px}" +
    ".heat-row{display:flex;align-items:center;gap:3px}" +
    ".heat-k{flex:0 0 16px;font-size:10px;color:#9ca3af;text-align:center}" +
    ".heat-cell{flex:1 1 0;min-width:0;height:15px;border-radius:3px}" +
    ".heat-axis{display:flex;gap:3px;padding-left:19px;margin-top:2px}" +
    ".heat-ax{flex:1 1 0;font-size:9px;color:#9ca3af;text-align:center}" +
    ".quote{position:relative;margin:9px 0;padding:11px 14px 11px 34px;background:#f8fafc;border-radius:10px;border-left:3px solid #a7f3d0;font-size:13px;line-height:1.7}" +
    ".quote::before{content:'“';position:absolute;left:11px;top:6px;font-size:22px;color:#86efac;font-family:Georgia,serif;line-height:1}" +
    ".quote .muted{margin-left:6px}" +
    ".item{font-size:13px;margin:5px 0;line-height:1.65}" +
    // Callout：AI 正文里的 > [!TIP] 之类，样式全在这（模型只写语义）
    ".callout{margin:11px 0;padding:10px 13px;border-radius:10px;border-left:3px solid #9ca3af;background:#f7f8fa;font-size:13px;line-height:1.7}" +
    ".callout-h{font-weight:600;font-size:12.5px;margin-bottom:3px}" +
    ".callout-tip{border-color:#16a34a;background:rgba(22,163,74,.07)}" +
    ".callout-info{border-color:#2563eb;background:rgba(37,99,235,.07)}" +
    ".callout-note{border-color:#9ca3af;background:#f7f8fa}" +
    ".callout-success{border-color:#0d9488;background:rgba(13,148,136,.07)}" +
    ".callout-quote{border-color:#7c3aed;background:rgba(124,58,237,.06)}" +
    ".callout-warn{border-color:#f59e0b;background:rgba(245,158,11,.10)}" +
    ".callout-danger{border-color:#dc2626;background:rgba(220,38,38,.07)}" +
    // AI 正文（Markdown）
    ".md{font-size:13.5px;line-height:1.78}" +
    ".md h1{font-size:19px;margin:18px 0 10px;padding-bottom:6px;border-bottom:1px solid #eceef1}" +
    ".md h2{font-size:15.5px;color:#111827;margin:20px 0 9px;padding-left:9px;border-left:3px solid #16a34a}" +
    ".md h3{font-size:14px;color:#111827;margin:15px 0 7px}" +
    ".md h4,.md h5,.md h6{font-size:13px;color:#374151;margin:12px 0 6px}" +
    ".md p{margin:9px 0}" +
    ".md ul,.md ol{margin:9px 0;padding-left:22px}" +
    ".md li{margin:5px 0}" +
    ".md strong{color:#0f172a}" +
    ".md blockquote{margin:11px 0;padding:9px 13px;border-left:3px solid #d1d5db;background:#f7f8fa;border-radius:8px;color:#4b5563}" +
    ".md code{background:#f0f1f3;padding:1px 5px;border-radius:4px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}" +
    ".md-pre{background:#f7f8fa;border:1px solid #eceef1;border-radius:8px;padding:10px 12px;overflow:auto;font-size:12.5px;white-space:pre}" +
    ".md hr{border:none;border-top:1px solid #eceef1;margin:16px 0}" +
    ".md table{border-collapse:collapse;width:100%;margin:11px 0;font-size:12.5px}" +
    ".md th,.md td{border:1px solid #e5e7eb;padding:6px 9px;text-align:left}" +
    ".md th{background:#f7f8fa}" +
    ".md a{color:#2563eb;text-decoration:none}" +
    "footer{margin-top:26px;padding-top:13px;border-top:1px solid #eceef1;color:#9ca3af;font-size:11px;line-height:1.7}";

/** 长图横条行：群报告与成员画像共用（前 3 名带奖牌）。 */
const REPORT_MEDALS = ["🥇", "🥈", "🥉"];
function reportRow(name, count, max, color, faceHtml, rank) {
  return (
    '<div class="row">' +
    '<div class="lbl">' +
    (rank && rank <= 3 ? '<span class="medal">' + REPORT_MEDALS[rank - 1] + "</span>" : "") +
    (faceHtml || "") +
    escHtml(name) +
    "</div>" +
    '<div class="track"><i style="width:' + Math.max(1, Math.round((count / max) * 100)) + "%;background:" + color + '"></i></div>' +
    '<div class="num">' + escHtml(fmtNum(count)) + "</div>" +
    "</div>"
  );
}

function buildReportHtml(opts) {
  const o = opts || {};
  const stats = o.stats || {};
  const avatarMap = o.avatarMap || {};
  const total = Number(stats.total_messages) || 0;
  const senders = Number(stats.unique_senders) || 0;
  const perCapita = senders ? Math.round(total / senders) : 0;
  const points = (o.trend && o.trend.points) || [];
  const peak = points.reduce((a, p) => (p.value > a.value ? p : a), { value: 0, key: "" });
  const peakShort = String(peak.key).length > 10 ? String(peak.key).slice(11) : String(peak.key);
  const peakLabel = peak.value ? peakShort + (o.trend && o.trend.kind === "hour" ? ":00" : "") : "—";
  const maxPoint = points.reduce((a, p) => Math.max(a, p.value), 1);

  const rowsHtml = (rows, color, withFace, withRank) => {
    const max = rows.reduce((a, x) => Math.max(a, x.count), 1);
    return rows
      .map((x, i) => {
        const src = withFace && x.u && avatarMap[x.u] ? avatarMap[x.u] : "";
        const face = withFace
          ? src
            ? '<img class="face" src="' + escHtml(src) + '" alt="">'
            : '<span class="face" style="background:' + speakerColor(x.name) + '">' + escHtml(avatarChar(x.name)) + "</span>"
          : "";
        return reportRow(x.name, x.count, max, color, face, withRank ? i + 1 : 0);
      })
      .join("");
  };

  const memberRows = ((stats.member_rank || []) || [])
    .filter((m) => (m.u || m.username || "") !== (o.sessionId || ""))
    .slice(0, 10)
    .map((m) => ({ name: m.name || m.u || "?", count: Number(m.messages) || 0, u: m.u }));
  const typeRows = mergeTypeRows(stats.type_distribution || []).slice(0, 10).map(([name, count]) => ({ name: name, count: count }));
  const quotedRows = (((stats.quote_network || {}).top_quoted) || []).slice(0, 8).map((x) => ({ name: x.name, count: Number(x.count) || 0 }));

  const trendBars = points
    .map(
      (p) =>
        '<div class="col" title="' + escHtml(p.key + " · " + p.value) + '">' +
        '<div class="bar" style="height:' + Math.max(1, Math.round((p.value / maxPoint) * 100)) + '%"></div>' +
        '<div class="x">' + escHtml(p.label || "") + "</div></div>",
    )
    .join("");

  // 24×7 热力：本地 SQL 精确聚合，长图里最能一眼看出「这个群什么时候活」
  const heat = heatGrid(stats);
  const heatHtml = heat.hasData
    ? '<div class="heat">' +
      heat.rows
        .map(
          (r) =>
            '<div class="heat-row"><span class="heat-k">' +
            escHtml(r.label) +
            "</span>" +
            r.cells
              .map(
                (c) =>
                  '<span class="heat-cell" title="周' +
                  escHtml(r.label) +
                  " " +
                  c.hour +
                  ":00 — " +
                  c.count +
                  '" style="background:' +
                  heatColor(c.count, heat.max) +
                  '"></span>',
              )
              .join("") +
            "</div>",
        )
        .join("") +
      '<div class="heat-axis">' +
      heat.rows[0].cells.map((c, hi) => '<span class="heat-ax">' + (hi % 6 === 0 ? c.hour : "") + "</span>").join("") +
      "</div></div>"
    : "";

  const aiText = String(o.aiText || "").replace(/```json[\s\S]*?```/i, "").trim();
  const ai = o.aiData || {};
  const list = (x) => (Array.isArray(x) ? x : []);
  // 导语：AI 的一句话摘要（Hero 区视觉焦点）
  const lead = String(ai.summary || "").trim();
  const aiBlocks = [];
  if (aiText) aiBlocks.push('<div class="sec">AI 分析</div><div class="md">' + mdToHtml(aiText) + "</div>");
  if (list(ai.titles).length) {
    aiBlocks.push(
      '<div class="sec">称号</div>' +
        list(ai.titles)
          .map((x) => '<div class="item"><b>' + escHtml(x.who) + "</b> · " + escHtml(x.title) + (x.reason ? '<span class="muted">（' + escHtml(x.reason) + "）</span>" : "") + "</div>")
          .join(""),
    );
  }
  if (list(ai.quotes).length) {
    aiBlocks.push(
      '<div class="sec">金句</div>' +
        list(ai.quotes)
          .map((x) => '<div class="quote">' + escHtml(x.text) + (x.who ? '<span class="muted">—— ' + escHtml(x.who) + "</span>" : "") + "</div>")
          .join(""),
    );
  }
  if (ai.profile && typeof ai.profile === "object") {
    aiBlocks.push(
      '<div class="sec">群画像</div>' +
        (ai.profile.summary ? '<div class="item">' + escHtml(ai.profile.summary) + "</div>" : "") +
        (ai.profile.style ? '<div class="item"><span class="muted">风格：</span>' + escHtml(ai.profile.style) + "</div>" : "") +
        list(ai.profile.advice)
          .map((a) => '<div class="item">· ' + escHtml(a) + "</div>")
          .join(""),
    );
  }

  return (
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>" + escHtml((o.periodLabel ? o.periodLabel + " · " : "") + (o.title || "群聊报告")) + "</title>" +
    "<style>" + REPORT_CSS + "</style></head><body><main class=\"card\">" +
    "<header class=\"hero\">" +
    (o.periodLabel ? '<div class="hero-tag">' + escHtml(o.periodLabel) + "</div>" : "") +
    "<h1>" + escHtml(o.title || "群聊报告") + "</h1>" +
    '<div class="hero-range">' + escHtml(o.rangeLabel || "") + "</div>" +
    (lead ? '<div class="hero-lead">' + escHtml(lead) + "</div>" : "") +
    '<section class="kpis">' +
    '<div class="kpi"><div class="k">💬 消息</div><div class="v">' + escHtml(fmtNum(total)) + "</div></div>" +
    '<div class="kpi"><div class="k">👥 发言人数</div><div class="v">' + escHtml(fmtNum(senders)) + "</div></div>" +
    '<div class="kpi"><div class="k">📊 人均消息</div><div class="v">' + escHtml(String(perCapita)) + "</div></div>" +
    '<div class="kpi"><div class="k">🔥 峰值</div><div class="v">' + escHtml(peakLabel) + "</div></div>" +
    "</section></header>" +
    '<div class="body">' +
    (points.length ? '<div class="sec">' + escHtml((o.trend && o.trend.title) || "趋势") + '</div><div class="chart">' + trendBars + "</div>" : "") +
    (heatHtml ? '<div class="sec">活跃热力<small>星期 × 小时</small></div>' + heatHtml : "") +
    (memberRows.length ? '<div class="sec">成员榜<small>Top 10 · 发言条数</small></div>' + rowsHtml(memberRows, ACCENT, true, true) : "") +
    (quotedRows.length ? '<div class="sec">被引用榜</div>' + rowsHtml(quotedRows, ACCENT, false, false) : "") +
    (typeRows.length ? '<div class="sec">消息类型</div>' + rowsHtml(typeRows, ACCENT, false, false) : "") +
    aiBlocks.join("") +
    "</div>" +
    "<footer>由 Snow App「微信群聊」面板生成 · " + escHtml(o.generatedAt || "") + " · 数据来自本机 wechat MCP（只读）</footer>" +
    "</main></body></html>"
  );
}

/** 成员画像长图：与群报告共用同一套样式（REPORT_CSS）与横条行（reportRow），
    只把 Hero / KPI / 榜单换成单人视角 —— 用于把某位群友的分析结果分享出去。 */
function buildMemberHtml(opts) {
  const o = opts || {};
  const p = o.profile || {};
  const s = p.summary || {};
  const media = p.media || {};
  const rhythm = p.rhythm || {};
  const name = o.memberName || (p.member && p.member.display_name) || "成员";
  const avatar = o.avatarSrc || "";
  const total = Number(s.messages) || 0;

  const faceHtml = avatar
    ? '<img class="face" style="width:28px;height:28px;vertical-align:middle;margin-right:7px" src="' + escHtml(avatar) + '" alt="">'
    : '<span class="face" style="width:28px;height:28px;font-size:13px;vertical-align:middle;margin-right:7px;background:' + speakerColor(name) + '">' + escHtml(avatarChar(name)) + "</span>";

  // 消息构成：只画本人真正有数据的维度（分母为本人消息数，同一条可计入多个维度）
  const mix = [
    { name: "引用消息", count: media.quotes_given },
    { name: "表情", count: media.emojis },
    { name: "图片", count: media.images },
    { name: "文件", count: media.files },
    { name: "视频", count: media.videos },
    { name: "深夜 0–5 时", count: rhythm.night_messages },
    { name: "早起 6–8 时", count: rhythm.early_messages },
  ]
    .filter((x) => Number(x.count) > 0)
    .sort((a, b) => Number(b.count) - Number(a.count))
    .map((x) => ({ name: x.name, count: Number(x.count) || 0 }));
  const mixMax = mix.reduce((a, x) => Math.max(a, x.count), 1);
  const mixHtml = mix.map((x) => reportRow(x.name, x.count, mixMax, ACCENT, "", 0)).join("");

  const rowsOf = (rows) => {
    const max = rows.reduce((a, x) => Math.max(a, x.count), 1);
    return rows.map((x) => reportRow(x.name, x.count, max, ACCENT, "", 0)).join("");
  };
  const quoteRows = (p.top_quoted || []).slice(0, 8).map((x) => ({ name: x.name, count: Number(x.count) || 0 }));
  const quotedRows = (p.quoted_by || []).slice(0, 8).map((x) => ({ name: x.name, count: Number(x.count) || 0 }));

  const aiText = String(o.aiText || "").trim();
  const aiHtml = aiText ? '<div class="sec">AI 角色分析</div><div class="md">' + mdToHtml(aiText) + "</div>" : "";
  // Hero 导语优先用 AI 的结构化「人物素描」，没有就从正文里截一段（不编造）
  const persona = o.aiData && o.aiData.persona ? String(o.aiData.persona) : "";
  const lead = persona || (aiText ? aiText.replace(/[#>*`\-]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) : "");

  return (
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>" + escHtml(name + " · 成员画像") + "</title>" +
    "<style>" + REPORT_CSS + "</style></head><body><main class=\"card\">" +
    "<header class=\"hero\">" +
    '<div class="hero-tag">成员画像</div>' +
    "<h1>" + faceHtml + escHtml(name) + "</h1>" +
    '<div class="hero-range">' + escHtml(o.groupName || "") + (o.rangeLabel ? " · " + escHtml(o.rangeLabel) : "") + "</div>" +
    (lead ? '<div class="hero-lead">' + escHtml(lead) + "</div>" : "") +
    '<section class="kpis">' +
    '<div class="kpi"><div class="k">💬 消息</div><div class="v">' + escHtml(fmtNum(total)) + "</div></div>" +
    '<div class="kpi"><div class="k">✍️ 字数</div><div class="v">' + escHtml(fmtNum(Number(s.chars) || 0)) + "</div></div>" +
    '<div class="kpi"><div class="k">📅 活跃天数</div><div class="v">' + escHtml(String(s.active_days || 0)) + "</div></div>" +
    '<div class="kpi"><div class="k">📊 范围内占比</div><div class="v">' + escHtml(fmtPct(s.share_of_scope)) + "</div></div>" +
    "</section></header>" +
    '<div class="body">' +
    (mixHtml
      ? '<div class="sec">消息构成<small>分母 ' + escHtml(fmtNum(total)) + " 条（同一条可计入多个维度）</small></div>" + mixHtml
      : "") +
    (rhythm.bursts
      ? '<div class="item muted">连发 ' + escHtml(String(rhythm.bursts)) + " 次（与本人上一条消息间隔 ≤ 60 秒，不计入上方占比）</div>"
      : "") +
    (quoteRows.length ? '<div class="sec">常引用榜<small>我引用谁</small></div>' + rowsOf(quoteRows) : "") +
    (quotedRows.length ? '<div class="sec">被引用榜<small>谁引用我</small></div>' + rowsOf(quotedRows) : "") +
    aiHtml +
    "</div>" +
    "<footer>由 Snow App「微信群聊」面板生成 · " + escHtml(o.generatedAt || "") + " · 数据来自本机 wechat MCP（只读）</footer>" +
    "</main></body></html>"
  );
}

/** 成员导出的文件名主干：wechat-成员-<群>-<成员>-<日期>（不含扩展名）。 */
function memberFileStem(groupName, memberName) {
  return (
    "wechat-成员-" +
    safeFileName(groupName || "wechat", "wechat") +
    "-" +
    safeFileName(memberName || "member", "member") +
    "-" +
    todayStr().replace(/-/g, "")
  );
}

function dateStr(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
function timeStr(d) {
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}
function todayStr() {
  return dateStr(new Date());
}
/* 定时日报提示词：由宿主「定时任务」的 AI Loop 执行（面板本身不常驻）。
   幂等设计：同名文件已存在就跳过，因此「补发检查」可以反复运行而不会重复生成。 */
function buildCronPrompt(groupName, sessionId) {
  return [
    "定时生成微信群日报（只读，不要向微信发送任何消息）。",
    "",
    "会话：" + (groupName || sessionId) + "（session_id: " + sessionId + "）",
    "时间范围：**由你按运行时刻自行判断**，不要写死日期（用当前实际日期计算）：",
    "- 当天较晚时段运行（≥ 20:00）：取「今天 00:00:00 ~ 现在」",
    "- 凌晨或上午运行（< 12:00）：取「昨天 00:00:00 ~ 昨天 23:59:59」",
    "- 12:00~20:00 之间运行：取「今天 00:00:00 ~ 现在」，并在标题里注明实际范围",
    "理由：面板上的「日报」按自然日给人看；定时任务由你执行，按运行时刻挑最合适的窗口更贴合阅读习惯。",
    DEEP_WINDOW_NOTE,
    "",
    "步骤：",
    "1. 调 wechat MCP 的 get_group_digest(session_id, start, end, top_n=20, highlights=30) 取数；缺字段时再调 get_chat_activity_stats。",
    "2. 生成 Markdown 日报，包含：概览（消息 / 发言人数 / 人均 / 峰值）、趋势、成员榜 Top 10、被引用榜、消息类型、金句候选。",
    "3. 用 filesystem 写文件存到当前项目根目录，文件名：wechat-日报-" + safeFileName(groupName || sessionId, "wechat") + "-<YYYYMMDD>.md。",
    "4. 写入前先判断同名文件是否已存在：已存在说明今天已生成，直接结束，不要重复生成。",
    "",
    "约束：统计以 MCP 返回为准，不要编造；不要向微信发送任何消息。",
  ].join("\n");
}
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateStr(d);
}

/* 语义类分析（话题、关键词、待办、风险）交给「AI 深度分析」由 Agent 生成，
   面板不再做 2-gram 词频这类肤浅的本地近似 —— 本地只保留 SQL 能全量算准的确定性指标。 */

/** 解析当前项目 directoryId（AI 总结建会话用）
    注意：api.metadata.get() 返回的是 { generatedAt, domains, denied, withheld, unknown } 信封，
    真正的域数据在 resp.domains[domain] 里 —— 直接读返回值会永远拿不到 directoryId。 */
async function resolveDirectoryId(api) {
  const keys = ["activeDirectoryId", "directoryId", "activeProjectId"];
  const pick = (obj) => {
    if (!obj || typeof obj !== "object") return "";
    const act = obj.activeDirectory;
    if (act && typeof act === "object" && act.directoryId) return act.directoryId;
    for (const k of keys) {
      if (typeof obj[k] === "string" && obj[k]) return obj[k];
    }
    const dirs = obj.directories || obj.projects || obj.items;
    if (Array.isArray(dirs) && dirs.length) {
      const a = dirs.find((x) => x && x.isActive);
      if (a && a.directoryId) return a.directoryId;
      if (dirs[0] && dirs[0].directoryId) return dirs[0].directoryId;
    }
    return "";
  };
  for (const domain of ["runtime", "projects", "workspace", "app"]) {
    let resp = null;
    try {
      resp = await api.metadata.get(domain);
    } catch (err) {
      continue;
    }
    if (!resp || typeof resp !== "object") continue;
    const payload = (resp.domains && resp.domains[domain]) || resp[domain] || resp;
    const hit = pick(payload);
    if (hit) return hit;
  }
  return "";
}

/** 日期 + 时刻 → MCP 接受的 'YYYY-MM-DD HH:MM:SS'。
    结束时刻用 :59 秒，表示「包含该分钟」，因此默认 23:59 正好覆盖当天全天。 */
function rangeBound(dateValue, timeValue, isEnd) {
  const d = String(dateValue || "").trim();
  if (!d) return "";
  const tv = String(timeValue || "").trim() || (isEnd ? "23:59" : "00:00");
  return d + " " + tv + (isEnd ? ":59" : ":00");
}

/** 把群名等任意文本转成安全的文件名片段（Windows 非法字符 + 空白）。 */
function safeFileName(name, fallback) {
  const s = String(name || "")
    .replace(/[\\/:*?"<>\|\s]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (s || fallback || "digest").slice(0, 60);
}

/** 当前项目的本地根路径（用于默认保存总结文件）；拿不到返回 ""。 */
async function resolveProjectPath(api) {
  const pickPath = (payload) => {
    if (!payload || typeof payload !== "object") return "";
    const dirs = payload.directories || payload.projects || payload.items || [];
    if (!Array.isArray(dirs) || !dirs.length) return "";
    const active = dirs.find((x) => x && (x.isActive || x.active));
    const hit = active || dirs[0];
    return hit ? String(hit.path || hit.projectPath || hit.fsPath || "") : "";
  };
  for (const domain of ["projects", "runtime", "workspace"]) {
    try {
      const resp = await api.metadata.get(domain);
      const payload = (resp && resp.domains && resp.domains[domain]) || (resp && resp[domain]) || resp;
      const hit = pickPath(payload);
      if (hit) return hit;
    } catch (err) {
      /* 域不可读或未声明：继续尝试下一个 */
    }
  }
  return "";
}

/* ============ MCP 能力目录（面板「MCP 能力」视图用） ============
   每个工具声明：分类 group、人话名称 zh、一句话说明 desc、表单字段 fields。
   字段类型：session（群下拉）| date | text | number | select | switch
   这里内联而不是读宿主清单，保证宿主版本差异下依然可用。 */

const TOOLS = [
  {
    name: "list_wechat_sessions",
    group: "会话与消息",
    zh: "会话列表",
    desc: "列出所有会话（群 / 私聊），含消息总数与最后一条",
    fields: [{ k: "limit", label: "数量上限", type: "number", def: 50 }],
  },
  {
    name: "get_messages_by_range",
    group: "会话与消息",
    zh: "按时间范围取消息",
    desc: "取某会话在起止日期之间的消息，支持 offset 翻页",
    fields: [
      { k: "session_id", label: "会话", type: "session" },
      { k: "start", label: "起", type: "date" },
      { k: "end", label: "止", type: "date" },
      { k: "limit", label: "数量上限", type: "number", def: 100 },
    ],
  },
  {
    name: "get_messages_by_date",
    group: "会话与消息",
    zh: "按单日取消息",
    desc: "取某会话某一天的全部消息（时间正序）",
    fields: [
      { k: "session_id", label: "会话", type: "session" },
      { k: "date", label: "日期", type: "date" },
      { k: "limit", label: "数量上限", type: "number", def: 100 },
    ],
  },
  {
    name: "get_session_history",
    group: "会话与消息",
    zh: "会话最近历史",
    desc: "取某会话最近 N 条消息（时间正序）",
    fields: [
      { k: "session_id", label: "会话", type: "session" },
      { k: "limit", label: "数量上限", type: "number", def: 50 },
    ],
  },
  {
    name: "get_session_overview",
    group: "会话与消息",
    zh: "会话轻量概览",
    desc: "只做少量聚合、返回很快：会话累计条数 / 未读快照、范围内消息总量、发言人数、峰值时段、类型 TopN",
    fields: [
      { k: "session_id", label: "会话", type: "session" },
      { k: "start", label: "起", type: "date" },
      { k: "end", label: "止", type: "date" },
      { k: "top_types", label: "类型 TopN", type: "number", def: 5 },
    ],
  },
  {
    name: "get_messages_since",
    group: "会话与消息",
    zh: "增量拉新消息",
    desc: "按游标只取「之后」的新消息（after_id 为 messages.id，索引重建后会重分配；也可给 after_time），返回 next_cursor / has_more",
    fields: [
      { k: "after_id", label: "游标 id（与时间二选一）", type: "number" },
      { k: "after_time", label: "游标时间（与 id 二选一）", type: "text", def: "" },
      { k: "session_id", label: "会话（可空=全部）", type: "session" },
      { k: "limit", label: "单批条数", type: "number", def: 200 },
    ],
  },
  {
    name: "search_wechat_messages",
    group: "搜索",
    zh: "全文搜索聊天记录",
    desc: "按关键词搜索消息，可限定会话",
    fields: [
      { k: "query", label: "关键词", type: "text", def: "" },
      { k: "session_id", label: "限定会话（可空）", type: "session" },
      { k: "limit", label: "数量上限", type: "number", def: 20 },
    ],
  },
  {
    name: "search_contacts",
    group: "群与联系人",
    zh: "搜索联系人",
    desc: "按昵称 / 备注 / 微信号搜索联系人",
    fields: [
      { k: "keyword", label: "关键词", type: "text", def: "" },
      { k: "limit", label: "数量上限", type: "number", def: 30 },
    ],
  },
  {
    name: "list_chatroom_members",
    group: "群与联系人",
    zh: "群成员名单",
    desc: "列出某个群的成员（含昵称与微信号）",
    fields: [
      { k: "chatroom_id", label: "群", type: "session" },
      { k: "keyword", label: "过滤成员（可空）", type: "text", def: "" },
      { k: "limit", label: "数量上限", type: "number", def: 200 },
    ],
  },
  {
    name: "get_chat_activity_stats",
    group: "统计",
    zh: "聊天活跃度统计",
    desc: "消息总量、按小时 / 按天分布、发言最多的人",
    fields: [
      { k: "session_id", label: "会话（可空=全部）", type: "session" },
      { k: "start", label: "起", type: "date" },
      { k: "end", label: "止", type: "date" },
    ],
  },
  {
    name: "get_group_digest",
    group: "统计",
    zh: "群聊聚合（日报口径）",
    desc: "一次取齐活动统计（成员榜 / 互动网络 / 类型分布）与最长文本消息（金句候选）—— get_chat_activity_stats 的超集，面板的报告与 AI 取数走它",
    fields: [
      { k: "session_id", label: "会话（可空=全部）", type: "session" },
      { k: "start", label: "起", type: "date" },
      { k: "end", label: "止", type: "date" },
      { k: "gap_minutes", label: "会话片段间隔（分钟）", type: "number", def: 30 },
      { k: "top_n", label: "榜单长度", type: "number", def: 10 },
      { k: "highlights", label: "金句候选条数（0=不返回，上限 50）", type: "number", def: 0 },
    ],
  },
  {
    name: "get_member_profile",
    group: "统计",
    zh: "单个成员画像",
    desc: "成员维度聚合：活跃节奏 / 内容结构 / 互动对象与关键指标。member 支持 username、备注或显示名（先精确、再模糊）",
    fields: [
      { k: "member", label: "成员（昵称 / 备注 / wxid）", type: "text", def: "" },
      { k: "session_id", label: "限定会话（可空）", type: "session" },
      { k: "start", label: "起", type: "date" },
      { k: "end", label: "止", type: "date" },
      { k: "top_n", label: "榜单长度", type: "number", def: 10 },
      { k: "include_samples", label: "附带原文条数（0=不返回，上限 200）", type: "number", def: 0 },
    ],
  },
  {
    name: "search_media_files",
    group: "媒体与收藏",
    zh: "查找图片 / 文件 / 视频",
    desc: "按类型或月份查找聊天中传输过的媒体，返回磁盘路径",
    fields: [
      { k: "kind", label: "类型", type: "select", options: ["", "image", "file", "video"], labels: ["不限", "图片", "文件", "视频"], def: "" },
      { k: "month", label: "月份（YYYY-MM）", type: "text", def: "" },
      { k: "keyword", label: "文件名关键词", type: "text", def: "" },
      { k: "limit", label: "数量上限", type: "number", def: 30 },
    ],
  },
  {
    name: "search_shared_files",
    group: "媒体与收藏",
    zh: "查找传输的文档",
    desc: "查找聊天中出现过的文档类文件记录",
    fields: [
      { k: "keyword", label: "文件名关键词", type: "text", def: "" },
      { k: "limit", label: "数量上限", type: "number", def: 30 },
    ],
  },
  {
    name: "list_favorites",
    group: "媒体与收藏",
    zh: "收藏条目",
    desc: "查询微信收藏（标题 / 描述 / 来源）",
    fields: [
      { k: "keyword", label: "关键词", type: "text", def: "" },
      { k: "limit", label: "数量上限", type: "number", def: 20 },
    ],
  },
  {
    name: "list_emoticons",
    group: "媒体与收藏",
    zh: "表情包与表情",
    desc: "列出表情包与表情（含官方文字说明）",
    fields: [
      { k: "keyword", label: "关键词", type: "text", def: "" },
      { k: "limit", label: "数量上限", type: "number", def: 50 },
    ],
  },
  {
    name: "get_persona_style",
    group: "风格与维护",
    zh: "某人说话风格",
    desc: "分析某位联系人的沟通风格（统计画像 + 高频用语 + 典型语句）",
    fields: [
      { k: "sender", label: "昵称 / 微信号", type: "text", def: "" },
      { k: "session_id", label: "限定会话（可空）", type: "session" },
      { k: "sample_limit", label: "样本上限", type: "number", def: 300 },
    ],
  },
  {
    name: "get_sync_status",
    group: "风格与维护",
    zh: "本地索引状态",
    desc: "查看本地索引的数据新鲜度与规模",
    fields: [],
  },
  {
    name: "get_message_image",
    group: "媒体与收藏",
    zh: "解密导出图片",
    desc: "按消息 id 解密微信图片并导出为真实图片文件；成功返回 file_path（可直接渲染），失败返回 dat_path 与修复提示",
    fields: [
      { k: "message_id", label: "消息 id", type: "number" },
      { k: "include_base64", label: "附带 base64（一般不用）", type: "switch" },
    ],
  },
  {
    name: "extract_image_key",
    group: "媒体与收藏",
    zh: "提取图片密钥",
    desc: "从运行中的微信进程内存提取 V2 图片解密密钥。密钥只在该账号查看图片时临时缓存：请先在微信客户端点开 1-2 张图片，再立刻调用本工具；成功后自动写入密钥文件，之后的图片解密无需重复提取",
    fields: [],
  },
  {
    name: "get_emoticon_image",
    group: "媒体与收藏",
    zh: "取表情图",
    desc: "按表情 md5 取本地明文表情图（gif / png / jpg / webp / APNG）。md5 来自消息返回里的 emoticon_md5；wxgf 私有容器会在首次取用时现转码",
    fields: [{ k: "md5", label: "表情 md5", type: "text" }],
  },
  {
    name: "prepare_emoticons",
    group: "媒体与收藏",
    zh: "准备表情库",
    desc: "生成 / 刷新本地明文表情库（一次性）：解密微信账号级加密的表情文件并摊平成 <md5>.<ext>。需要 wxemo（自动下载的 seed 搜索工具）已就位",
    fields: [],
    dangerous: true,
  },
  {
    name: "get_user_avatars",
    group: "媒体与收藏",
    zh: "批量取头像",
    desc: "按 username 批量取用户 / 群 / 公众号头像的本地图片路径；没缓存过头像的会列在 missing 里",
    fields: [{ k: "usernames", label: "用户名（逗号 / 换行分隔）", type: "text", list: true }],
  },
  {
    name: "get_chat_record",
    group: "媒体与收藏",
    zh: "展开聊天记录",
    desc: "展开「聊天记录」合并转发消息：回源库取原始 XML，解析出被合并的各条消息（文本 / 图片 / 视频…）",
    fields: [
      { k: "message_id", label: "消息 id", type: "number" },
      { k: "include_raw", label: "附带原始 XML（调试）", type: "switch" },
    ],
  },
  {
    name: "start_sync",
    group: "风格与维护",
    zh: "后台同步（推荐）",
    desc: "后台线程重新解密源库 + 重建索引，立即返回、进度查 get_auto_sync_status；面板顶栏的同步按钮走的就是它（同步不能只重建索引，拿不到新消息）",
    dangerous: true,
    fields: [
      { k: "redecrypt", label: "先重新解密源库", type: "switch", def: true },
      { k: "force", label: "强制全量重建", type: "switch", def: false },
    ],
  },
  {
    name: "sync_wechat_database",
    group: "风格与维护",
    zh: "同步微信数据（阻塞）",
    desc: "先重新解密源库、再重建本地索引（只重建索引拿不到新消息）；实测约 10–20 秒",
    dangerous: true,
    fields: [
      { k: "redecrypt", label: "先重新解密源库", type: "switch", def: true },
      { k: "force", label: "强制全量重建", type: "switch", def: false },
    ],
  },
  {
    name: "set_auto_sync",
    group: "风格与维护",
    zh: "定时自动同步",
    desc: "开启 / 关闭定时同步（重新解密 + 重建索引）。状态持久化，MCP 服务重启后自动恢复",
    fields: [
      { k: "enabled", label: "状态", type: "select", options: ["true", "false"], labels: ["开启", "关闭"], bool: true, def: "true" },
      { k: "interval_minutes", label: "间隔（分钟 5–1440，留空沿用上次）", type: "number" },
    ],
  },
  {
    name: "get_auto_sync_status",
    group: "风格与维护",
    zh: "定时同步状态",
    desc: "查看定时同步的开关、间隔、运行次数与上次运行结果",
    fields: [],
  },
];

const TOOL_GROUPS = ["会话与消息", "搜索", "群与联系人", "统计", "媒体与收藏", "风格与维护"];

/** 结果表格优先展示的列 */
const PREFERRED_COLS = [
  "display_name",
  "session_name",
  "sender_name",
  "nickname",
  "time",
  "last_time",
  "type",
  "kind",
  "message_count",
  "content",
  "last_message",
  "username",
  "session_id",
  "id",
];

function fieldDefault(f, ctx) {
  if (f.type === "session") return ctx.sessionId || "";
  if (f.type === "date") return f.k === "start" ? ctx.start : ctx.end;
  if (f.type === "switch") return !!f.def;
  return f.def === undefined ? "" : f.def;
}

function makeT(locale) {
  const en = locale === "en";
  return {
    tabFeed: en ? "Feed" : "信息流",
    tabDigest: en ? "Digest" : "总结",
    tabMcp: en ? "MCP" : "MCP 能力",
    group: en ? "Group" : "群聊",
    query: en ? "Query" : "查询",
    stats: en ? "Statistics" : "生成统计",
    busy: en ? "Working…" : "处理中…",
    keyword: en ? "Keyword…" : "关键词（可选）",
    onlyMedia: en ? "Media" : "只看媒体",
    onlyAt: en ? "Mentions" : "只看 @",
    pick: en ? "Pick a group first." : "请先选择群聊。",
    noMsgs: en ? "No messages. Pick a group and press Query." : "暂无消息。选择群聊后点「查询」。",
    earlier: en ? "Load earlier" : "加载更早",
    earlierBusy: en ? "Loading…" : "加载中…",
    earliest: en ? "Reached the earliest message in range." : "已到该范围最早的消息。",
    refreshNew: en ? "Refresh new" : "刷新新消息",
    noNew: en ? "No new messages." : "没有新消息。",
    unread: en ? " unread" : " 未读",
    quick: en ? "Quick overview" : "快速概览",
    quickHint: en
      ? "Lightweight totals from get_session_overview (session size, peak hour, type top). Press Statistics for member rank, interaction network and AI analysis."
      : "来自 get_session_overview 的轻量聚合（会话累计 / 峰值时段 / 类型 Top）。成员榜、互动网络与 AI 分析请点「生成统计」。",
    total: en ? "Messages" : "消息数",
    senders: en ? "Active" : "活跃人数",
    peak: en ? "Peak" : "峰值时段",
    days: en ? "Days" : "天数",
    hourly: en ? "Hourly distribution" : "按小时分布",
    topSenders: en ? "Top senders" : "活跃发言者",
    types: en ? "Message types" : "消息类型",
    ai: en ? "Deep analysis" : "深度分析",
    open: en ? "Open session" : "打开会话",
    prompt: en ? "Prompt preview" : "提示词预览",
    retry: en ? "Re-check" : "重新检测",
    depTitle: en ? "wechat MCP is required" : "需要先安装 wechat MCP",
    connected: en ? "MCP connected" : "MCP 已连接",
    run: en ? "Run" : "执行",
    confirmRun: en ? "Click again to confirm" : "再点一次确认执行",
    running: en ? "Running…" : "执行中…",
    reset: en ? "Reset" : "重置",
    resetHint: en ? "Reset group, date range, keyword and filters" : "重置群选择、日期范围、关键词与过滤条件",
    raw: en ? "Raw JSON" : "原始 JSON",
    rows: en ? "rows" : "行",
    empty: en ? "Nothing returned." : "没有返回数据。",
    sysmsg: en ? "System" : "系统",
    mcpHint: en
      ? "Same MCP server the Agent uses. Everything here is read-only except syncing / rebuilding the local index."
      : "与 Agent 用的是同一套 wechat MCP。除「同步微信数据 / 定时自动同步」外，这里全部是只读查询。",
    toolCount: en ? "tools" : "个工具",
    noFields: en ? "No parameters needed." : "无需参数，直接执行。",
    sync: en ? "Sync" : "同步",
    syncing: en ? "Syncing…" : "同步中…",
    syncHint: en
      ? "Re-decrypt the WeChat source DB, then rebuild the local index. Rebuilding the index alone cannot pick up new messages."
      : "先重新解密微信源库，再重建本地索引。只重建索引拿不到新消息。",
    syncOk: en ? "Sync complete" : "同步完成",
    syncFail: en ? "Sync failed" : "同步失败",
  };
}

/* ============================ 依赖预检 ============================ */

function useDependency(api) {
  const [state, setState] = useState({ phase: "checking" });

  const check = useCallback(async () => {
    setState({ phase: "checking" });

    let domains = [];
    try {
      domains = api.write.domains() || [];
    } catch (err) {
      domains = [];
    }
    const mcpDomain = domains.find((d) => d && d.id === "mcpTools");
    const callAction = mcpDomain && (mcpDomain.actions || []).find((a) => a && a.id === "mcpTools.call");
    if (!callAction) {
      setState({ phase: "blocked", kind: "no-host", detail: "当前宿主不支持 api.write.mcpTools.call。" });
      return;
    }
    if (!callAction.granted) {
      setState({
        phase: "blocked",
        kind: "no-declaration",
        detail: "privacy 未声明 mcpSecrets（scope = " + String(callAction.scope) + "）。",
      });
      return;
    }

    let servers = null;
    try {
      const meta = await api.metadata.get("mcp");
      servers = (meta && (meta.servers || (meta.data && meta.data.servers))) || null;
    } catch (err) {
      servers = null;
    }
    if (servers) {
      const srv = servers.find((s) => s && s.name === MCP_SERVER);
      if (!srv) {
        setState({ phase: "blocked", kind: "no-server", detail: "MCP 服务器列表中没有名为 " + MCP_SERVER + " 的服务器。" });
        return;
      }
      if (srv.enabled === false) {
        setState({ phase: "blocked", kind: "server-disabled", detail: MCP_SERVER + " MCP 服务器处于禁用状态。" });
        return;
      }
    }

    try {
      const res = await api.write.run("mcpTools.call", { toolFullName: MCP_SERVER + "-get_sync_status", args: {} });
      if (!res || !res.ok) {
        const why = res && res.denied ? res.denied.reason : res && res.error ? res.error : "未知错误";
        setState({ phase: "blocked", kind: "probe-failed", detail: "调用 " + MCP_SERVER + " MCP 失败：" + why });
        return;
      }
      setState({ phase: "ready", status: unwrapMcp(res.data) });
    } catch (err) {
      setState({ phase: "blocked", kind: "probe-failed", detail: errText(err) });
    }
  }, [api]);

  useEffect(() => {
    check();
  }, [check]);

  return [state, check];
}

const MCP_SNIPPET = JSON.stringify(
  {
    mcpServers: {
      wechat: {
        command: "wechat-mcp",
        args: [],
        env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      },
    },
  },
  null,
  2,
);

const KIND_TEXT = {
  "no-host": "宿主能力缺失",
  "no-declaration": "插件隐私声明缺失",
  "no-server": "未注册 wechat MCP 服务器",
  "server-disabled": "wechat MCP 服务器被禁用",
  "probe-failed": "MCP 调用失败",
};

function DependencyGuide({ state, t, onRetry }) {
  return h(
    "div",
    { className: "swf-guide" },
    h("h3", null, t.depTitle),
    h(
      "p",
      null,
      "本插件不内置微信数据采集能力，全部数据来自本机安装的 ",
      h("b", null, "wechat MCP 服务器"),
      "。未安装 / 未启用时无法工作。",
    ),
    state.detail ? h("div", { className: "swf-error" }, (KIND_TEXT[state.kind] || "检测失败") + "：" + state.detail) : null,
    h(
      "ol",
      null,
      h("li", null, "安装提供 wechat-mcp 的包（im-mcp 项目）", h("code", { className: "swf-code" }, "pip install im-mcp    # 或 uv tool install im-mcp")),
      h("li", null, "以管理员身份初始化本地微信索引（需微信已登录）", h("code", { className: "swf-code" }, "wechat-init")),
      h("li", null, "在 Snow App → 设置 → MCP 服务器 添加 stdio 服务器，名称必须为 wechat", h("code", { className: "swf-code" }, MCP_SNIPPET)),
      h("li", null, "若该 MCP 会话已在运行，重启应用 / 重连会话使其生效"),
      h("li", null, "回到本面板点击「重新检测」"),
    ),
    h("button", { className: "swf-btn swf-btn-primary", onClick: onRetry }, t.retry),
  );
}

/* ============================ 主面板 ============================ */

function WechatPanel({ api, locale }) {
  const t = makeT(locale);
  const [dep, recheck] = useDependency(api);

  const [view, setView] = useState("feed");
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState("");
  // 默认只看当天：信息量可控；需要更长范围用「近 7 天 / 近 30 天」快捷预设
  const [start, setStart] = useState(todayStr());
  const [startTime, setStartTime] = useState("00:00");
  const [end, setEnd] = useState(todayStr());
  const [endTime, setEndTime] = useState("23:59");
  const [keyword, setKeyword] = useState("");
  const [onlyMedia, setOnlyMedia] = useState(false);
  const [onlyAt, setOnlyAt] = useState(false);

  const [messages, setMessages] = useState([]);
  // 引用跳转命中后短暂高亮的消息 id（字符串，与 data-mid 对齐）
  const [hlId, setHlId] = useState("");
  const hlTimerRef = useRef(null);
  // username → 头像 data URL。一次批量取回后按 sender_username 复用，缺失的不进 Map
  const [avatars, setAvatars] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // 信息流分页：hasMore = 范围内还有更早的消息；olderBatches = 已额外加载的更早批次数
  const [hasMore, setHasMore] = useState(false);
  const [olderBatches, setOlderBatches] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // 增量刷新（get_messages_since）：只拉当前最后一条之后的新消息
  const [loadingNewer, setLoadingNewer] = useState(false);
  const bodyRef = useRef(null);
  // 首屏 / 重新查询后需要贴底：由 loadFeed 置位，useLayoutEffect 在 DOM 提交后消费
  const scrollBottomRef = useRef(false);
  // 信息流代次：每次 loadFeed 自增，响应回来时对不上就整批丢弃。
  // 没有它时「A 群慢响应 + 切到 B 群」会把 A 的消息盖到 B 的列表上（新群标题 + 旧群消息）。
  const feedGenRef = useRef(0);
  const [debug, setDebug] = useState("");

  const [stats, setStats] = useState(null);
  // 轻量概览（get_session_overview）：切群后立刻出卡，不必等重量级 digest 聚合
  const [quick, setQuick] = useState(null);
  const [quickBusy, setQuickBusy] = useState(false);
  // 上一次统计实际覆盖的范围：与当前输入范围不一致时提示「待刷新」，避免旧数据被当新数据读
  const [statsRange, setStatsRange] = useState({ start: "", end: "" });
  // 上一次统计所属的群：切群后若没重算，画面上的数字仍属于上一个群
  const [statsScope, setStatsScope] = useState("");
  // AI 深度分析解析出的结构化结果（topics / heat_hours / todos / risks）
  const [aiData, setAiData] = useState(null);
  // AI 分析设置（维度 / 数量上限 / 自定义指令）：持久化到插件私有存储
  const [aiSettings, setAiSettings] = useState(() => cloneAiSettings(AI_SETTINGS_DEFAULT));
  const aiSettingsReadyRef = useRef(false);
  // 定时日报：时间与补发检查开关（持久化）
  const [cron, setCron] = useState({ hour: 22, minute: 0, catchup: true });
  const cronReadyRef = useRef(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [created, setCreated] = useState(null);
  // AI 深度总结：面板内流式渲染 + 导出 MD（DESIGN P4）
  const [aiText, setAiText] = useState("");
  const [aiConvId, setAiConvId] = useState("");
  const [aiStatus, setAiStatus] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const aiUnsubRef = useRef(null);
  const aiPollRef = useRef(null);
  const aiPollStartRef = useRef(0);
  // 当前流式目标：group = 群维度深度分析，member = 单个成员的角色分析
  const aiTargetRef = useRef("group");
  // 成员分析代次：切换/收起成员时自增，让旧请求的后续回调直接作废（避免复活订阅）
  const memberGenRef = useRef(0);

  /* ---- 深挖流水线：与单轮 AI 管线完全隔离（独立 state / 独立 ref / 独立代次 / 独立会话） ---- */
  // 分析档位：quick = 速览（1 轮浅取数）、standard = 现有单轮深度分析、deep = 多阶段深挖
  const [deepMode, setDeepMode] = useState("standard");
  // 阶段步骤：[{ id, label, detail, status, convId, chars, text, marks }]
  const [deepSteps, setDeepSteps] = useState([]);
  const [deepText, setDeepText] = useState("");
  const [deepData, setDeepData] = useState(null);
  const [deepBusy, setDeepBusy] = useState(false);
  const [deepMsg, setDeepMsg] = useState("");
  const [deepOpenStep, setDeepOpenStep] = useState("");
  // 代次：中止或重新开始时自增，让在飞的阶段回调全部作废
  const deepGenRef = useRef(0);
  // 当前阶段的会话 id：中止时用它调 conversations.abort（会级联中止其子代理）
  const deepConvRef = useRef("");
  const deepUnsubRef = useRef(null);

  // 流式读取的轮询定时器也必须放在顶部：startPoll / 卸载清理 / 收起画像都会引用
  const stopPoll = useCallback(() => {
    if (aiPollRef.current) {
      clearInterval(aiPollRef.current);
      aiPollRef.current = null;
    }
  }, []);

  // 停止「成员」这一路的流式读取：群分析在跑时不动它（共用同一个订阅/轮询槽位）
  const stopMemberAiStream = useCallback(() => {
    memberGenRef.current += 1;
    if (aiTargetRef.current !== "member") return;
    stopPoll();
    try {
      if (aiUnsubRef.current) aiUnsubRef.current();
    } catch (err) {
      /* 订阅已失效 */
    }
    aiUnsubRef.current = null;
  }, [stopPoll]);

  // 读取 AI 分析设置：存储不可用时保持默认值，不阻塞面板
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => (api.storage && api.storage.getJson ? api.storage.getJson("aiSettings") : null))
      .then((saved) => {
        if (alive && saved) setAiSettings((prev) => mergeAiSettings(prev, saved));
      })
      .catch(() => {
        /* 读取失败就用默认值 */
      })
      .finally(() => {
        if (alive) aiSettingsReadyRef.current = true;
      });
    return () => {
      alive = false;
    };
  }, [api]);

  // 设置变化即持久化（首次加载完成前不写，避免用默认值覆盖已保存的设置）
  useEffect(() => {
    if (!aiSettingsReadyRef.current) return;
    try {
      const r = api.storage && api.storage.setJson ? api.storage.setJson("aiSettings", aiSettings) : null;
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (err) {
      /* 存储不可用：只保留内存态 */
    }
  }, [aiSettings, api]);

  // 定时日报设置：读取（非法值回退默认）
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => (api.storage && api.storage.getJson ? api.storage.getJson("cronSettings") : null))
      .then((saved) => {
        if (!alive || !saved || typeof saved !== "object") return;
        setCron((prev) => ({
          hour: Number.isFinite(Number(saved.hour)) ? Math.max(0, Math.min(23, Math.round(Number(saved.hour)))) : prev.hour,
          minute: Number.isFinite(Number(saved.minute)) ? Math.max(0, Math.min(59, Math.round(Number(saved.minute)))) : prev.minute,
          catchup: typeof saved.catchup === "boolean" ? saved.catchup : prev.catchup,
        }));
      })
      .catch(() => {
        /* 读取失败就用默认值 */
      })
      .finally(() => {
        if (alive) cronReadyRef.current = true;
      });
    return () => {
      alive = false;
    };
  }, [api]);

  // 定时日报设置：变化即保存
  useEffect(() => {
    if (!cronReadyRef.current) return;
    try {
      const r = api.storage && api.storage.setJson ? api.storage.setJson("cronSettings", cron) : null;
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (err) {
      /* 存储不可用：只保留内存态 */
    }
  }, [cron, api]);

  const updateAiSettings = useCallback(
    (patch) => setAiSettings((prev) => mergeAiSettings(prev, patch || {})),
    [],
  );

  // 查询用时间范围：日期 + 时刻 → MCP 接受的 'YYYY-MM-DD HH:MM:SS'
  const rangeStart = useMemo(() => rangeBound(start, startTime, false), [start, startTime]);
  const rangeEnd = useMemo(() => rangeBound(end, endTime, true), [end, endTime]);

  // 每小时柱状图的度量：消息条数 / 去重发言人数
  const [hourMetric, setHourMetric] = useState("messages");
  // 滚动 24 小时模式：用 MCP 的绝对时间小时序列（可跨天），而不是 0-23 合并口径
  const [forceHourly, setForceHourly] = useState(false);

  // 成员榜维度 + 点击成员后按需拉取的单人画像（MCP 通用工具）
  const [rankMetric, setRankMetric] = useState("messages");
  const [memberProfile, setMemberProfile] = useState(null);
  const [memberBusy, setMemberBusy] = useState(false);
  // 角色维度 AI 分析（与群分析共用流式管线，靠 aiTargetRef 区分写入哪组状态）
  const [memberAiText, setMemberAiText] = useState("");
  const [memberAiData, setMemberAiData] = useState(null);
  const [memberAiBusy, setMemberAiBusy] = useState(false);
  const [memberAiConvId, setMemberAiConvId] = useState("");
  const [memberAiStatus, setMemberAiStatus] = useState("");
  const [memberAiMsg, setMemberAiMsg] = useState("");
  // 成员检索（list_chatroom_members）：让榜外成员也能被找到并打开画像
  const [memberQuery, setMemberQuery] = useState("");
  const [memberHits, setMemberHits] = useState(null);
  const [memberVisible, setMemberVisible] = useState(MEMBER_PAGE_SIZE);
  const [memberSearchBusy, setMemberSearchBusy] = useState(false);
  // 不限时间范围：冷门成员在「今天」这种窄窗口里常常只有几条消息，用全部历史更有分析价值
  const [memberAllTime, setMemberAllTime] = useState(false);
  // 成员画像导出（MD / HTML 长图 / 备忘录）的提示行
  const [memberMsg, setMemberMsg] = useState("");

  // 报告类型：日 / 周 / 月 / 年 / 自定义；驱动时间窗与趋势粒度（MCP 仍只认 start/end）
  const [reportPeriod, setReportPeriod] = useState("day");
  const [reportMsg, setReportMsg] = useState("");
  // 报告章节开关：控制 Markdown 里包含哪些维度（默认全开）
  const [reportSections, setReportSections] = useState({
    overview: true,
    trend: true,
    members: true,
    network: true,
    types: true,
    quotes: true,
    ai: true,
  });

  const [openTool, setOpenTool] = useState("");
  const [values, setValues] = useState({});
  const [armed, setArmed] = useState("");
  const [callBusy, setCallBusy] = useState(false);
  const [callResult, setCallResult] = useState(null);

  // 同步（重新解密 + 重建索引）：手动触发，成功后就地刷新群列表与信息流
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [sessionsNonce, setSessionsNonce] = useState(0);

  // 同步提示的收口策略（三态各不相同）：
  // - 成功（且已不在同步中）：3 秒后淡出 —— 成功不需要用户记住
  // - 同步中：常驻到有结果为止 —— 进行中消失会让人以为没在跑
  // - 失败 / 超时：常驻，由用户点 ✕ 关闭 —— 错误要读要判断（重试还是排查），
  //   自动消失会让人措手不及
  useEffect(() => {
    if (!syncMsg || !syncMsg.ok || syncing) return;
    const timer = setTimeout(() => setSyncMsg(null), SYNC_OK_FADE_MS);
    return () => clearTimeout(timer);
  }, [syncMsg, syncing]);

  /* ---- 拉群列表 ---- */
  useEffect(() => {
    if (dep.phase !== "ready") return undefined;
    let alive = true;
    (async () => {
      try {
        const raw = await callToolRaw(api, "list_wechat_sessions", { limit: 100 });
        if (!alive) return;
        const arr = asArray(unwrapMcp(raw));
        const rooms = arr.filter((s) => s && s.type === "room");
        const use = rooms.length ? rooms : arr;
        setSessions(use);
        setSessionId((prev) => prev || (use[0] && use[0].session_id) || "");
        if (!use.length) {
          const dump = "list_wechat_sessions 原始返回：" + preview(raw, 800);
          setDebug(dump);
          log(api, dump);
        } else {
          setDebug("");
        }
      } catch (err) {
        if (alive) {
          setError(errText(err));
          setDebug("list_wechat_sessions 调用异常：" + errText(err));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [dep.phase, api, sessionsNonce]);

  const current = sessions.find((s) => s && s.session_id === sessionId);

  /* ---- 信息流 ----
     顺序按微信习惯：范围内**从旧到新**，最新消息在底部；向上用「加载更早」翻页。
     MCP 的 get_messages_by_range 默认 asc，这里显式传 order:"desc" 取最新一批再翻转，
     保证首屏是**最新**的 PAGE_LIMIT 条，而不是最早的。 */
  const loadFeed = useCallback(async () => {
    if (!sessionId) {
      setError(t.pick);
      return;
    }
    // 代次守卫：切群或重新查询后，在途的旧请求回来时必须整批丢弃 —— 包括加载态，
    // 否则慢响应的 setLoading(false) 会提前收掉新请求的「处理中」。
    const gen = ++feedGenRef.current;
    setLoading(true);
    setError("");
    setCreated(null);
    setOlderBatches(0);
    try {
      const searching = !!keyword.trim();
      const list = searching
        ? await callTool(api, "search_wechat_messages", { query: keyword.trim(), session_id: sessionId, limit: PAGE_LIMIT })
        : await callTool(api, "get_messages_by_range", {
            session_id: sessionId,
            start: rangeStart,
            end: rangeEnd,
            limit: PAGE_LIMIT,
            order: "desc",
          });
      const raw = asArray(list);
      // desc → asc：旧在上、新在下（与微信一致）
      const arr = searching ? raw : raw.slice().reverse();
      if (gen !== feedGenRef.current) return;
      setMessages(arr);
      // 搜索按相关度排序、不做翻页；范围查询取满一页说明还有更早的
      setHasMore(!searching && raw.length >= PAGE_LIMIT);
      setDebug("");
      // 首屏定位到最新（底部）：只置位，真正滚动交给下面的 useLayoutEffect。
      // 直接在 setMessages 后 rAF 会在**首次挂载**时读到旧/空高度，滚动等于没做，
      // 表现为「第一次进来停在最旧消息，点一次查询才正常」。
      scrollBottomRef.current = true;
      // 发言者头像：收集当页全部 sender_username 一次性批量取（不阻塞消息渲染）。
      // 用 merge 而非覆盖，切群时不闪回色块；没取到的不写进 Map，渲染层自动回退。
      const names = Array.from(new Set(arr.map((m) => m && m.sender_username).filter(Boolean)));
      fetchAvatarMap(api, names).then((map) => {
        if (Object.keys(map).length) setAvatars((prev) => Object.assign({}, prev, map));
      });
      log(api, "feed " + sessionId + " -> " + arr.length);

      // 图片不预取：上游 get_message_image 需要逐条消息 id，逐条拉会打爆 MCP。
      // 每条 [图片] 消息在渲染时由 McpImage **挂载即自动**调用（并发经 withImageSlot 限到 3），无需用户点击。
    } catch (err) {
      if (gen !== feedGenRef.current) return;
      setMessages([]);
      setError(errText(err));
    }
    setLoading(false);
  }, [api, sessionId, keyword, rangeStart, rangeEnd, t.pick]);

  // messages 提交到 DOM 后再滚到底：DOM 高度此时已确定，首次打开也能正确定位到最新。
  useLayoutEffect(() => {
    if (!scrollBottomRef.current) return;
    scrollBottomRef.current = false;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /* ---- 加载更早：desc 排序下 offset 跳过的是最新记录，所以 offset 递增即往更早翻 ---- */
  const loadOlder = useCallback(async () => {
    if (!sessionId || loadingOlder || !hasMore || keyword.trim()) return;
    setLoadingOlder(true);
    const box = bodyRef.current;
    const prevHeight = box ? box.scrollHeight : 0;
    try {
      const offset = (olderBatches + 1) * PAGE_LIMIT;
      const raw = asArray(
        await callTool(api, "get_messages_by_range", {
          session_id: sessionId,
          start: rangeStart,
          end: rangeEnd,
          limit: PAGE_LIMIT,
          offset: offset,
          order: "desc",
        }),
      );
      if (!raw.length) {
        setHasMore(false);
      } else {
        const older = raw.slice().reverse(); // asc，拼到列表头部
        setMessages((prev) => older.concat(prev));
        setOlderBatches((n) => n + 1);
        setHasMore(raw.length >= PAGE_LIMIT);
        const names = Array.from(new Set(older.map((m) => m && m.sender_username).filter(Boolean)));
        if (names.length) {
          fetchAvatarMap(api, names).then((map) => {
            if (Object.keys(map).length) setAvatars((p) => Object.assign({}, p, map));
          });
        }
        // 保持视觉位置：把新增内容的高度补偿进 scrollTop
        requestAnimationFrame(() => {
          const el = bodyRef.current;
          if (el) el.scrollTop += el.scrollHeight - prevHeight;
        });
      }
    } catch (err) {
      setError(errText(err));
    }
    setLoadingOlder(false);
  }, [api, sessionId, rangeStart, rangeEnd, keyword, loadingOlder, hasMore, olderBatches]);

  /* ---- 轻量概览：切群后立刻出卡（get_session_overview 只做计数聚合，几十毫秒级）
     传当前时间窗，与完整统计同口径；会话累计值另由 session.message_count 给出。 ---- */
  const loadQuick = useCallback(async () => {
    if (!sessionId) return;
    setQuickBusy(true);
    try {
      const q = await callTool(api, "get_session_overview", {
        session_id: sessionId,
        start: rangeStart,
        end: rangeEnd,
        top_types: 5,
      });
      if (q && !q.error) setQuick(q);
    } catch (err) {
      // 旧版 MCP（未重启）没有该工具：静默跳过，完整统计仍然可用
      log(api, "get_session_overview 不可用：" + errText(err));
    }
    setQuickBusy(false);
  }, [api, sessionId, rangeStart, rangeEnd]);

  /* ---- 增量刷新：只拉「当前最后一条之后」的新消息，避免整页重查 ---- */
  const loadNewer = useCallback(async () => {
    if (!sessionId || loading || loadingNewer) return;
    // 搜索模式没有稳定游标，直接重新查询
    if (keyword.trim() || !messages.length) {
      await loadFeed();
      return;
    }
    setLoadingNewer(true);
    try {
      const last = messages[messages.length - 1];
      if (!last || last.id === undefined) {
        await loadFeed();
      } else {
        const res = await callTool(api, "get_messages_since", {
          after_id: last.id,
          session_id: sessionId,
          limit: 200,
        });
        const rows = asArray(res);
        // 只并入仍在当前时间窗内的消息：范围查询下「新消息」可能已落在窗口之外
        const fresh = rows.filter(
          (m) => m && m.time && (!rangeStart || m.time >= rangeStart) && (!rangeEnd || m.time <= rangeEnd),
        );
        // 索引重建后 messages.id 会重新分配，游标可能落在已加载消息的中间：
        // 按 id 去重，避免把列表里已有的消息再追加一遍。
        const known = new Set(messages.map((m) => m && m.id));
        const add = fresh.filter((m) => m && !known.has(m.id));
        if (add.length) {
          setMessages((prev) => prev.concat(add));
          // 新消息在底部：提交到 DOM 后贴底（复用 loadFeed 的滚动机制）
          scrollBottomRef.current = true;
          const names = Array.from(new Set(add.map((m) => m && m.sender_username).filter(Boolean)));
          if (names.length) {
            fetchAvatarMap(api, names).then((map) => {
              if (Object.keys(map).length) setAvatars((prev) => Object.assign({}, prev, map));
            });
          }
        }
        setDebug(
          res && res.has_more
            ? "新消息超过一页（200 条），可再点一次「刷新新消息」。"
            : add.length
              ? ""
              : t.noNew,
        );
      }
    } catch (err) {
      setError(errText(err));
    }
    setLoadingNewer(false);
  }, [api, sessionId, keyword, messages, rangeStart, rangeEnd, loading, loadingNewer, loadFeed, t.noNew]);

  /* ---- 引用消息跳原文：在已加载的消息里按「作者 + 内容前缀」定位 ----
     微信引用块只带作者昵称与被引内容（可能被截断），且本地索引不含消息间的关系字段，
     因此这里按「同一作者、内容包含被引前缀、时间不晚于引用者」匹配，取最靠后的一条
     （即最接近引用者的那次发言）。命中不了就明确提示，不做静默失败。 */
  const jumpToQuote = useCallback(
    (author, text, beforeTime) => {
      const needle = squashText(text).slice(0, 24);
      if (!needle || !author) return false;
      let hit = null;
      for (const m of messages) {
        if (!m || m.sender_name !== author) continue;
        if (beforeTime && m.time && m.time > beforeTime) continue;
        if (squashText(m.content).indexOf(needle) < 0) continue;
        hit = m;
      }
      if (!hit) return false;
      setHlId(String(hit.id));
      if (hlTimerRef.current) clearTimeout(hlTimerRef.current);
      hlTimerRef.current = setTimeout(() => setHlId(""), 1800);
      // 等 React 提交高亮 class 后再滚动，避免滚到未渲染的位置
      requestAnimationFrame(() => {
        const box = bodyRef.current;
        const el = box && box.querySelector('[data-mid="' + hit.id + '"]');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      return true;
    },
    [messages],
  );

  // 卸载时清掉高亮定时器，避免在已卸载组件上 setState
  useEffect(
    () => () => {
      if (hlTimerRef.current) clearTimeout(hlTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (dep.phase === "ready" && sessionId) {
      loadFeed();
      loadQuick();
    }
    // 仅依赖就绪 / 切换群聊时自动查询
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep.phase, sessionId]);

  /* ---- 切换群聊：旧群的统计 / 成员画像 / AI 结论都不属于新群 ----
     直接清空并停掉在途的流，避免出现「新群标题 + 旧群数字」这种误读。
     首次挂载（prev 为空）不触发，否则会把首屏自动选中的群也清掉。 */
  const prevSessionRef = useRef("");
  useEffect(() => {
    const prev = prevSessionRef.current;
    prevSessionRef.current = sessionId;
    if (!prev || prev === sessionId) return;
    stopMemberAiStream();
    stopPoll();
    try {
      if (aiUnsubRef.current) aiUnsubRef.current();
    } catch (err) {
      /* 订阅已失效 */
    }
    aiUnsubRef.current = null;
    // 信息流：旧群消息立刻消失（新群的 loadFeed 会重新填），否则会短暂看到「新群标题 + 旧群消息」
    setMessages([]);
    // 无新群可查（重置为未选群）时，没有 loadFeed 去顶替在途请求，这里补一次代次让它作废；
    // 有新群时**不能**自增 —— 同一轮 effect 里新群的 loadFeed 已先自增过，再自增会把它自己的响应也丢掉
    if (!sessionId) feedGenRef.current++;
    // 统计与派生结论
    setStats(null);
    setStatsScope("");
    // 轻量概览也属于旧群，必须一起清掉（新群的 loadQuick 会重新拉）
    setQuick(null);
    setQuickBusy(false);
    setAiText("");
    setAiData(null);
    setAiConvId("");
    setAiStatus("");
    setAiBusy(false);
    setCreated(null);
    // 成员画像与它的 AI 分析
    setMemberProfile(null);
    setMemberBusy(false);
    setMemberAiText("");
    setMemberAiData(null);
    setMemberAiConvId("");
    setMemberAiStatus("");
    setMemberAiMsg("");
    setMemberAiBusy(false);
    // 成员检索结果也属于旧群：切群后必须清掉，否则会把上一个群的人列出来
    setMemberHits(null);
    setMemberQuery("");
    setMemberMsg("");
    // 深挖流水线同样属于旧群：中止在飞阶段并清空，否则旧群的阶段结果会串到新群
    deepGenRef.current++;
    try {
      if (deepUnsubRef.current) deepUnsubRef.current();
    } catch (err) {
      /* 订阅已失效 */
    }
    deepUnsubRef.current = null;
    deepConvRef.current = "";
    setDeepSteps([]);
    setDeepText("");
    setDeepData(null);
    setDeepBusy(false);
    setDeepMsg("");
    setDeepOpenStep("");
  }, [sessionId, stopMemberAiStream, stopPoll]);

  /* ---- 组件卸载：让在飞的深挖阶段作废并退订（阶段轮询最长 15 分钟，不该在后台空转） ---- */
  useEffect(
    () => () => {
      deepGenRef.current++;
      try {
        if (deepUnsubRef.current) deepUnsubRef.current();
      } catch (err) {
        /* 忽略 */
      }
      deepUnsubRef.current = null;
    },
    [],
  );

  /* ---- 统计 / 报告：同一份聚合数据（get_group_digest = activity stats + 金句候选） ---- */
  const loadStats = useCallback(
    async (override) => {
      if (!sessionId) {
        setError(t.pick);
        return;
      }
      const startArg = (override && override.start) || rangeStart;
      const endArg = (override && override.end) || rangeEnd;
      setLoading(true);
      setError("");
      setCreated(null);
      try {
        let s = null;
        try {
          s = await callTool(api, "get_group_digest", {
            session_id: sessionId,
            start: startArg,
            end: endArg,
            gap_minutes: 30,
            top_n: 10,
            highlights: 8,
          });
        } catch (firstErr) {
          // 旧版 MCP（未重启）没有 get_group_digest → 退回 activity stats，报告缺少金句候选
          log(api, "get_group_digest 不可用，回退 get_chat_activity_stats：" + errText(firstErr));
          s = await callTool(api, "get_chat_activity_stats", {
            session_id: sessionId,
            start: startArg,
            end: endArg,
          });
        }
        setStats(s && typeof s === "object" ? s : null);
        setStatsRange({ start: startArg, end: endArg });
        setStatsScope(sessionId);
        // 语义类指标（话题/关键词/待办）交给「AI 深度分析」，本地不再拉样本算词频。
        // 活跃发言者头像：top_senders 已带 username，批量取一次（缺失静默回退色块）
        const topNames = ((s && s.top_senders) || []).map((x) => x && x.username).filter(Boolean);
        if (topNames.length) {
          fetchAvatarMap(api, topNames).then((map) => {
            if (Object.keys(map).length) setAvatars((prev) => Object.assign({}, prev, map));
          });
        }
      } catch (err) {
        setStats(null);
        setError(errText(err));
      }
      setLoading(false);
    },
    [api, sessionId, rangeStart, rangeEnd, t.pick],
  );

  /* ---- 成员画像：点击成员榜时按需拉取（MCP 通用工具，面板只做展示） ---- */
  const loadMemberProfile = useCallback(
    async (username, allTimeOverride) => {
      if (!username) return;
      // 切换成员：作废上一位的流式分析与在途请求，避免旧结果串到新成员
      stopMemberAiStream();
      // 不限时间范围 = 不传 start/end（MCP 语义：该成员的全部历史发言）
      const allTime = typeof allTimeOverride === "boolean" ? allTimeOverride : memberAllTime;
      setMemberMsg("");
      const gen = memberGenRef.current;
      setMemberBusy(true);
      setMemberProfile(null);
      setMemberAiBusy(false);
      setMemberAiText("");
      setMemberAiData(null);
      setMemberAiConvId("");
      setMemberAiStatus("");
      setMemberAiMsg("");
      try {
        const args = { member: username, session_id: sessionId, top_n: 8 };
        if (!allTime) {
          args.start = rangeStart;
          args.end = rangeEnd;
        }
        const raw = await callToolRaw(api, "get_member_profile", args);
        if (memberGenRef.current !== gen) return;
        const r = unwrapMcp(raw);
        setMemberProfile(r && !r.error ? r : { error: (r && r.error) || "读取成员画像失败" });
      } catch (err) {
        if (memberGenRef.current !== gen) return;
        setMemberProfile({ error: errText(err) });
      }
      setMemberBusy(false);
    },
    [api, sessionId, rangeStart, rangeEnd, memberAllTime, stopMemberAiStream],
  );

  /* ---- 成员检索：list_chatroom_members 按昵称 / 备注 / wxid 找榜外成员 ---- */
  const searchMembers = useCallback(async () => {
    if (!sessionId) return;
    setMemberSearchBusy(true);
    setMemberMsg("");
    try {
      const q = memberQuery.trim();
      const raw = await callToolRaw(api, "list_chatroom_members", {
        chatroom_id: sessionId,
        keyword: q || null,
        // 一次取全量：MCP 侧没有 offset，分页放在前端做（见 MEMBER_PAGE_SIZE）
        limit: 1000,
      });
      const r = unwrapMcp(raw);
      setMemberHits(r && !r.error ? r : { error: (r && r.error) || "读取群成员列表失败" });
      setMemberVisible(MEMBER_PAGE_SIZE);
    } catch (err) {
      setMemberHits({ error: errText(err) });
    }
    setMemberSearchBusy(false);
  }, [api, sessionId, memberQuery]);

  /* ---- 清空成员检索：输入与结果一起收掉（成员画像有独立的「收起」，不联动） ---- */
  const clearMemberSearch = useCallback(() => {
    setMemberQuery("");
    setMemberHits(null);
    setMemberVisible(MEMBER_PAGE_SIZE);
    setMemberSearchBusy(false);
  }, []);

  /* ---- 收起成员画像：显式关闭入口（成员榜同一行再次点击也走这里） ---- */
  const closeMemberProfile = useCallback(() => {
    stopMemberAiStream();
    setMemberBusy(false);
    setMemberProfile(null);
    setMemberMsg("");
    setMemberAiBusy(false);
    setMemberAiText("");
    setMemberAiData(null);
    setMemberAiConvId("");
    setMemberAiStatus("");
    setMemberAiMsg("");
  }, [stopMemberAiStream]);

  /* ---- 群分析提示词：按「分析维度」开关裁剪（关掉的维度不要求 Agent 生成，省 token） ---- */
  const prompt = useMemo(() => {
    const dims = aiSettings.dims;
    const limits = aiSettings.limits;
    const lines = [
      "请对本机微信会话做一次深度分析（只读，不要向微信发送任何消息）。",
      "",
      "会话：" + ((current && current.display_name) || sessionId) + "（session_id: " + sessionId + "）",
      "时间范围：" + rangeStart + " ~ " + rangeEnd + "（这是本次分析的唯一时间窗）",
      DEEP_WINDOW_NOTE,
      "",
      "取数建议（wechat MCP）：",
      "- get_group_digest(session_id, start, end, gap_minutes=30, top_n=20, highlights=30)：一次取齐概览 / 成员榜 / 互动网络 / 类型分布 / 金句候选，优先用它",
      "- get_member_profile(member, session_id, start, end, include_samples=30)：需要某个人的细节时调用，可直接带 30 条原文样本",
      "- get_messages_by_range(session_id, start, end, sender=?, limit=500, offset, order)：sender 传成员名或 wxid 可只看某人的发言（总结个人时用，服务端已过滤）；order=\"desc\" 取最新，offset 翻页",
      "",
      "长记录处理：",
      "- 若返回行数达到 limit，用 offset 继续翻页，直到取完或累计约 2000 条；不要只看第一页就下结论。",
      "- 超过约 800 条时，先按小时 / 话题分段做小结论，再合并成整体结论；某一段缺失不影响其它段。",
      "",
      "输出分两部分。",
      "",
      "第一部分：Markdown 正文，按下面的结构写：",
      "",
      "开头导语：1-2 句话概括这段时间最核心的内容（让人 30 秒抓住重点，不要复述下面的分类）。",
      "",
      "分类要点：根据实际内容**自行归纳** 3-6 个分类，每个分类标题带一个贴切的 emoji，例如：",
      "- 🛠 工具技巧 / 实战经验",
      "- 📦 资源推荐",
      "- 📰 行业动态",
      "- 💬 观点碰撞",
      "- 😄 群友趣事",
      "（分类名要贴合实际内容，不要生搬硬套；没有内容的分类不要出现；同一话题多人讨论要归并，不要逐条罗列）",
      "",
    ];
    AI_FORMAT_RULES.forEach((x) => lines.push(x));
    lines.push("", "附加章节（按需，没有就不写）：");
    let idx = 1;
    if (dims.topics) lines.push(idx++ + ". 主要议题（分点，标注参与人）");
    if (dims.todos) lines.push(idx++ + ". 关键结论 / 待办 / 需要谁跟进");
    if (dims.risks) lines.push(idx++ + ". 争议点与风险");
    if (dims.sentiment) lines.push(idx++ + ". 群氛围与情绪走向（结合统计与原文，不要编造）");

    lines.push("", "第二部分：在正文最后追加一个 json 代码块（用三个反引号包裹，标注 json），只放结构化数据，不要写注释：", "{");
    // 字段与约束由模块级生成器提供：深挖汇总阶段共用同一份 schema，避免两处分叉
    lines.push(aiJsonFields(dims, limits).join(",\n"));
    lines.push("}");

    lines.push("", "约束：");
    aiJsonConstraints(dims, limits).forEach((x) => lines.push(x));
    lines.push("除末尾这一个结构化数据块外，正文里**不要**出现任何 JSON 或代码块；数据块优先用 <<<AI_JSON>>> 与 <<<END>>> 包裹（也接受 ```json 围栏），必须是**完整可解析**的对象，并且放在回答的最后。");

    const extra = String(aiSettings.extra || "").trim();
    if (extra) {
      lines.push("", "补充要求（用户自定义，优先遵守）：", extra);
    }
    return lines.join("\n");
  }, [current, sessionId, rangeStart, rangeEnd, aiSettings]);

  /* ---- 从 Agent 回复里解析末尾的结构化 JSON 块（失败就只展示正文） ---- */
  const parseAiData = useCallback(
    (text) => {
      const src = String(text || "");
      // ① 独有标记 <<<AI_JSON>>> … <<<END>>>  ② ```json 围栏  ③ 兜底：正文里捞最后一个可解析对象
      const marker = src.match(/<<<AI_JSON>>>([\s\S]*?)<<<END>>>/i);
      const fence = src.match(/```json\s*([\s\S]*?)```/i);
      const raw = marker ? marker[1] : fence ? fence[1] : "";
      if (raw) {
        try {
          const obj = JSON.parse(String(raw).trim());
          if (obj && typeof obj === "object") return obj;
        } catch (err) {
          log(api, "ai json parse failed（改用正文兜底）: " + errText(err));
        }
      }
      const repaired = lastJsonObject(src);
      if (repaired) log(api, "ai json 从正文兜底解析成功");
      return repaired;
    },
    [api],
  );

  /* ---- 总结持久化：刷新面板 / 切群再回来都不丢（存 api.storage，按会话分键） ---- */
  const summaryKey = useCallback((sid) => "aiSummary:" + String(sid || ""), []);

  // 总结完成即落盘（正文 + 结构化数据 + 覆盖的时间范围）
  useEffect(() => {
    if (!sessionId || aiStatus !== "done" || !aiText) return;
    try {
      if (api.storage && api.storage.setJson) {
        api.storage.setJson(summaryKey(sessionId), {
          text: aiText,
          data: aiData || null,
          rangeStart: rangeStart,
          rangeEnd: rangeEnd,
          at: Date.now(),
        });
      }
    } catch (err) {
      /* 存不进去不影响展示 */
    }
  }, [api, sessionId, aiStatus, aiText, aiData, rangeStart, rangeEnd, summaryKey]);

  // 切会话 / 重开面板时把上次的总结读回来（绝不覆盖正在流式的会话）
  useEffect(() => {
    let alive = true;
    if (!sessionId) return undefined;
    Promise.resolve()
      .then(() => (api.storage && api.storage.getJson ? api.storage.getJson(summaryKey(sessionId)) : null))
      .then((saved) => {
        if (!alive || !saved || !saved.text) return;
        setAiText((prev) => prev || saved.text);
        setAiData((prev) => prev || saved.data || null);
        setAiStatus((prev) => (prev === "streaming" ? prev : "done"));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, sessionId, summaryKey]);

  /* ---- AI 深度分析：面板内流式渲染 ----
     两条数据通道：messages 域订阅（实时）+ 2s 轮询兜底。
     ⚠️ 完成判定只看**目标会话自己的 assistant 消息**（`items`）：
     域里的 `live` 是焦点会话状态，新建的会话在后台跑时它不是 streaming，
     早期实现用 live 判完成，导致第一次轮询就误判「已完成」并停掉轮询。 */
  // 流式结果按当前目标写入对应状态（群分析 / 成员分析共用同一条管线）
  const setTargetAi = useCallback((text) => {
    if (aiTargetRef.current === "member") setMemberAiText(text);
    else setAiText(text);
  }, []);
  const setTargetAiData = useCallback((data) => {
    if (aiTargetRef.current === "member") setMemberAiData(data);
    else setAiData(data);
  }, []);
  const setTargetAiStatus = useCallback((status) => {
    if (aiTargetRef.current === "member") setMemberAiStatus(status);
    else setAiStatus(status);
  }, []);

  const applyAiPayload = useCallback(
    (data) => {
      const msg = readAiMessage(data);
      if (!msg) return false; // 还没产出 assistant 消息：不判完成，继续等
      if (!msg.text) {
        if (msg.toolPending) setTargetAi("（Agent 正在调用工具…）");
        return false;
      }
      setTargetAi(msg.text);
      setTargetAiData(parseAiData(msg.text));
      if (msg.done) setTargetAiStatus("done");
      return msg.done;
    },
    [parseAiData, setTargetAi, setTargetAiData, setTargetAiStatus],
  );

  const startPoll = useCallback(
    (convId) => {
      stopPoll();
      if (!convId) return;
      aiPollStartRef.current = Date.now();
      aiPollRef.current = setInterval(async () => {
        // 超时保护：极端情况下（模型没按约定输出 json）也要收敛，不能无限轮询
        if (Date.now() - aiPollStartRef.current > AI_POLL_TIMEOUT_MS) {
          setTargetAiStatus("done");
          setSaveMsg("已停止等待：超过 10 分钟未解析到完整结果，可点「打开会话」查看原文。");
          stopPoll();
          return;
        }
        try {
          const resp = await api.metadata.get("messages", { params: { conversationId: convId } });
          // 权限被拒时绝不能无声地等满 10 分钟超时：把原因直接甩到面板上。
          // 常见成因：plugin.json 的 privacy.scopes 里没声明 "messages"，
          // 或声明了但 app 的插件注册记录还是旧版（需要 rescan / 重装才会重读）。
          const denied = resp && resp.denied && resp.denied.messages;
          if (denied) {
            setTargetAiStatus("done");
            setSaveMsg(
              "读取会话消息被拒（" + (denied.reason || "privacy-declaration-missing") +
                "）：需要在 plugin.json 的 privacy.scopes 里声明 \"messages\"，然后重装或重扫插件。",
            );
            stopPoll();
            return;
          }
          const data = (resp && resp.domains && resp.domains.messages) || (resp && resp.messages) || resp;
          if (applyAiPayload(data)) stopPoll();
        } catch (err) {
          /* 单次读取失败：等下一轮 */
        }
      }, 2000);
    },
    [api, applyAiPayload, stopPoll, setTargetAiStatus],
  );

  const subscribeAi = useCallback(
    async (convId) => {
      if (!convId) return;
      try {
        if (aiUnsubRef.current) aiUnsubRef.current();
      } catch (err) {
        /* 旧订阅已失效 */
      }
      aiUnsubRef.current = null;
      let subscribed = false;
      try {
        const sub = await api.metadata.subscribe(
          "messages",
          (payload) => {
            const data = (payload && payload.domains && payload.domains.messages) || payload;
            if (applyAiPayload(data)) {
              try {
                if (aiUnsubRef.current) aiUnsubRef.current();
              } catch (err) {
                /* 已完成，退订 */
              }
              aiUnsubRef.current = null;
              stopPoll();
            }
          },
          { params: { conversationId: convId } },
        );
        aiUnsubRef.current = typeof sub === "function" ? sub : (sub && sub.unsubscribe) || null;
        subscribed = true;
      } catch (err) {
        log(api, "subscribeAi failed: " + errText(err));
      }
      // 轮询兜底：订阅被拒（例如未声明 messages 域）或丢推送时仍能收敛
      startPoll(convId);
      if (!subscribed) {
        setSaveMsg("实时订阅不可用，已改用轮询读取该会话；若一直为空，请确认插件已声明 messages 权限。");
      }
    },
    [api, applyAiPayload, startPoll, stopPoll],
  );

  const runAi = useCallback(async () => {
    if (!sessionId) {
      setError(t.pick);
      return;
    }
    if (memberAiBusy || memberAiStatus === "streaming") {
      setError("成员分析正在生成，等它结束再做群分析。");
      return;
    }
    if (deepBusy) {
      setError("深挖正在运行，等它结束再做单会话分析（或先点「中止深挖」）。");
      return;
    }
    aiTargetRef.current = "group";
    setAiBusy(true);
    setError("");
    setCreated(null);
    setAiText("");
    setAiData(null);
    setAiConvId("");
    setSaveMsg("");
    setAiStatus("streaming");
    try {
      const directoryId = await resolveDirectoryId(api);
      const res = await api.write.run("conversations.create", {
        directoryId: directoryId,
        title: "群总结：" + ((current && current.display_name) || sessionId) + " " + rangeStart.slice(0, 10) + "~" + rangeEnd.slice(0, 10),
        text: prompt,
        autoReply: true,
      });
      if (!res || !res.ok) {
        const why = res && res.denied ? res.denied.reason : res && res.error ? res.error : "未知错误";
        throw new Error("创建会话失败：" + why);
      }
      setCreated(res.data || null);
      const convId = res.data && res.data.conversationId;
      if (convId) {
        setAiConvId(convId);
        await subscribeAi(convId);
      }
    } catch (err) {
      setError(errText(err));
      setAiStatus("error");
    }
    setAiBusy(false);
  }, [api, current, sessionId, rangeStart, prompt, subscribeAi, t.pick, memberAiBusy, memberAiStatus, deepBusy]);

  /* ---- 深挖流水线（阶段编排器）----
     四个阶段串行（阶段之间有强依赖），每个阶段内部由该阶段的 Agent 并行派子代理。
     面板**不能**直接激活子代理：宿主只给插件 subAgents.upsert / subAgents.remove，
     没有 activate —— 所以并行必须由 Agent 自己用 sub-agents-activate 发起
     （阶段提示词里写死了这件事，并给每个子代理编号分工）。
     面板负责：规划分段、注入统计基线、串联阶段、展示进度、中止。 */

  // 可 await 的单轮执行器：建会话 → 订阅/轮询 → 拿到完成正文 → resolve。
  // 与单轮管线（runAi）完全隔离：独立代次、独立 ref，绝不复用 aiUnsubRef / aiPollRef。
  const runOneTurn = useCallback(
    (opts) => {
      const { title, text, gen, onText } = opts;
      return (async () => {
        const directoryId = await resolveDirectoryId(api);
        const res = await api.write.run("conversations.create", {
          directoryId: directoryId,
          title: title,
          text: text,
          autoReply: true,
        });
        if (!res || !res.ok) {
          const why = res && res.denied ? res.denied.reason : res && res.error ? res.error : "未知错误";
          throw new Error("创建会话失败：" + why);
        }
        const convId = res.data && res.data.conversationId;
        if (!convId) throw new Error("创建会话未返回 conversationId");
        if (deepGenRef.current !== gen) throw new Error("已中止");
        deepConvRef.current = convId;
        const startedAt = Date.now();
        return await new Promise((resolve, reject) => {
          let timer = null;
          let unsub = null;
          let closed = false;
          let lastText = "";
          const finish = (fn, val) => {
            if (closed) return;
            closed = true;
            if (timer) clearInterval(timer);
            try {
              if (unsub) unsub();
            } catch (err) {
              /* 退订失败无所谓 */
            }
            if (deepUnsubRef.current === unsub) deepUnsubRef.current = null;
            fn(val);
          };
          const handle = (data) => {
            if (closed) return;
            const msg = readAiMessage(data);
            if (!msg) return;
            if (msg.text) {
              lastText = msg.text;
              if (onText) onText(msg.text);
            }
            if (msg.done) finish(resolve, { convId: convId, text: msg.text, incomplete: false });
          };
          const tick = async () => {
            if (closed) return;
            if (deepGenRef.current !== gen) {
              finish(reject, new Error("已中止"));
              return;
            }
            // 单阶段超时：不废掉整条流水线，把已拿到的文本交回并标记 incomplete
            if (Date.now() - startedAt > DEEP_STAGE_TIMEOUT_MS) {
              finish(resolve, { convId: convId, text: lastText, incomplete: true });
              return;
            }
            try {
              const resp = await api.metadata.get("messages", { params: { conversationId: convId } });
              const data = (resp && resp.domains && resp.domains.messages) || (resp && resp.messages) || resp;
              handle(data);
            } catch (err) {
              /* 单次读取失败：等下一轮 */
            }
          };
          timer = setInterval(tick, DEEP_POLL_INTERVAL_MS);
          tick();
          // 实时订阅：失败就纯轮询兜底（与单轮管线同策略）
          Promise.resolve()
            .then(() =>
              api.metadata.subscribe(
                "messages",
                (payload) => handle((payload && payload.domains && payload.domains.messages) || payload),
                { params: { conversationId: convId } },
              ),
            )
            .then((sub) => {
              const fn = typeof sub === "function" ? sub : (sub && sub.unsubscribe) || null;
              if (closed) {
                try {
                  if (fn) fn();
                } catch (err) {
                  /* 已结束，退订即可 */
                }
                return;
              }
              unsub = fn;
              deepUnsubRef.current = fn;
            })
            .catch(() => {
              /* 订阅不可用：轮询兜底 */
            });
        });
      })();
    },
    [api],
  );

  // 步骤状态局部更新（避免整表重建）
  const patchDeepStep = useCallback((id, patch) => {
    setDeepSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  /** 中止深挖：代次自增让在飞的阶段作废，并让宿主中止当前阶段会话（级联中止其子代理）。 */
  const stopDeep = useCallback(async () => {
    deepGenRef.current++;
    const convId = deepConvRef.current;
    deepConvRef.current = "";
    try {
      if (deepUnsubRef.current) deepUnsubRef.current();
    } catch (err) {
      /* 忽略 */
    }
    deepUnsubRef.current = null;
    setDeepBusy(false);
    setDeepSteps((prev) => prev.map((s) => (s.status === "running" ? { ...s, status: "cancelled" } : s)));
    setDeepMsg("已中止深挖。" + (convId ? "已请求宿主中止当前阶段会话（其子代理会级联中止）。" : ""));
    if (convId) {
      const res = await api.write.run("conversations.abort", { conversationId: convId });
      if (!res || !res.ok) {
        setDeepMsg("已中止深挖；会话中止请求未成功：" + ((res && res.error) || "未知错误"));
      }
    }
  }, [api]);

  const runDeep = useCallback(async () => {
    if (!sessionId) {
      setError(t.pick);
      return;
    }
    if (deepBusy || aiBusy || aiStatus === "streaming") {
      setDeepMsg("已有分析在运行，等它结束再开始深挖。");
      return;
    }
    const lenses = activeDeepLenses(aiSettings.dims);
    const segs = planDeepSegments(rangeStart, rangeEnd, stats, aiSettings.deep.segments);
    const verifyK = aiSettings.deep.verify;
    const gen = ++deepGenRef.current;
    const plan = [
      { id: "segment", label: DEEP_STAGE_LABELS.segment, detail: segs.length + " 段并行", status: "pending", convId: "", chars: 0, text: "", marks: [] },
      { id: "lens", label: DEEP_STAGE_LABELS.lens, detail: lenses.length + " 个视角并行", status: "pending", convId: "", chars: 0, text: "", marks: [] },
    ];
    if (verifyK > 0) {
      plan.push({ id: "verify", label: DEEP_STAGE_LABELS.verify, detail: lenses.length + " 个视角并行", status: "pending", convId: "", chars: 0, text: "", marks: [] });
    }
    plan.push({ id: "final", label: DEEP_STAGE_LABELS.final, detail: "1 轮", status: "pending", convId: "", chars: 0, text: "", marks: [] });
    setDeepSteps(plan);
    setDeepBusy(true);
    setDeepMsg("");
    setError("");
    setDeepText("");
    setDeepData(null);
    setDeepOpenStep("");

    const groupName = (current && current.display_name) || sessionId;
    const statsBrief = buildStatsBrief(stats, current, sessionId, rangeStart, rangeEnd);
    const base = {
      sessionName: groupName,
      sessionId: sessionId,
      rangeStart: rangeStart,
      rangeEnd: rangeEnd,
      extra: aiSettings.extra,
    };
    const titleOf = (label) => "深挖·" + label + "：" + groupName + " " + rangeStart.slice(0, 10) + "~" + rangeEnd.slice(0, 10);

    const runPhase = async (id, text) => {
      const step = plan.filter((s) => s.id === id)[0];
      patchDeepStep(id, { status: "running" });
      const r = await runOneTurn({
        title: titleOf(step.label),
        text: text,
        gen: gen,
        onText: (txt) => {
          if (deepGenRef.current !== gen) return;
          patchDeepStep(id, { text: txt, chars: txt.length, marks: readProgressMarks(txt) });
        },
      });
      patchDeepStep(id, {
        status: r.incomplete ? "partial" : "done",
        convId: r.convId,
        text: r.text,
        chars: String(r.text || "").length,
        marks: readProgressMarks(r.text),
      });
      return r;
    };

    try {
      // 阶段 1：并行分段读事实（只提取事实，不下结论）
      const s1 = await runPhase("segment", deepSegmentPrompt(Object.assign({}, base, { segments: segs })));
      const facts = stripJsonBlock(s1.text) || String(s1.text || "");
      if (!facts.trim()) throw new Error("阶段 1 未产出事实底稿（可能超时或未按格式输出）");
      // 阶段 2：多视角并行挖掘（每条结论必须可溯源）
      const s2 = await runPhase("lens", deepLensPrompt(Object.assign({}, base, { lenses: lenses, statsBrief: statsBrief, prev: facts })));
      // 阶段 3：对抗式交叉验证（用基线对账 + 回原文取证）
      let verified = String(s2.text || "");
      if (verifyK > 0) {
        const s3 = await runPhase(
          "verify",
          deepVerifyPrompt(Object.assign({}, base, { lenses: lenses, statsBrief: statsBrief, facts: facts, prev: String(s2.text || "") })),
        );
        verified = String(s2.text || "") + "\n\n===== 审查意见（用于修正与删除无据结论） =====\n\n" + String(s3.text || "");
      }
      // 阶段 4：汇总成稿（沿用既有 JSON schema，图表与报告零改动复用）
      const s4 = await runPhase(
        "final",
        deepFinalPrompt(
          Object.assign({}, base, { dims: aiSettings.dims, limits: aiSettings.limits, statsBrief: statsBrief, prev: verified }),
        ),
      );
      setDeepText(stripJsonBlock(s4.text));
      setDeepData(parseAiData(s4.text));
      setDeepMsg("深挖完成：" + plan.length + " 个阶段已收口，结果已并入下方「完整报告」的 AI 章节。");
    } catch (err) {
      const why = errText(err);
      if (why === "已中止") {
        setDeepMsg("已中止深挖。");
      } else {
        setDeepSteps((prev) => prev.map((s) => (s.status === "running" ? { ...s, status: "failed" } : s)));
        setDeepMsg("深挖中断：" + why + "（已完成的阶段产出仍保留在下方步骤里，可展开查看）");
      }
    }
    if (deepGenRef.current === gen) setDeepBusy(false);
  }, [api, sessionId, rangeStart, rangeEnd, stats, current, aiSettings, aiBusy, aiStatus, deepBusy, runOneTurn, patchDeepStep, t.pick]);

  /* ---- 角色维度：单个成员的近期发言分析（复用同一条流式管线，目标 = member） ---- */
  const memberPrompt = useCallback(
    (profile) => {
      if (!profile || !profile.member) return "";
      const uname = profile.member.username;
      const dname = profile.member.display_name;
      const allTime = memberAllTime;
      return [
        "请分析微信群成员「" + dname + "」在指定时间范围内的近期发言（只读，不要向微信发送任何消息）。",
        "",
        "群：" + ((current && current.display_name) || sessionId) + "（session_id: " + sessionId + "）",
        "成员：" + dname + "（username: " + uname + "）",
        allTime
          ? "时间范围：不限（覆盖该成员在本群的全部历史发言）"
          : "时间范围：" + rangeStart + " ~ " + rangeEnd + "（这是本次分析的唯一时间窗）",
        DEEP_WINDOW_NOTE,
        "",
        "取数建议（wechat MCP）：",
        "- get_member_profile(member=\"" + uname + "\", session_id" + (allTime ? "" : ", start, end") + ", top_n=10, include_samples=30)：画像 + 该成员最近 30 条原文，一次取齐",
        "- get_messages_by_range(session_id" + (allTime ? "" : ", start, end") + ", sender=\"" + uname + "\", limit=200, offset, order=\"desc\")：需要更多原文时按该成员翻页（服务端已按发言人过滤，不用自己筛）",
        "",
        "输出分两部分。",
        "",
        "第一部分：Markdown 正文，包含：",
        "1. 一句话人物素描（TA 在这个群里是谁）",
        "2. 近期关注与观点（分点，尽量引用原话）",
        "3. 语言风格与口头禅（结合 tone_words / top_phrases / samples）",
        "4. 互动对象与群内角色（谁常和 TA 互动、TA 起什么作用）",
        "5. 值得注意的发言或提醒",
        "",
        ...AI_FORMAT_RULES,
        "",
        "第二部分：在正文最后追加一个 json 代码块（三个反引号 + json），只放结构化数据，不要写注释：",
        "{",
        '  "persona": "一句话人物素描",',
        '  "topics": [{"name": "关注点", "weight": 0, "keywords": ["关键词"]}],',
        '  "style": {"tone": "语气特征", "habits": ["口头禅或习惯"]},',
        '  "interactions": [{"with": "互动对象", "pattern": "互动模式"}],',
        '  "quotes": [{"text": "原话", "why": "为什么值得记住"}],',
        '  "advice": ["给管理员或本人的建议"]',
        "}",
        "",
        "约束：topics 2-6 个（weight 取 0-100）；quotes 2-5 条且必须是原文摘录；没有把握的字段给空数组 / 空字符串，不要编造。",
        "除正文里的这一个 json 块外，不要再输出其它代码块。",
      ].join("\n");
    },
    [current, sessionId, rangeStart, rangeEnd, memberAllTime],
  );

  const runMemberAi = useCallback(async () => {
    if (!sessionId || !memberProfile || memberProfile.error) return;
    if (aiBusy || aiStatus === "streaming") {
      setMemberAiMsg("群分析正在生成，等它结束再分析成员。");
      return;
    }
    if (deepBusy) {
      setMemberAiMsg("深挖正在运行，等它结束再分析成员（或先点「中止深挖」）。");
      return;
    }
    aiTargetRef.current = "member";
    const gen = ++memberGenRef.current;
    setMemberAiBusy(true);
    setMemberAiMsg("");
    setMemberAiText("");
    setMemberAiData(null);
    setMemberAiConvId("");
    setMemberAiStatus("streaming");
    try {
      const directoryId = await resolveDirectoryId(api);
      const res = await api.write.run("conversations.create", {
        directoryId: directoryId,
        title:
          "成员画像：" +
          memberProfile.member.display_name +
          " " +
          rangeStart.slice(0, 10) +
          "~" +
          rangeEnd.slice(0, 10),
        text: memberPrompt(memberProfile),
        autoReply: true,
      });
      if (!res || !res.ok) {
        const why = res && res.denied ? res.denied.reason : res && res.error ? res.error : "未知错误";
        throw new Error("创建会话失败：" + why);
      }
      // 画像已收起或已切到别的成员：丢弃这次结果，不再订阅（避免复活后台流）
      if (memberGenRef.current !== gen) return;
      const convId = res.data && res.data.conversationId;
      if (convId) {
        setMemberAiConvId(convId);
        await subscribeAi(convId);
      }
    } catch (err) {
      if (memberGenRef.current !== gen) return;
      setMemberAiMsg("分析失败：" + errText(err));
      setMemberAiStatus("error");
    }
    if (memberGenRef.current === gen) setMemberAiBusy(false);
  }, [api, sessionId, memberProfile, memberPrompt, subscribeAi, aiBusy, aiStatus, deepBusy, rangeStart, rangeEnd]);

  const openMemberSession = useCallback(async () => {
    if (!memberAiConvId) return;
    const res = await api.write.run("conversations.activate", { conversationId: memberAiConvId });
    if (!res || !res.ok) setError("打开会话失败：" + (res && res.error ? res.error : "未知错误"));
  }, [api, memberAiConvId]);

  const copyMemberAi = useCallback(async () => {
    const text = String(memberAiText || "").replace(/```json\s*[\s\S]*?```/i, "").trim();
    if (!text) return;
    const res = await api.write.run("system.writeClipboardText", { text: text });
    setMemberAiMsg(res && res.ok ? "已复制分析正文" : "复制失败：" + ((res && res.error) || "未知错误"));
  }, [api, memberAiText]);

  /* ---- 成员画像导出：MD / HTML 长图 / 项目备忘录（与群报告同一套落盘路径，口径一致） ---- */
  const memberName = (memberProfile && memberProfile.member && memberProfile.member.display_name) || "";
  const memberMd = useMemo(() => {
    const p = memberProfile;
    if (!p || p.error) return "";
    const s = p.summary || {};
    const media = p.media || {};
    const rhythm = p.rhythm || {};
    const name = (p.member && p.member.display_name) || "";
    const uname = (p.member && p.member.username) || "";
    const total = Number(s.messages) || 0;
    const group = (current && current.display_name) || sessionId;
    const lines = [];
    lines.push("# 成员画像 · " + name);
    lines.push("");
    lines.push("> 群：" + group + "（" + sessionId + "）");
    lines.push("> 成员：" + name + (uname ? "（" + uname + "）" : ""));
    lines.push("> 时间范围：" + (memberAllTime ? "不限（全部历史）" : rangeStart + " ~ " + rangeEnd));
    lines.push("");
    lines.push("## 统计事实（MCP 全量聚合）");
    lines.push(
      "- 消息 " + fmtNum(total) + " 条 · 字数 " + fmtNum(Number(s.chars) || 0) +
      " · 活跃天数 " + (s.active_days || 0) + " · 范围内占比 " + fmtPct(s.share_of_scope),
    );
    if (s.first_time || s.last_time) lines.push("- 首末消息：" + (s.first_time || "—") + " → " + (s.last_time || "—"));
    const mix = [
      ["引用消息", media.quotes_given],
      ["表情", media.emojis],
      ["图片", media.images],
      ["文件", media.files],
      ["视频", media.videos],
      ["深夜 0–5 时", rhythm.night_messages],
      ["早起 6–8 时", rhythm.early_messages],
    ].filter((x) => Number(x[1]) > 0);
    if (mix.length) {
      lines.push("- 消息构成（分母 " + fmtNum(total) + " 条，同一条可计入多个维度）：" + mix.map((x) => x[0] + " " + x[1]).join(" / "));
    }
    if (rhythm.bursts) lines.push("- 连发 " + rhythm.bursts + " 次（与本人上一条消息间隔 ≤ 60 秒，不计入上方占比）");
    if ((p.top_quoted || []).length) {
      lines.push("");
      lines.push("## 常引用榜 · 我引用谁");
      (p.top_quoted || []).slice(0, 8).forEach((x) => lines.push("- " + x.name + " · " + x.count));
    }
    if ((p.quoted_by || []).length) {
      lines.push("");
      lines.push("## 被引用榜 · 谁引用我");
      (p.quoted_by || []).slice(0, 8).forEach((x) => lines.push("- " + x.name + " · " + x.count));
    }
    lines.push("");
    lines.push("## AI 角色分析");
    const ai = String(memberAiText || "").replace(/```json\s*[\s\S]*?```/i, "").trim();
    lines.push(ai || "（尚未生成：在面板点「分析该成员」后再导出）");
    lines.push("");
    lines.push("---");
    lines.push("由 Snow App「微信群聊」面板生成 · " + new Date().toLocaleString());
    return lines.join("\n");
  }, [memberProfile, current, sessionId, rangeStart, rangeEnd, memberAllTime, memberAiText]);

  const saveMemberMd = useCallback(async () => {
    if (!memberMd) return;
    setMemberMsg("");
    try {
      const root = await resolveProjectPath(api);
      if (!root) {
        setMemberMsg("拿不到当前项目路径：请先在 Snow App 打开一个项目再导出。");
        return;
      }
      const sep = /[\\/]$/.test(root) ? "" : root.indexOf("\\") >= 0 ? "\\" : "/";
      const filePath =
        root + sep + memberFileStem((current && current.display_name) || sessionId, memberName) + ".md";
      const res = await api.write.run("filesystem.writeFile", { filePath: filePath, content: memberMd });
      if (!res || !res.ok) {
        const why = res && res.denied ? res.denied.reason : res && res.error ? res.error : "未知错误";
        setMemberMsg("保存失败：" + why);
        return;
      }
      setMemberMsg("已保存：" + filePath);
      await api.write.run("panels.openFile", { filePath: filePath });
    } catch (err) {
      setMemberMsg("保存失败：" + errText(err));
    }
  }, [api, memberMd, current, sessionId, memberName]);

  const saveMemberHtml = useCallback(async () => {
    if (!memberProfile || memberProfile.error) return;
    setMemberMsg("");
    try {
      const root = await resolveProjectPath(api);
      if (!root) {
        setMemberMsg("拿不到当前项目路径：请先在 Snow App 打开一个项目再导出。");
        return;
      }
      const html = buildMemberHtml({
        groupName: (current && current.display_name) || sessionId,
        memberName: memberName,
        profile: memberProfile,
        avatarSrc: (memberProfile.member && avatars[memberProfile.member.username]) || "",
        rangeLabel: memberAllTime ? "不限时间范围（全部历史）" : rangeStart + " ~ " + rangeEnd,
        aiText: memberAiText,
        aiData: memberAiData,
        generatedAt: new Date().toLocaleString(),
      });
      const sep = /[\\/]$/.test(root) ? "" : root.indexOf("\\") >= 0 ? "\\" : "/";
      const filePath =
        root + sep + memberFileStem((current && current.display_name) || sessionId, memberName) + ".html";
      const res = await api.write.run("filesystem.writeFile", { filePath: filePath, content: html });
      if (!res || !res.ok) {
        const why = res && res.denied ? res.denied.reason : res && res.error ? res.error : "未知错误";
        setMemberMsg("保存失败：" + why);
        return;
      }
      setMemberMsg("已保存 HTML 长图：" + filePath + "（可用浏览器打开或截图分享）");
      await api.write.run("panels.openFile", { filePath: filePath });
    } catch (err) {
      setMemberMsg("保存失败：" + errText(err));
    }
  }, [api, memberProfile, memberName, current, sessionId, avatars, memberAllTime, rangeStart, rangeEnd, memberAiText, memberAiData]);

  const openSession = useCallback(
    async (convIdArg) => {
      const convId = convIdArg || (created && created.conversationId) || aiConvId;
      if (!convId) return;
      const res = await api.write.run("conversations.activate", { conversationId: convId });
      if (!res || !res.ok) setError("打开会话失败：" + (res && res.error ? res.error : "未知错误"));
    },
    [api, created, aiConvId],
  );

  /* ---- 分析档位推荐与深挖成本预估 ----
     判据：日 / 周 / 月这类「整段总结」值得多角度深挖；1-3 小时的时段单会话一轮就够。
     这里只给推荐，绝不强制 —— 成本写在旁边，由用户自己决定。 */
  const deepPlan = useMemo(() => {
    const from = new Date(String(rangeStart || "").replace(" ", "T"));
    const to = new Date(String(rangeEnd || "").replace(" ", "T"));
    const hours = !isNaN(from.getTime()) && !isNaN(to.getTime()) ? Math.max(0, (to.getTime() - from.getTime()) / 3600000) : 0;
    const msgs = Number(stats && stats.total_messages) || 0;
    const lenses = activeDeepLenses(aiSettings.dims).length;
    const segs = planDeepSegments(rangeStart, rangeEnd, stats, aiSettings.deep.segments).length;
    const verifyK = aiSettings.deep.verify;
    // 日报是 00:00:00 ~ 23:59:59（23.9999 小时），阈值取 23 才不会把「整天」误判成短时段
    const recommend = hours >= 23 || msgs >= DEEP_RECOMMEND.busyMessages ? "deep" : "standard";
    const stages = verifyK > 0 ? 4 : 3;
    // Agent 内部并行派子代理：阶段 1 派 segs 个，阶段 2 / 3 各派 lenses 个
    const subAgents = segs + lenses * (verifyK > 0 ? 2 : 1);
    return { hours: hours, msgs: msgs, lenses: lenses, segs: segs, verifyK: verifyK, recommend: recommend, stages: stages, subAgents: subAgents };
  }, [rangeStart, rangeEnd, stats, aiSettings]);

  // 结果槽：按当前档位优先，缺则回退另一档 —— 界面与报告同源，避免「看到 A 却报告写 B」
  const shownAiText = stripAiJson(deepMode === "deep" ? deepText || aiText : aiText || deepText);
  const shownAiData = deepMode === "deep" ? deepData || aiData : aiData || deepData;
  // 深挖最后一个已有会话的阶段（「打开会话」用）
  const deepLastConvId = useMemo(() => {
    for (let i = deepSteps.length - 1; i >= 0; i--) {
      if (deepSteps[i].convId) return deepSteps[i].convId;
    }
    return "";
  }, [deepSteps]);

  /* ---- 趋势：报告类型决定粒度（日=小时，周/月=天，年=月） ---- */
  const trend = useMemo(() => {
    const empty = { kind: "hour", title: "24 小时分布", points: [], maxValue: 1 };
    if (!stats) return empty;

    const labelEvery = (points) => {
      const step = Math.max(1, Math.ceil(points.length / 8));
      return points.map((p, i) => ({ ...p, label: i % step === 0 ? p.short : "" }));
    };

    const dayCount = Object.keys(stats.daily_distribution || {}).length;
    const useHours = forceHourly || reportPeriod === "day" || (reportPeriod === "custom" && dayCount <= 1);
    if (useHours) {
      // 滚动 24 小时：必须用绝对时间小时序列（跨天时 0-23 合并会把昨天/今天的同一小时串桶）
      const series = forceHourly
        ? hourMetric === "senders"
          ? stats.hourly_series_senders
          : stats.hourly_series
        : null;
      if (forceHourly && Array.isArray(series) && series.length) {
        const byHour = new Map();
        for (const x of series) byHour.set(String(x.hour), Number(x.count) || 0);
        const slots = [];
        const cursor = new Date(rangeStart.slice(0, 13).replace(" ", "T") + ":00:00");
        const lastSlot = new Date(rangeEnd.slice(0, 13).replace(" ", "T") + ":00:00");
        let guard = 0;
        while (!isNaN(cursor.getTime()) && cursor <= lastSlot && guard < 24 * 40) {
          const key = dateStr(cursor) + " " + pad2(cursor.getHours());
          slots.push({ key: key, short: pad2(cursor.getHours()), value: byHour.get(key) || 0 });
          cursor.setHours(cursor.getHours() + 1);
          guard += 1;
        }
        const points = labelEvery(slots);
        return {
          kind: "hour",
          title: (hourMetric === "senders" ? "滚动 24 小时活跃人数" : "滚动 24 小时分布"),
          points: points,
          maxValue: points.reduce((a, p) => Math.max(a, p.value), 1),
        };
      }
      // 回退（旧版 MCP 未重启）：0-23 合并口径，单日准确、跨天会串桶
      const map = hourMetric === "senders" ? stats.hourly_unique_senders : stats.hourly_distribution;
      const points = labelEvery(
        Array.from({ length: 24 }, (_, i) => {
          const key = pad2(i);
          return { key: key, short: key, value: Number(map && map[key]) || 0 };
        }),
      );
      return {
        kind: "hour",
        title: forceHourly ? "24 小时分布 · 跨天近似" : "24 小时分布",
        points: points,
        maxValue: points.reduce((a, p) => Math.max(a, p.value), 1),
      };
    }

    if (reportPeriod === "year") {
      const monthly = new Map();
      for (const [date, n] of Object.entries(stats.daily_distribution || {})) {
        const key = String(date).slice(0, 7);
        monthly.set(key, (monthly.get(key) || 0) + (Number(n) || 0));
      }
      // 补齐范围内没有消息的月份，保持 x 轴等距（MCP 只返回有数据的月份）
      const months = [];
      const cursor = new Date(rangeStart.slice(0, 7) + "-01T00:00:00");
      const lastMonth = new Date(rangeEnd.slice(0, 7) + "-01T00:00:00");
      let guard = 0;
      while (!isNaN(cursor.getTime()) && cursor <= lastMonth && guard < 240) {
        const key = dateStr(cursor).slice(0, 7);
        months.push({ key: key, short: key.slice(5), value: monthly.get(key) || 0 });
        cursor.setMonth(cursor.getMonth() + 1);
        guard += 1;
      }
      const points = labelEvery(
        months.length
          ? months
          : Array.from(monthly.entries())
              .sort()
              .map(([key, value]) => ({ key: key, short: key.slice(5), value: value })),
      );
      return {
        kind: "month",
        title: "每月趋势",
        points: points,
        maxValue: points.reduce((a, p) => Math.max(a, p.value), 1),
      };
    }

    const raw =
      stats.daily_trend && stats.daily_trend.length
        ? stats.daily_trend
        : Object.keys(stats.daily_distribution || {})
            .sort()
            .map((d) => ({ date: d, messages: stats.daily_distribution[d] }));
    // 补齐范围内没有消息的日期：MCP 只返回有数据的日期，直接画会跳过空白天（x 轴不等距，
    // 视觉上把「好几天没人说话」压缩掉了）
    const byDate = new Map();
    for (const x of raw) byDate.set(String(x.date).slice(0, 10), Number(x.messages) || 0);
    const days = [];
    const cursor = new Date(rangeStart.slice(0, 10) + "T00:00:00");
    const lastDay = new Date(rangeEnd.slice(0, 10) + "T00:00:00");
    let guard = 0;
    while (!isNaN(cursor.getTime()) && cursor <= lastDay && guard < 1200) {
      const key = dateStr(cursor);
      days.push({ key: key, short: key.slice(5), value: byDate.get(key) || 0 });
      cursor.setDate(cursor.getDate() + 1);
      guard += 1;
    }
    const points = labelEvery(
      days.length
        ? days
        : raw.map((x) => ({ key: x.date, short: String(x.date).slice(5), value: Number(x.messages) || 0 })),
    );
    return {
      kind: "day",
      title: "每日趋势",
      points: points,
      maxValue: points.reduce((a, p) => Math.max(a, p.value), 1),
    };
  }, [stats, reportPeriod, hourMetric, forceHourly, rangeStart, rangeEnd]);

  const periodLabel = useMemo(() => {
    const map = { day: "日报", week: "周报", month: "月报", year: "年报", custom: "自定义报告" };
    return map[reportPeriod] || "报告";
  }, [reportPeriod]);

  const toggleSection = useCallback((key) => {
    setReportSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  /* ---- 完整报告：把当前报告类型下的全部维度拼成 Markdown ---- */
  const reportMd = useMemo(() => {
    // 报告里的 AI 章节：与界面同源（按档位优先的那个结果槽）
    const aiText = shownAiText;
    const aiData = shownAiData;
    if (!stats) return "";
    const d = stats;
    const name = (current && current.display_name) || sessionId;
    const lines = [];
    lines.push("# " + periodLabel + " · " + name);
    lines.push("");
    lines.push("- 时间范围：" + rangeStart + " ~ " + rangeEnd);
    if (reportSections.overview) {
      lines.push(
        "- 消息：" + fmtNum(d.total_messages || 0) +
          " · 发言人数：" + fmtNum(d.unique_senders || 0) +
          " · 人均 " + (d.unique_senders ? Math.round((d.total_messages || 0) / d.unique_senders) : 0) + " 条",
      );
      if (d.silent_members) {
        lines.push(
          "- 成员活跃率：" + fmtPct(d.silent_members.active_rate) +
            "（" + d.silent_members.active_members + "/" + d.silent_members.member_total + "）",
        );
      }
      if (d.concentration) {
        lines.push("- 集中度：Gini " + d.concentration.gini + " · Top10 份额 " + fmtPct(d.concentration.top_n_share) + " · HHI " + d.concentration.hhi);
      }
      if (d.sessionization) {
        lines.push(
          "- 会话片段：" + d.sessionization.segment_count + " 段 · 平均 " +
            d.sessionization.avg_segment_messages + " 条/段 · 中位间隔 " +
            (d.sessionization.median_gap_seconds || 0) + "s · 最长沉默 " +
            Math.round((d.sessionization.longest_silence_seconds || 0) / 60) + " 分钟",
        );
      }
      if (d.system_events) {
        lines.push(
          "- 撤回类事件：" + d.system_events.recall_like_count +
            " · 系统消息：" + d.system_events.system_message_count,
        );
      }
    }

    const topPoints = trend.points
      .slice()
      .sort((a, b) => b.value - a.value)
      .slice(0, 3)
      .filter((p) => p.value > 0);
    if (reportSections.trend && topPoints.length) {
      lines.push("");
      lines.push("## " + trend.title);
      lines.push("- 峰值：" + topPoints[0].key + "（" + fmtNum(topPoints[0].value) + " 条）");
      lines.push("- Top 3：" + topPoints.map((p) => p.key + " " + fmtNum(p.value)).join("、"));
    }

    // 群自身（系统消息 / 群公告的发送者）不是成员，报告同样排除
    const members = (d.member_rank || []).filter((m) => (m.u || "") !== sessionId);
    if (reportSections.members && members.length) {
      lines.push("");
      lines.push("## 成员榜");
      members.slice(0, 10).forEach((m, i) => {
        lines.push(
          i + 1 + ". " + (m.name || m.u) + " — " + fmtNum(m.messages) + " 条 · " + fmtNum(m.chars) +
            " 字 · 图片 " + fmtNum(m.images || 0) + " · 表情 " + fmtNum(m.emojis || 0) +
            " · 被引用 " + fmtNum(m.quoted || 0) + " · 连发 " + fmtNum(m.bursts || 0),
        );
      });
    }

    const edges = (d.quote_network && d.quote_network.edges) || [];
    if (reportSections.network && edges.length) {
      lines.push("");
      lines.push("## 互动关系 Top");
      edges.slice(0, 8).forEach((e) => lines.push("- " + e.from + " → " + e.to + " × " + e.count));
    }

    const types = mergeTypeRows(d.type_distribution || []);
    if (reportSections.types && types.length) {
      lines.push("");
      lines.push("## 消息类型");
      types.slice(0, 8).forEach(([label, count]) => lines.push("- " + label + "：" + fmtNum(count)));
    }

    const highlights = d.highlights || [];
    if (reportSections.quotes && highlights.length) {
      lines.push("");
      lines.push("## 金句候选（按长度）");
      highlights.forEach((h) =>
        lines.push("> " + String(h.content || "").replace(/\s+/g, " ").slice(0, 300) + " —— " + h.display_name),
      );
    }

    if (reportSections.ai && aiText) {
      lines.push("");
      lines.push("## AI 分析");
      lines.push(String(aiText).replace(/```json\s*[\s\S]*?```/i, "").trim());
    }

    if (reportSections.ai && aiData) {
      const list = (x) => (Array.isArray(x) ? x : []);
      if (list(aiData.sentiment).length) {
        lines.push("");
        lines.push("## 情绪曲线");
        list(aiData.sentiment).forEach((x) => lines.push("- " + String(x.period || "") + "：" + (Number(x.score) || 0)));
      }
      if (list(aiData.controversies).length) {
        lines.push("");
        lines.push("## 争议指数");
        list(aiData.controversies).forEach((x) =>
          lines.push("- " + String(x.topic || "") + "（" + (Number(x.level) || 0) + "/5）" + (x.reason ? " — " + x.reason : "")),
        );
      }
      if (list(aiData.titles).length) {
        lines.push("");
        lines.push("## 称号");
        list(aiData.titles).forEach((x) =>
          lines.push("- " + String(x.who || "") + " · " + String(x.title || "") + (x.reason ? "（" + x.reason + "）" : "")),
        );
      }
      if (list(aiData.quotes).length) {
        lines.push("");
        lines.push("## 金句");
        list(aiData.quotes).forEach((x) => lines.push("> " + String(x.text || "") + " —— " + String(x.who || "")));
      }
      if (aiData.profile && typeof aiData.profile === "object") {
        lines.push("");
        lines.push("## 群画像");
        if (aiData.profile.summary) lines.push(String(aiData.profile.summary));
        if (aiData.profile.style) lines.push("- 风格：" + String(aiData.profile.style));
        list(aiData.profile.advice).forEach((a) => lines.push("- 建议：" + String(a)));
      }
    }

    lines.push("");
    lines.push("---");
    lines.push("由 Snow App「微信群聊」面板生成 · " + new Date().toLocaleString());
    return lines.join("\n");
  }, [stats, current, sessionId, rangeStart, rangeEnd, shownAiText, shownAiData, periodLabel, trend, reportSections]);

  const copyReport = useCallback(async () => {
    if (!reportMd) return;
    try {
      const res = await api.write.run("system.writeClipboardText", { text: reportMd });
      setReportMsg(res && res.ok ? "已复制到剪贴板" : "复制失败：" + ((res && res.error) || "未知错误"));
    } catch (err) {
      setReportMsg("复制失败：" + errText(err));
    }
  }, [api, reportMd]);

  const saveReport = useCallback(async () => {
    if (!reportMd) return;
    setReportMsg("");
    try {
      const root = await resolveProjectPath(api);
      if (!root) {
        setReportMsg("拿不到当前项目路径：请先在 Snow App 打开一个项目再导出。");
        return;
      }
      const name =
        "wechat-" +
        periodLabel +
        "-" +
        safeFileName((current && current.display_name) || sessionId, "wechat") +
        "-" +
        rangeStart.slice(0, 10).replace(/-/g, "") +
        ".md";
      const sep = /[\\/]$/.test(root) ? "" : root.indexOf("\\") >= 0 ? "\\" : "/";
      const filePath = root + sep + name;
      const res = await api.write.run("filesystem.writeFile", { filePath: filePath, content: reportMd + "\n" });
      if (!res || !res.ok) {
        const why = res && res.denied ? res.denied.reason : res && res.error ? res.error : "未知错误";
        setReportMsg("保存失败：" + why);
        return;
      }
      setReportMsg("已保存：" + filePath);
      await api.write.run("panels.openFile", { filePath: filePath });
    } catch (err) {
      setReportMsg("保存失败：" + errText(err));
    }
  }, [api, reportMd, current, sessionId, rangeStart, periodLabel]);

  // 导出 HTML 长图：自包含样式 + 头像 data URL，浏览器打开即可截图分享（不做 PNG）
  const saveReportHtml = useCallback(async () => {
    if (!stats) return;
    setReportMsg("");
    try {
      const root = await resolveProjectPath(api);
      if (!root) {
        setReportMsg("拿不到当前项目路径：请先在 Snow App 打开一个项目再导出。");
        return;
      }
      const html = buildReportHtml({
        periodLabel: periodLabel,
        title: ((current && current.display_name) || sessionId) || "微信群",
        rangeLabel: rangeStart + " ~ " + rangeEnd,
        stats: stats,
        trend: trend,
        avatarMap: avatars,
        aiText: shownAiText,
        aiData: shownAiData,
        sessionId: sessionId,
        generatedAt: new Date().toLocaleString(),
      });
      const name =
        "wechat-" +
        periodLabel +
        "-" +
        safeFileName((current && current.display_name) || sessionId, "wechat") +
        "-" +
        rangeStart.slice(0, 10).replace(/-/g, "") +
        ".html";
      const sep = /[\\/]$/.test(root) ? "" : root.indexOf("\\") >= 0 ? "\\" : "/";
      const filePath = root + sep + name;
      const res = await api.write.run("filesystem.writeFile", { filePath: filePath, content: html });
      if (!res || !res.ok) {
        const why = res && res.denied ? res.denied.reason : res && res.error ? res.error : "未知错误";
        setReportMsg("保存失败：" + why);
        return;
      }
      setReportMsg("已保存 HTML 长图：" + filePath + "（可用浏览器打开或截图分享）");
      await api.write.run("panels.openFile", { filePath: filePath });
    } catch (err) {
      setReportMsg("保存失败：" + errText(err));
    }
  }, [api, stats, trend, avatars, shownAiText, shownAiData, current, sessionId, rangeStart, rangeEnd, periodLabel]);

  /* ---- 定时日报：交给宿主「定时任务」的 AI Loop 执行 ---- */
  const cronPrompt = useMemo(
    () => buildCronPrompt((current && current.display_name) || sessionId, sessionId),
    [current, sessionId],
  );

  const copyCronPrompt = useCallback(async () => {
    try {
      const res = await api.write.run("system.writeClipboardText", { text: cronPrompt });
      setReportMsg(
        res && res.ok
          ? "已复制定时日报提示词：到「定时任务」面板新建任务并粘贴即可（建议每天 22:00）。"
          : "复制失败：" + ((res && res.error) || "未知错误"),
      );
    } catch (err) {
      setReportMsg("复制失败：" + errText(err));
    }
  }, [api, cronPrompt]);

  const createCronTask = useCallback(async () => {
    if (!sessionId) {
      setReportMsg("先选择一个群聊。");
      return;
    }
    setReportMsg("");
    const groupName = ((current && current.display_name) || sessionId) || "微信群";
    const name = "微信群日报 · " + groupName;
    try {
      const res = await api.write.run("scheduledTasks.create", {
        name: name,
        prompt: cronPrompt,
        schedule: { type: "recurring", mode: "daily", hour: Number(cron.hour) || 0, minute: Number(cron.minute) || 0 },
      });
      const why = res && res.denied ? res.denied.reason : res && res.error;
      if (!res || !res.ok) {
        setReportMsg("创建失败：" + (why || "未知错误") + "（可点「复制提示词」，在「定时任务」面板手动新建）");
        return;
      }
      const taskId =
        (res.data && (res.data.id || res.data.taskId)) ||
        (res.data && res.data.task && res.data.task.id) ||
        "";
      let msg = "已创建每日 " + pad2(cron.hour) + ":" + pad2(cron.minute) + " 的日报任务" + (taskId ? "（" + taskId + "）" : "") + "。";
      if (cron.catchup) {
        // 宿主定时任务在 App 关闭期间会被跳过 —— 再加一个幂等的补发检查（同名文件存在即跳过）
        const r2 = await api.write.run("scheduledTasks.create", {
          name: name + "（补发检查）",
          prompt: cronPrompt,
          schedule: { type: "recurring", mode: "interval", intervalMs: 3 * 60 * 60 * 1000 },
        });
        msg +=
          r2 && r2.ok
            ? "已加每 3 小时补发检查（今天已生成则跳过）。"
            : "补发检查创建失败：" + ((r2 && (r2.denied ? r2.denied.reason : r2.error)) || "未知错误") + "。";
      }
      setReportMsg(msg);
    } catch (err) {
      setReportMsg("创建失败：" + errText(err) + "（可点「复制提示词」手动新建）");
    }
  }, [api, sessionId, current, cronPrompt, cron]);

  // 卸载时释放 messages 订阅与轮询（hooks 必须注册在提前 return 之前）
  useEffect(
    () => () => {
      try {
        if (aiUnsubRef.current) aiUnsubRef.current();
      } catch (err) {
        /* 忽略 */
      }
      aiUnsubRef.current = null;
      stopPoll();
    },
    [stopPoll],
  );

  /* ---- MCP 能力 ---- */
  const ctx = { sessionId: sessionId, start: rangeStart, end: rangeEnd };

  const valueOf = useCallback(
    (toolName, field) => {
      const bucket = values[toolName];
      if (bucket && bucket[field.k] !== undefined) return bucket[field.k];
      return fieldDefault(field, ctx);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [values, sessionId, start, end],
  );

  const setValue = useCallback((toolName, k, v) => {
    setValues((prev) => {
      const next = Object.assign({}, prev);
      next[toolName] = Object.assign({}, next[toolName] || {}, { [k]: v });
      return next;
    });
  }, []);

  const buildArgs = useCallback(
    (tool) => {
      const out = {};
      for (const f of tool.fields || []) {
        const v = valueOf(tool.name, f);
        if (f.type === "switch") {
          if (v) out[f.k] = true;
          continue;
        }
        if (f.type === "number") {
          if (v === "" || v === undefined || v === null) continue;
          const n = Number(v);
          if (Number.isFinite(n)) out[f.k] = n;
          continue;
        }
        if (v === "" || v === undefined || v === null) continue;
        // bool 字段（select 只能给字符串）：显式转成布尔，不依赖后端的字符串宽松转换
        if (f.bool) {
          out[f.k] = String(v).toLowerCase() === "true";
          continue;
        }
        // list 字段：表单里是一行文本，按逗号 / 顿号 / 空白拆成数组再传给 MCP
        if (f.list) {
          const arr = String(v)
            .split(/[,，、\s]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (arr.length) out[f.k] = arr;
          continue;
        }
        out[f.k] = v;
      }
      return out;
    },
    [valueOf],
  );

  const resetTool = useCallback((tool) => {
    setValues((prev) => {
      const next = Object.assign({}, prev);
      delete next[tool.name];
      return next;
    });
    setArmed("");
  }, []);

  const toggleTool = useCallback((name) => {
    setOpenTool((prev) => (prev === name ? "" : name));
    setArmed("");
    setCallResult(null);
  }, []);

  const invokeTool = useCallback(
    async (tool) => {
      if (tool.dangerous && armed !== tool.name) {
        setArmed(tool.name);
        return;
      }
      setCallBusy(true);
      setCallResult(null);
      const t0 = Date.now();
      try {
        const raw = await callToolRaw(api, tool.name, buildArgs(tool));
        const data = unwrapMcp(raw);
        const arr = Array.isArray(data) ? data : null;
        setCallResult({
          ok: true,
          ms: Date.now() - t0,
          count: arr ? arr.length : null,
          rows: arr,
          object: !arr && data && typeof data === "object" ? data : null,
          text: pretty(data, 20000),
        });
      } catch (err) {
        setCallResult({ ok: false, ms: Date.now() - t0, error: errText(err) });
      }
      setCallBusy(false);
      setArmed("");
    },
    [api, armed, buildArgs],
  );

  /* ---- 过滤与分组 ---- */
  const visible = useMemo(
    () =>
      messages.filter((m) => {
        if (!m) return false;
        if (onlyMedia && !isMedia(m.content)) return false;
        if (onlyAt && String(m.content || "").indexOf("@") < 0) return false;
        return true;
      }),
    [messages, onlyMedia, onlyAt],
  );

  const groups = useMemo(() => {
    const map = new Map();
    for (const m of visible) {
      const k = dayKeyOf(m.time) || "未知日期";
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(m);
    }
    // messages 已是 asc（旧→新）：日期组按旧 → 新，组内保持时间正序。
    // 与微信一致 —— 最新消息在底部，向上才是更早。
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [visible]);

  /* ---- 报告类型：日 / 周 / 月 / 年 → 自动时间窗（MCP 只认 start/end，语义留在面板） ---- */
  const applyPeriod = useCallback(
    (period) => {
      setReportPeriod(period);
      setForceHourly(false);
      const now = new Date();
      let from = new Date(now);
      let to = new Date(now);
      if (period === "day") {
        from.setHours(0, 0, 0, 0);
        to.setHours(23, 59, 59, 999);
      } else if (period === "week") {
        const offset = (now.getDay() + 6) % 7; // 周一 = 0
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, 0, 0, 0, 0);
        to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6, 23, 59, 59, 999);
      } else if (period === "month") {
        from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      } else if (period === "year") {
        from = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
        to = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      }
      const startBound = dateStr(from) + " " + timeStr(from) + ":00";
      const endBound = dateStr(to) + " " + timeStr(to) + ":59";
      setStart(dateStr(from));
      setStartTime(timeStr(from));
      setEnd(dateStr(to));
      setEndTime(timeStr(to));
      // 直接传算好的边界，避免 setState 异步导致这一轮仍查旧范围
      loadStats({ start: startBound, end: endBound });
    },
    [loadStats],
  );

  /* ---- 滚动 24 小时：从当前时刻往前 24h（可跨天），趋势用绝对小时序列 ---- */
  const applyRolling24 = useCallback(() => {
    setReportPeriod("custom");
    setForceHourly(true);
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
    setStart(dateStr(from));
    setStartTime(timeStr(from));
    setEnd(dateStr(to));
    setEndTime(timeStr(to));
    loadStats({
      start: dateStr(from) + " " + timeStr(from) + ":00",
      end: dateStr(to) + " " + timeStr(to) + ":59",
    });
  }, [loadStats]);

  /* ---- 时间快捷预设：今天 / 近 7 天 / 近 30 天
     今天 = 日报（与自然日同口径）；近 7 / 30 天是滚动窗口，标为「自定义」，
     因为「近 7 天」≠ 自然周（周一到周日）。改完范围立即重算，避免画面残留旧数据。 ---- */
  const applyPreset = useCallback(
    (days, period) => {
      setReportPeriod(period || "custom");
      setForceHourly(false);
      const from = daysAgoStr(days);
      const to = todayStr();
      setStart(from);
      setStartTime("00:00");
      setEnd(to);
      setEndTime("23:59");
      // 直接传算好的边界，避免 setState 异步导致这一轮仍查旧范围
      loadStats({ start: from + " 00:00:00", end: to + " 23:59:59" });
    },
    [loadStats],
  );

  /* ---- 重置：把群选择 / 日期范围 / 关键词 / 过滤条件恢复默认 ---- */
  const resetFilters = useCallback(() => {
    setSessionId("");
    // 重置后回到默认「当天 = 日报」语义，避免残留上一次的周报/自定义标签
    setReportPeriod("day");
    setForceHourly(false);
    setStart(todayStr());
    setStartTime("00:00");
    setEnd(todayStr());
    setEndTime("23:59");
    setKeyword("");
    setOnlyMedia(false);
    setOnlyAt(false);
    setMessages([]);
    setStats(null);
    setAiData(null);
    setHasMore(false);
    setOlderBatches(0);
    setError("");
    setDebug("");
    setSyncMsg(null);
    log(api, "filters reset");
  }, [api]);

  /* ---- 手动同步：阻塞执行（单一路径）----
     实测全量同步约 72s（解密 ~6s + ETL ~66s），在宿主 120s 上限内。
     曾用 start_sync + 轮询状态，但短连接宿主会在 MCP 进程退出时终止后台进程，
     状态文件永不更新 → 按钮永远停在「同步中」；改用阻塞调用后失败立刻可见。 */
  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      // 阻塞同步：宿主对单次 MCP 调用上限约 120s，本机全量同步实测约 72s
      //（解密 ~6s + ETL ~66s）。此前走 start_sync + 轮询的分离进程方案，在短连接
      // 宿主上会随 MCP 进程退出被终止 —— 状态文件永不更新，按钮永远停在「同步中」。
      // 这里直接用阻塞版本：只有一条路径，失败立刻可见。
      setSyncMsg({
        ok: true,
        text: (t.syncing || "同步中…") + "：重新解密 + 重建索引，通常 1–3 分钟…",
      });
      const raw = await callToolRaw(api, "sync_wechat_database", { redecrypt: true });
      const r = unwrapMcp(raw) || {};
      const ok = r.ok !== false;
      const etl = r.etl_step || {};
      const decrypt = r.decrypt_step || {};
      if (!ok) {
        const why = decrypt.error || etl.reason || r.error || "未知原因";
        setSyncMsg({ ok: false, text: t.syncFail + "：" + String(why).slice(0, 240) });
      } else {
        setSyncMsg({
          ok: true,
          text:
            t.syncOk +
            " · " +
            fmtNum(etl.messages || 0) +
            " " +
            t.total +
            (decrypt.seconds ? " · 解密 " + decrypt.seconds + "s" : ""),
        });
        setSessionsNonce((n) => n + 1);
        if (sessionId) await loadFeed();
      }
      log(api, "sync done -> " + preview(r, 300));
    } catch (err) {
      setSyncMsg({ ok: false, text: t.syncFail + "：" + errText(err) });
    } finally {
      setSyncing(false);
    }
  }, [api, sessionId, t, loadFeed]);

  if (dep.phase === "checking") {
    return h("div", { className: "swf-root" }, h("div", { className: "swf-empty" }, "正在检测 wechat MCP…"));
  }
  if (dep.phase === "blocked") {
    return h("div", { className: "swf-root" }, h(DependencyGuide, { state: dep, t, onRetry: recheck }));
  }

  const counts = dep.status && dep.status.counts ? dep.status.counts : null;

  /* ---- 渲染：信息流 ---- */
  const renderMsg = (m, cont) => {
    const key = String(m.id) + "-" + m.time;
    const cls = classify(m.content);

    // 系统消息（入群提示 / 撤回 / 群公告…）：解析成一句话，居中弱化显示
    if (cls.tag === "系统") {
      return h("div", { className: "swf-sys", key: key }, sysmsgText(m.content) || "系统消息");
    }

    const sender = m.sender_name || "?";
    const av = (m.sender_username && avatars[m.sender_username]) || "";

    // [图片] 消息：原图是 .dat 私有容器。交给上游 MCP get_message_image 按消息 id
    // 解密导出为真实图片文件，再走宿主读盘渲染（懒加载，点击才调用）。
    if (cls.tag === "图片") {
      const media = h(McpImage, {
        api: api,
        messageId: m.id,
        title: "图片 · " + m.time,
        onOpen: (p) => openLocalFile(api, p),
      });
      return h(
        "div",
        {
          className: "swf-msg" + (cont ? " swf-msg-cont" : "") + (hlId === String(m.id) ? " swf-hl" : ""),
          key: key,
          "data-mid": m.id,
          // 连续发言折叠了昵称行，用 title 补回「谁 + 什么时候」且不改变行高
          title: cont ? sender + " · " + hhmmOf(m.time) : undefined,
        },
        avatarNode(sender, cont, av),
        h(
          "div",
          { className: "swf-main" },
          h(
            "div",
            { className: "swf-head" },
            h("span", { className: "swf-sender", style: { color: speakerColor(sender) } }, sender),
            h("span", { className: "swf-tag" }, "图片"),
            h("span", { className: "swf-time" }, hhmmOf(m.time)),
          ),
          media,
        ),
      );
    }

    const q = splitQuote(cls.text);
    const bodyText = q ? q.body : cls.text;

    // [表情] 消息：MCP 已从原始 XML 提取 md5，本地表情库里有明文就直接渲染表情图
    // （取不到由组件内部静默回退成 [表情] 文本，不额外弹错）
    if (cls.tag === "表情" && m.emoticon_md5) {
      return h(
        "div",
        {
          className: "swf-msg" + (cont ? " swf-msg-cont" : "") + (hlId === String(m.id) ? " swf-hl" : ""),
          key: key,
          "data-mid": m.id,
          title: cont ? sender + " · " + hhmmOf(m.time) : undefined,
        },
        avatarNode(sender, cont, av),
        h(
          "div",
          { className: "swf-main" },
          h(
            "div",
            { className: "swf-head" },
            h("span", { className: "swf-sender", style: { color: speakerColor(sender) } }, sender),
            h("span", { className: "swf-tag" }, "表情"),
            h("span", { className: "swf-time" }, hhmmOf(m.time)),
          ),
          h(McpEmoticon, {
            api: api,
            md5: m.emoticon_md5,
            title: "表情 · " + m.time,
            onOpen: (p) => openLocalFile(api, p),
          }),
        ),
      );
    }

    const urlAt = bodyText.indexOf("http");
    const body =
      cls.tag === "聊天记录"
        ? h(
            "div",
            { className: "swf-recbox" },
            h(ChatRecord, {
              api: api,
              messageId: m.id,
              title: cls.text.replace(/^\[聊天记录\]\s*/, ""),
            }),
          )
        : urlAt >= 0
          ? h(
              "div",
              { className: "swf-text" },
              bodyText.slice(0, urlAt),
              h("span", { className: "swf-link" }, bodyText.slice(urlAt)),
            )
          : h("div", { className: "swf-text" }, bodyText);

    return h(
      "div",
      {
        className: "swf-msg" + (cont ? " swf-msg-cont" : "") + (hlId === String(m.id) ? " swf-hl" : ""),
        key: key,
        "data-mid": m.id,
        title: cont ? sender + " · " + hhmmOf(m.time) : undefined,
      },
      avatarNode(sender, cont, av),
      h(
        "div",
        { className: "swf-main" },
        h(
          "div",
          { className: "swf-head" },
          h("span", { className: "swf-sender", style: { color: speakerColor(sender) } }, sender),
          cls.tag !== "文本" ? h("span", { className: "swf-tag" }, cls.tag) : null,
          h("span", { className: "swf-time" }, hhmmOf(m.time)),
        ),
        q
          ? h(
              "div",
              {
                className: "swf-quote swf-quote-click",
                title: "点击定位原消息（在当前已加载范围内匹配「作者 + 内容」）",
                onClick: () => {
                  const pq = parseQuote(q.quote);
                  if (!jumpToQuote(pq.author, pq.text, m.time)) {
                    setDebug("原消息不在当前已加载范围内：可点「加载更早」扩大范围，或用关键词搜索定位。");
                  }
                },
              },
              q.quote,
            )
          : null,
        body,
      ),
    );
  };

  const renderFeed = () => {
    if (visible.length === 0) {
      return h(
        "div",
        null,
        h("div", { className: "swf-empty" }, loading ? t.busy : t.noMsgs),
      );
    }
    return h(
      "div",
      null,
      h(
        "div",
        { className: "swf-morebar" },
        h(
          "button",
          {
            className: "swf-btn swf-btn-sm",
            disabled: loadingNewer || loading,
            onClick: loadNewer,
            title: "用 get_messages_since 增量拉取当前最后一条之后的新消息（只并入当前时间窗内的消息）",
          },
          loadingNewer ? t.busy : t.refreshNew,
        ),
        hasMore
          ? h("button", { className: "swf-btn swf-btn-sm", disabled: loadingOlder, onClick: loadOlder }, loadingOlder ? t.earlierBusy : t.earlier)
          : h("span", { className: "swf-morehint" }, keyword.trim() ? "搜索不翻页：细化关键词以缩小结果" : t.earliest),
      ),
      groups.map(([day, list]) => {
        const rows = [];
        let prev = null;
        for (const m of list) {
          const cont = !!(prev && prev.sender_name === m.sender_name && classify(prev.content).tag !== "系统" && sameBurst(prev.time, m.time));
          rows.push(renderMsg(m, cont));
          prev = m;
        }
        return h("div", { key: day }, h("div", { className: "swf-day" }, day + "  ·  " + list.length), rows);
      }),
    );
  };

  /* ---- 渲染：总结 ---- */
  const renderDigest = () => {
    const hourly = (stats && stats.hourly_distribution) || null;
    const hourlyUnique = (stats && stats.hourly_unique_senders) || null;
    const uniqueSenders = stats ? Number(stats.unique_senders || 0) : 0;
    // 注：MCP 的 top_senders 只用于预取头像；发言榜统一由下方「成员榜」渲染，避免同一批人画两遍
    const bucketMap = (stats && stats.sender_buckets) || null;
    const heatCells = (stats && stats.weekday_hourly) || [];
    // 当前条件（群 + 范围）与「上一次统计实际使用的条件」不一致 → 画面上的数字属于旧条件
    const statsStale = !!(
      stats &&
      !loading &&
      (statsScope !== sessionId || statsRange.start !== rangeStart || statsRange.end !== rangeEnd)
    );
    const typeRows = (stats && Array.isArray(stats.type_distribution)) ? stats.type_distribution : null;

    // 趋势粒度由报告类型决定（日=小时，周/月=天，年=月），见上方 trend
    const peakPoint = trend.points.reduce((a, p) => (p.value > a.value ? p : a), { value: 0, key: "" });
    // 滚动 24 小时的点 key 是「YYYY-MM-DD HH」，卡片上只显示「HH:00」
    const peakLabel =
      forceHourly && trend.kind === "hour" && String(peakPoint.key).length > 10
        ? String(peakPoint.key).slice(11)
        : peakPoint.key;

    const perCapita = uniqueSenders ? Math.round((Number(stats.total_messages) || 0) / uniqueSenders) : 0;

    // 类型分布：MCP 全量 type_distribution（[{local_type,label,count}]）→ 按 label 合并
    const typeEntries = typeRows ? mergeTypeRows(typeRows) : [];
    const maxType = typeEntries.reduce((a, x) => Math.max(a, x[1]), 1);

    // 参与度分桶（发 1 条 / 2-9 / 10-49 / 50+ 的人数）
    const bucketOrder = ["1", "2-9", "10-49", "50+"];
    const bucketTotal = bucketMap ? bucketOrder.reduce((a, k) => a + (Number(bucketMap[k]) || 0), 0) : 0;
    const bucketLabel = (k) => (k === "1" ? "只发 1 条" : k === "50+" ? "50+ 条" : k + " 条");

    // 24×7 热力（weekday: 0=周日）：数据与配色由 heatGrid / heatColor 统一提供，长图共用
    const heat = heatGrid(stats);
    const maxHeat = heat.max;
    const weekdays = heat.rows.map((r) => r.label);

    return h(
      "div",
      null,
      h(
        "div",
        { className: "swf-mini-seg swf-period" },
        // 「自定义」不是一种报告类型，而是「手填范围」的状态：改日期/时刻时自动进入，
        // 所以这里只给自然周期（日/周/月/年）提供入口。
        [["day", "日报"], ["week", "周报"], ["month", "月报"], ["year", "年报"]].map(([key, label]) =>
          h(
            "button",
            { key: key, className: "swf-mini-btn" + (reportPeriod === key ? " active" : ""), onClick: () => applyPeriod(key) },
            label,
          ),
        ),
        reportPeriod === "custom"
          ? h("span", { className: "swf-note" }, forceHourly ? "滚动 24 小时（自动计算）" : "自定义范围（上方手填）")
          : null,
      ),
      // 输入范围改了但还没重新统计：明确告知画面上的数字属于旧范围
      statsStale
        ? h(
            "div",
            { className: "swf-stale" },
            statsScope !== sessionId
              ? "群聊已切换：画面仍是上一次统计的结果"
              : "时间范围已变更：当前显示 " + statsRange.start + " ~ " + statsRange.end + " 的统计",
            h("button", { className: "swf-mini-btn", onClick: () => loadStats() }, "按新范围刷新"),
          )
        : null,
      stats
        ? h(
            "div",
            { className: "swf-cards" },
            h("div", { className: "swf-card swf-card-accent" }, h("div", { className: "swf-card-k" }, t.total), h("div", { className: "swf-card-v" }, fmtNum(stats.total_messages || 0))),
            h("div", { className: "swf-card" }, h("div", { className: "swf-card-k" }, "发言人数"), h("div", { className: "swf-card-v" }, fmtNum(uniqueSenders))),
            h("div", { className: "swf-card" }, h("div", { className: "swf-card-k" }, "人均消息"), h("div", { className: "swf-card-v" }, String(perCapita))),
            h(
              "div",
              {
                className: "swf-card swf-card-accent",
                title:
                  "峰值：" + peakPoint.key + (trend.kind === "hour" ? ":00" : "") +
                  " · " + fmtNum(peakPoint.value) + " 条 —— 来自 MCP 全量按" +
                  (trend.kind === "hour" ? "小时" : trend.kind === "month" ? "月" : "天") +
                  "聚合，与下方趋势图同源",
              },
              h(
                "div",
                { className: "swf-card-k" },
                (trend.kind === "hour" ? t.peak + (hourMetric === "senders" ? " · 活跃" : "") : "峰值") +
                  (peakPoint.value ? " · " + fmtNum(peakPoint.value) : ""),
              ),
              h("div", { className: "swf-card-v" }, peakPoint.value ? peakLabel + (trend.kind === "hour" ? ":00" : "") : "—"),
            ),
          )
        : quick
          ? h(
              "div",
              null,
              h(
                "div",
                { className: "swf-card-sub" },
                t.quick +
                  " · " +
                  fmtNum((quick.session && quick.session.message_count) || 0) +
                  " 条累计" +
                  (quick.session && quick.session.unread ? " · " + fmtNum(quick.session.unread) + t.unread : "") +
                  (quick.session && quick.session.last_time ? " · 最近活跃 " + quick.session.last_time : "") +
                  (quick.time_range ? " · 范围 " + quick.time_range.start + " ~ " + quick.time_range.end : ""),
              ),
              h(
                "div",
                { className: "swf-cards" },
                h("div", { className: "swf-card swf-card-accent" }, h("div", { className: "swf-card-k" }, t.total), h("div", { className: "swf-card-v" }, fmtNum(quick.total_messages || 0))),
                h("div", { className: "swf-card" }, h("div", { className: "swf-card-k" }, "发言人数"), h("div", { className: "swf-card-v" }, fmtNum(quick.unique_senders || 0))),
                h(
                  "div",
                  { className: "swf-card" },
                  h("div", { className: "swf-card-k" }, t.peak),
                  h("div", { className: "swf-card-v" }, quick.peak_hour ? String(quick.peak_hour.hour) + ":00" : "—"),
                ),
                h(
                  "div",
                  { className: "swf-card" },
                  h("div", { className: "swf-card-k" }, "类型 Top"),
                  h("div", { className: "swf-card-v" }, quick.type_distribution && quick.type_distribution[0] ? quick.type_distribution[0].label : "—"),
                ),
              ),
              h("div", { className: "swf-card-sub" }, t.quickHint),
            )
          : h(
              "div",
              { className: "swf-empty" },
              loading || quickBusy
                ? t.busy
                : !sessionId
                  ? "先在上方选择一个群聊，再点「生成统计」。"
                  : statsRange.start
                    ? "统计已清空：点「生成统计」加载当前群与范围的数据。"
                    : "点「生成统计」加载该群在当前时间范围内的统计。",
            ),

      // 扩展指标：活跃率 / 集中度 / 会话片段 / 撤回（全部来自 MCP 全量聚合）
      stats && (stats.concentration || stats.silent_members || stats.sessionization || stats.system_events)
        ? h(
            "div",
            { className: "swf-cards" },
            stats.silent_members
              ? h(
                  "div",
                  { className: "swf-card", title: "群成员中在范围内发过言的比例" },
                  h("div", { className: "swf-card-k" }, "活跃率"),
                  h("div", { className: "swf-card-v" }, fmtPct(stats.silent_members.active_rate)),
                  h(
                    "div",
                    { className: "swf-card-sub" },
                    fmtNum(stats.silent_members.active_members) + " / " + fmtNum(stats.silent_members.member_total) + " 人",
                  ),
                )
              : null,
            stats.concentration
              ? h(
                  "div",
                  { className: "swf-card", title: "基尼系数：0 = 完全平均，越接近 1 越集中在少数人" },
                  h("div", { className: "swf-card-k" }, "集中度 Gini"),
                  h("div", { className: "swf-card-v" }, (Number(stats.concentration.gini) || 0).toFixed(2)),
                )
              : null,
            stats.sessionization
              ? h(
                  "div",
                  { className: "swf-card", title: "按静默间隔切分出的讨论片段数" },
                  h("div", { className: "swf-card-k" }, "会话片段"),
                  h("div", { className: "swf-card-v" }, fmtNum(stats.sessionization.segment_count || 0) + " 段"),
                  h(
                    "div",
                    { className: "swf-card-sub" },
                    "最长静默 " + Math.round((stats.sessionization.longest_silence_seconds || 0) / 60) + " 分 · 中位 " +
                      fmtNum(stats.sessionization.median_gap_seconds || 0) + " 秒",
                  ),
                )
              : null,
            h(
              "div",
              { className: "swf-card", title: "撤回类系统消息数量（发送者通常是系统/群账号）" },
              h("div", { className: "swf-card-k" }, "撤回"),
              h("div", { className: "swf-card-v" }, fmtNum((stats.system_events && stats.system_events.recall_like_count) || 0)),
            ),
          )
        : null,

      trend.points.length
        ? h(
            "div",
            null,
            h("div", { className: "swf-section" }, trend.title + " · " + periodLabel),
            trend.kind === "hour"
              ? h(
                  "div",
                  { className: "swf-mini-seg" },
                  h("button", { className: "swf-mini-btn" + (hourMetric === "messages" ? " active" : ""), onClick: () => setHourMetric("messages") }, "消息数"),
                  h("button", { className: "swf-mini-btn" + (hourMetric === "senders" ? " active" : ""), onClick: () => setHourMetric("senders") }, "活跃人数"),
                )
              : null,
            h(
              "div",
              { className: "swf-hours" },
              trend.points.map((p) =>
                h(
                  "div",
                  { className: "swf-hour", key: "trend-" + p.key, title: p.key + " — " + p.value },
                  h("div", { className: "swf-hour-bar", style: { height: (p.value / trend.maxValue) * 100 + "%" } }),
                  p.label ? h("div", { className: "swf-hour-k" }, p.label) : null,
                ),
              ),
            ),
          )
        : null,

      // 活跃发言者与成员榜是同一批人：统一到下方「成员榜」（维度切换 + 点击画像），不再重复渲染

      bucketMap && bucketTotal
        ? h(
            "div",
            null,
            h("div", { className: "swf-section" }, "参与度分布 · " + fmtNum(bucketTotal) + " 人参与"),
            bucketOrder.map((k) =>
              h(
                "div",
                { className: "swf-bar-row", key: "bucket-" + k },
                h("div", { className: "swf-bar-label" }, bucketLabel(k)),
                h(
                  "div",
                  { className: "swf-bar-track" },
                  h("div", { className: "swf-bar-fill", style: { width: ((Number(bucketMap[k]) || 0) / bucketTotal) * 100 + "%", background: ACCENT } }),
                ),
                h("div", { className: "swf-bar-num" }, String(Number(bucketMap[k]) || 0)),
              ),
            ),
          )
        : null,

      typeEntries.length
        ? h(
            "div",
            null,
            h("div", { className: "swf-section" }, t.types + (typeRows ? " · 范围内全量" : " · 样本")),
            typeEntries.map(([k, v]) =>
              h(
                "div",
                { className: "swf-bar-row", key: "type-" + k },
                h("div", { className: "swf-bar-label" }, k),
                h(
                  "div",
                  { className: "swf-bar-track" },
                  h("div", { className: "swf-bar-fill", style: { width: (v / maxType) * 100 + "%", background: ACCENT } }),
                ),
                h("div", { className: "swf-bar-num" }, String(v)),
              ),
            ),
          )
        : null,

      // 当天范围下热力图与上方「24 小时分布」是同一份数据（只有一行），不再重复画
      heat.hasData && trend.kind !== "hour"
        ? h(
            "div",
            null,
            h("div", { className: "swf-section" }, "活跃热力 · 星期 × 小时"),
            h(
              "div",
              { className: "swf-heat" },
              weekdays.map((w, wi) =>
                h(
                  "div",
                  { className: "swf-heat-row", key: "heat-w" + wi },
                  h("span", { className: "swf-heat-k" }, w),
                  heat.rows[wi].cells.map((c) =>
                    h("span", {
                      key: "heat-c" + c.hour,
                      className: "swf-heat-cell",
                      title: "周" + w + " " + c.hour + ":00 — " + c.count,
                      style: { background: heatColor(c.count, maxHeat) },
                    }),
                  ),
                ),
              ),
            ),
          )
        : null,

      // 成员榜：MCP 已返回全量多维聚合，这里只做维度切换与排序（不重复取数）
      stats && Array.isArray(stats.member_rank) && stats.member_rank.length
        ? (() => {
            const metrics = [
              ["messages", "发言"],
              ["chars", "字数"],
              ["images", "图片"],
              ["emojis", "表情"],
              ["quotes_given", "引用"],
              ["quoted", "被引用"],
              ["bursts", "连发"],
              ["night", "深夜"],
              ["early", "早起"],
            ];
            const rows = stats.member_rank
              .filter((m) => (m.u || m.username || "") !== sessionId)
              .slice()
              .sort((a, b) => (Number(b[rankMetric]) || 0) - (Number(a[rankMetric]) || 0))
              .slice(0, 10);
            const maxV = rows.reduce((a, x) => Math.max(a, Number(x[rankMetric]) || 0), 1);
            return h(
              "div",
              null,
              h("div", { className: "swf-section" }, "成员榜 · 切换维度，点头像看发言分析"),
              h(
                "div",
                { className: "swf-mini-seg swf-mini-wrap" },
                metrics.map(([key, label]) =>
                  h(
                    "button",
                    {
                      key: key,
                      className: "swf-mini-btn" + (rankMetric === key ? " active" : ""),
                      onClick: () => setRankMetric(key),
                    },
                    label,
                  ),
                ),
              ),
              rows.map((m, i) => {
                const uname = m.u || m.username || "";
                const name = m.name || uname;
                const av = (uname && avatars[uname]) || "";
                return h(
                  "div",
                  {
                    className:
                      "swf-bar-row swf-rank-row" +
                      (memberProfile && memberProfile.member && memberProfile.member.username === uname
                        ? " swf-rank-row-on"
                        : ""),
                    key: "rank-" + (uname || name),
                    title:
                      "点击查看 " + name + (uname && uname !== name ? "（" + uname + "）" : "") +
                      " 的成员画像（再次点击收起）",
                    onClick: () => {
                      // 同一成员再点一次 = 收起；换人 = 重新拉取（load 内部会先作废上一位的流）
                      if (memberProfile && memberProfile.member && memberProfile.member.username === uname) {
                        closeMemberProfile();
                      } else if (!memberBusy) {
                        loadMemberProfile(uname);
                      }
                    },
                  },
                  h(
                    "div",
                    { className: "swf-bar-label" },
                    i < 3 ? h("span", { className: "swf-rank-medal" }, ["🥇", "🥈", "🥉"][i]) : null,
                    av
                      ? h("img", { className: "swf-bar-av", src: av, alt: "" })
                      : h("span", { className: "swf-bar-av", style: { background: speakerColor(name) } }, avatarChar(name)),
                    h("span", { className: "swf-bar-name" }, name),
                  ),
                  h(
                    "div",
                    { className: "swf-bar-track" },
                    h("div", {
                      className: "swf-bar-fill",
                      style: {
                        width: ((Number(m[rankMetric]) || 0) / maxV) * 100 + "%",
                        background: speakerColor(name),
                      },
                    }),
                  ),
                  h("div", { className: "swf-bar-num" }, fmtNum(Number(m[rankMetric]) || 0)),
                );
              }),
            );
          })()
        : null,

      // 成员检索：Top10 榜之外的成员（冷门 / 潜水）也能按名字或 wxid 找到并打开画像
      sessionId
        ? h(
            "div",
            null,
            h("div", { className: "swf-section" }, "查找成员 · 按昵称 / 备注 / wxid（含未上榜成员）"),
            h(
              "div",
              { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", margin: "2px 4px 6px" } },
              h("input", {
                className: "swf-input",
                type: "text",
                placeholder: "昵称或 wxid 片段；留空列出前 30 位",
                value: memberQuery,
                onChange: (e) => setMemberQuery(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter") searchMembers();
                },
              }),
              h(
                "button",
                { className: "swf-btn swf-btn-primary", disabled: memberSearchBusy, onClick: searchMembers },
                memberSearchBusy ? "查找中…" : "查找",
              ),
              memberQuery || memberHits
                ? h(
                    "button",
                    {
                      className: "swf-btn",
                      onClick: clearMemberSearch,
                      title: "清空输入与搜索结果（成员画像用下方「收起」单独关闭）",
                    },
                    "清空",
                  )
                : null,
              h(
                "label",
                { className: "swf-toggle", title: "冷门成员在「今天」往往只有几条消息，改用全部历史更有分析价值" },
                h("input", {
                  type: "checkbox",
                  checked: memberAllTime,
                  onChange: (e) => {
                    const next = e.target.checked;
                    setMemberAllTime(next);
                    // 已打开画像时立刻按新口径重取，避免画面与开关不一致
                    const u = memberProfile && memberProfile.member && memberProfile.member.username;
                    if (u) loadMemberProfile(u, next);
                  },
                }),
                "不限时间范围",
              ),
            ),
            memberHits && memberHits.error ? h("div", { className: "swf-error" }, memberHits.error) : null,
            memberHits && !memberHits.error
              ? h(
                  "div",
                  { className: "swf-note", style: { margin: "0 4px 4px" } },
                  "群成员 " + fmtNum(memberHits.member_count || 0) + " 人 · 匹配 " + fmtNum(memberHits.returned || 0) +
                  " 条 · 已显示 " + fmtNum(Math.min(memberVisible, memberHits.returned || 0)) + " 条（点击打开画像）",
                )
              : null,
            memberHits && !memberHits.error
              ? (memberHits.members || []).slice(0, memberVisible).map((m) => {
                  const nm = m.display_name || m.username;
                  return h(
                    "div",
                    {
                      className:
                        "swf-bar-row swf-rank-row" +
                        (memberProfile && memberProfile.member && memberProfile.member.username === m.username
                          ? " swf-rank-row-on"
                          : ""),
                      key: "hit-" + m.username,
                      title: "点击查看 " + nm + "（" + m.username + "）的成员画像",
                      onClick: () => {
                        if (!memberBusy) loadMemberProfile(m.username);
                      },
                    },
                    h(
                      "div",
                      { className: "swf-bar-label" },
                      avatars[m.username]
                        ? h("img", { className: "swf-bar-av", src: avatars[m.username], alt: "" })
                        : h("span", { className: "swf-bar-av", style: { background: speakerColor(nm) } }, avatarChar(nm)),
                      h("span", { className: "swf-bar-name" }, nm + (m.alias ? "（" + m.alias + "）" : "")),
                    ),
                    h(
                      "div",
                      { className: "swf-bar-num", style: { width: "auto", maxWidth: "46%", overflow: "hidden", textOverflow: "ellipsis" } },
                      m.username,
                    ),
                   );
                 })
               : null,
            memberHits && !memberHits.error && (memberHits.members || []).length > memberVisible
              ? h(
                  "button",
                  {
                    className: "swf-btn",
                    style: { margin: "6px 4px 2px" },
                    onClick: () => setMemberVisible((v) => v + MEMBER_PAGE_SIZE),
                  },
                  "加载更多（已显示 " + fmtNum(memberVisible) + " / " + fmtNum((memberHits.members || []).length) + "）",
                )
              : null,
           )
         : null,

      // 成员画像：点击成员榜后按需调用 get_member_profile
      memberBusy ? h("div", { className: "swf-note" }, "读取成员画像…") : null,
      memberProfile && memberProfile.error ? h("div", { className: "swf-error" }, memberProfile.error) : null,
      memberProfile && !memberProfile.error
        ? h(
            "div",
            null,
            h(
              "div",
              { className: "swf-section swf-section-head" },
              "成员画像 · " + ((memberProfile.member && memberProfile.member.display_name) || ""),
              h(
                "button",
                { className: "swf-mini-btn", onClick: closeMemberProfile, title: "收起成员画像" },
                "收起",
              ),
            ),
            h(
              "div",
              { className: "swf-note", style: { margin: "0 4px 6px" } },
              "统计事实（MCP 全量聚合）：消息 / 字数 / 活跃天数 / 占比与节奏；语义与角色定位见下方「AI 角色分析」。",
            ),
            h(
              "div",
              { className: "swf-cards" },
              h("div", { className: "swf-card" }, h("div", { className: "swf-card-k" }, "消息"), h("div", { className: "swf-card-v" }, fmtNum(memberProfile.summary.messages))),
              h("div", { className: "swf-card" }, h("div", { className: "swf-card-k" }, "字数"), h("div", { className: "swf-card-v" }, fmtNum(memberProfile.summary.chars))),
              h("div", { className: "swf-card" }, h("div", { className: "swf-card-k" }, "活跃天数"), h("div", { className: "swf-card-v" }, String(memberProfile.summary.active_days || 0))),
              h("div", { className: "swf-card" }, h("div", { className: "swf-card-k" }, "范围内占比"), h("div", { className: "swf-card-v" }, fmtPct(memberProfile.summary.share_of_scope))),
            ),
            // 消息构成 + 引用榜：统一用横条（口径写清，避免「连发」被误读成消息数占比）
            (() => {
              const total = Number(memberProfile.summary.messages) || 0;
              const mix = [
                { name: "早起 6–8 时", count: memberProfile.rhythm.early_messages },
                { name: "表情", count: memberProfile.media.emojis },
                { name: "深夜 0–5 时", count: memberProfile.rhythm.night_messages },
                { name: "引用消息", count: memberProfile.media.quotes_given },
                { name: "图片", count: memberProfile.media.images },
              ]
                .filter((x) => Number(x.count) > 0)
                .sort((a, b) => Number(b.count) - Number(a.count))
                .map((x) => ({
                  name: x.name,
                  count: x.count,
                  suffix: total ? " · " + fmtPct(Number(x.count) / total) : "",
                }));
              return mix.length
                ? h(
                    "div",
                    null,
                    h("div", { className: "swf-sub" }, "消息构成 · 分母 " + fmtNum(total) + " 条（同一条可计入多个维度）"),
                    bars(mix, { key: "mix", wideNum: true }),
                  )
                : null;
            })(),
            memberProfile.rhythm.bursts
              ? h(
                  "div",
                  { className: "swf-note" },
                  "连发 " + memberProfile.rhythm.bursts + " 次（与本人上一条消息间隔 ≤ 60 秒的次数，不计入上方占比）",
                )
              : null,
            (memberProfile.top_quoted || []).length
              ? h(
                  "div",
                  null,
                  h("div", { className: "swf-sub" }, "常引用榜 · 我引用谁"),
                  bars((memberProfile.top_quoted || []).slice(0, 6), { key: "mq" }),
                )
              : null,
            (memberProfile.quoted_by || []).length
              ? h(
                  "div",
                  null,
                  h("div", { className: "swf-sub" }, "被引用榜 · 谁引用我"),
                  bars((memberProfile.quoted_by || []).slice(0, 6), { key: "qb" }),
                )
              : null,

            // 角色维度 AI 分析：让 Agent 读该成员的近期发言，产出人物素描 / 关注点 / 风格 / 互动 / 金句
            h(
              "div",
              { className: "swf-section" },
              "AI 角色分析",
              memberAiStatus === "streaming" ? h("span", { className: "swf-badge" }, "生成中…") : null,
              memberAiStatus === "done" ? h("span", { className: "swf-badge" }, "已完成") : null,
            ),
            h(
              "div",
              { className: "swf-actions" },
              h(
                "button",
                {
                  className: "swf-btn swf-btn-primary",
                  disabled: memberAiBusy || memberAiStatus === "streaming" || aiBusy || aiStatus === "streaming",
                  onClick: runMemberAi,
                },
                memberAiBusy || memberAiStatus === "streaming" ? t.busy : memberAiText ? "重新分析该成员" : "分析该成员",
              ),
              memberAiConvId ? h("button", { className: "swf-btn", onClick: openMemberSession }, t.open) : null,
            memberAiText ? h("button", { className: "swf-btn", onClick: copyMemberAi }, "复制正文") : null,
            memberMd ? h("button", { className: "swf-btn", onClick: saveMemberMd }, "导出 MD") : null,
            memberProfile && !memberProfile.error
              ? h("button", { className: "swf-btn", onClick: saveMemberHtml }, "保存 HTML 长图")
              : null,
          ),
          memberAiBusy ? h("div", { className: "swf-note" }, "Agent 正在读该成员的近期发言…") : null,
          memberAiMsg ? h("div", { className: "swf-note" }, memberAiMsg) : null,
          memberMsg ? h("div", { className: "swf-note" }, memberMsg) : null,
            memberAiData && memberAiData.persona
              ? h("div", { className: "swf-note" }, "人物素描：" + String(memberAiData.persona))
              : null,
            memberAiData && Array.isArray(memberAiData.topics) && memberAiData.topics.length
              ? (() => {
                  const maxW = memberAiData.topics.reduce((a, x) => Math.max(a, Number(x && x.weight) || 0), 1);
                  return h(
                    "div",
                    null,
                    h("div", { className: "swf-sub" }, "关注点"),
                    memberAiData.topics.map((x, i) =>
                      h(
                        "div",
                        { className: "swf-bar-row", key: "mtopic-" + i },
                        h("div", { className: "swf-bar-label", title: x.name }, h("span", { className: "swf-bar-name" }, x.name)),
                        h(
                          "div",
                          { className: "swf-bar-track" },
                          h("div", {
                            className: "swf-bar-fill",
                            style: { width: ((Number(x.weight) || 0) / maxW) * 100 + "%", background: ACCENT },
                          }),
                        ),
                        h("div", { className: "swf-bar-num" }, String(Number(x.weight) || 0)),
                      ),
                    ),
                  );
                })()
              : null,
            memberAiData && memberAiData.style
              ? h(
                  "div",
                  { className: "swf-words" },
                  memberAiData.style.tone
                    ? h("span", { className: "swf-word" }, "语气：" + String(memberAiData.style.tone))
                    : null,
                  (Array.isArray(memberAiData.style.habits) ? memberAiData.style.habits : [])
                    .slice(0, 6)
                    .map((x, i) => h("span", { className: "swf-word", key: "mhabit-" + i }, String(x))),
                )
              : null,
            memberAiData && Array.isArray(memberAiData.interactions) && memberAiData.interactions.length
              ? h(
                  "div",
                  null,
                  h("div", { className: "swf-sub" }, "互动对象"),
                  memberAiData.interactions.map((x, i) =>
                    h("div", { className: "swf-todo", key: "mint-" + i }, h("b", null, String(x.with || "?")), " · ", String(x.pattern || "")),
                  ),
                )
              : null,
            memberAiData && Array.isArray(memberAiData.quotes) && memberAiData.quotes.length
              ? h(
                  "div",
                  null,
                  h("div", { className: "swf-sub" }, "值得记住的发言"),
                  memberAiData.quotes.map((x, i) =>
                    h(
                      "div",
                      { className: "swf-todo", key: "mquote-" + i },
                      "「" + String(x.text || "") + "」",
                      x.why ? h("span", { className: "swf-note" }, "（" + String(x.why) + "）") : null,
                    ),
                  ),
                )
              : null,
            memberAiData && Array.isArray(memberAiData.advice) && memberAiData.advice.length
              ? h(
                  "div",
                  null,
                  h("div", { className: "swf-sub" }, "建议"),
                  memberAiData.advice.map((x, i) => h("div", { className: "swf-risk", key: "madv-" + i }, "→ ", String(x))),
                )
              : null,
            memberAiText
              ? h(
                  "div",
                  { className: "swf-ai-out swf-ai-md" },
                  mdToReact(String(memberAiText).replace(/```json[\s\S]*?```/i, "").trim()),
                )
              : null,
          )
        : null,
      // 互动网络：引用消息解析出的被引用榜与关系对（MCP 侧按显示名聚合）
      stats && stats.quote_network && (stats.quote_network.top_quoted || []).length
        ? (() => {
            const qn = stats.quote_network;
            return h(
              "div",
              null,
              h(
                "div",
                { className: "swf-section" },
                "互动网络 · 引用" + (qn.parse_rate ? " · 解析 " + fmtPct(qn.parse_rate) : ""),
              ),
              h("div", { className: "swf-sub" }, "被引用榜"),
              bars((qn.top_quoted || []).slice(0, 8), { key: "quoted" }),
              (qn.edges || []).length ? h("div", { className: "swf-sub" }, "引用关系 Top") : null,
              h(
                "div",
                { className: "swf-words" },
                (qn.edges || []).slice(0, 12).map((e, i) =>
                  h("span", { className: "swf-word", key: "edge-" + i }, e.from + " → " + e.to + " × " + e.count),
                ),
              ),
            );
          })()
        : null,


      // AI 分析设置：维度开关 / 数量上限 / 自定义补充指令（持久化；提示词按开关裁剪）
      h(
        "details",
        { className: "swf-adv" },
        h("summary", null, "分析设置"),
        h(
          "div",
          { className: "swf-words" },
          AI_DIMS.map(([key, label]) =>
            h(
              "button",
              {
                key: "aidim-" + key,
                className: "swf-chipbtn" + (aiSettings.dims[key] ? " swf-chipbtn-on" : ""),
                onClick: () => updateAiSettings({ dims: { [key]: !aiSettings.dims[key] } }),
                title: aiSettings.dims[key] ? "已启用（点击关闭）" : "已关闭（点击启用）",
              },
              label,
            ),
          ),
        ),
        h("div", { className: "swf-note" }, "关掉的维度不会写进提示词：Agent 不生成、报告也不出现（省 token）。"),
        // 深挖参数：段数决定「读多细」，验证强度决定「查多狠」
        h(
          "div",
          { className: "swf-adv-limits" },
          [
            ["segments", "深挖段数", [[0, "自动"], [2, "2 段"], [4, "4 段"], [6, "6 段"], [8, "8 段"]]],
            ["verify", "交叉验证", [[0, "关闭"], [1, "每视角一轮"]]],
          ].map(([key, label, opts]) =>
            h(
              "label",
              { className: "swf-note", key: "aideep-" + key },
              label,
              h(
                "select",
                {
                  className: "swf-input",
                  value: aiSettings.deep[key],
                  onChange: (e) => updateAiSettings({ deep: { [key]: e.target.value } }),
                },
                opts.map(([v, txt]) => h("option", { key: "dopt-" + key + "-" + v, value: v }, txt)),
              ),
            ),
          ),
        ),
        h(
          "div",
          { className: "swf-note" },
          "深挖段数「自动」= 日报 4 段（按小时）、周报按天、月报 8 段；消息量很小会自动减半。交叉验证开启后，每个视角都会被独立审查一轮（对账 + 查无据 + 找遗漏 + 找矛盾）。",
        ),
        h(
          "div",
          { className: "swf-adv-limits" },
          [["topics", "话题上限"], ["titles", "称号上限"], ["quotes", "金句上限"]].map(([key, label]) =>
            h(
              "label",
              { className: "swf-note", key: "ailim-" + key },
              label,
              h("input", {
                className: "swf-input swf-num",
                type: "number",
                min: 1,
                max: 50,
                value: aiSettings.limits[key],
                onChange: (e) => updateAiSettings({ limits: { [key]: e.target.value } }),
              }),
            ),
          ),
        ),
        h("textarea", {
          className: "swf-textarea",
          rows: 3,
          placeholder: "自定义补充指令（例如：重点关注技术方案与待办，用简洁中文）",
          value: aiSettings.extra,
          onChange: (e) => updateAiSettings({ extra: e.target.value }),
        }),
      ),

      // AI 分析：档位选择 → 一个按钮 → 一个结果区（档位决定按钮跑哪条管线，结果按档位优先展示）
      h(
        "div",
        { className: "swf-section" },
        "AI 分析",
        aiStatus === "streaming" || deepBusy ? h("span", { className: "swf-badge" }, "生成中…") : null,
        !deepBusy && !(aiStatus === "streaming") && shownAiText ? h("span", { className: "swf-badge" }, "已完成") : null,
      ),
      h(
        "div",
        { className: "swf-words" },
        [["standard", "单会话"], ["deep", "深挖"]].map(([key, label]) =>
          h(
            "button",
            {
              key: "deepmode-" + key,
              className: "swf-chipbtn" + (deepMode === key ? " swf-chipbtn-on" : ""),
              onClick: () => setDeepMode(key),
              title: key === "deep" ? "四阶段：分段读事实 → 多视角挖掘 → 交叉验证 → 汇总成稿" : "一轮写完（现有深度分析）",
            },
            label + (deepPlan.recommend === key ? " · 推荐" : ""),
          ),
        ),
      ),
      h(
        "div",
        { className: "swf-note" },
        "当前范围 " +
          (deepPlan.hours >= 24 ? Math.round(deepPlan.hours / 24) + " 天" : deepPlan.hours ? deepPlan.hours.toFixed(1) + " 小时" : "未知") +
          (deepPlan.msgs ? " · " + deepPlan.msgs + " 条消息" : "（未加载统计，成本为估算）") +
          "；推荐「" +
          (deepPlan.recommend === "deep" ? "深挖" : "单会话") +
          "」——" +
          (deepPlan.recommend === "deep" ? "跨天总结或多消息量，值得多角度挖并交叉验证" : "时段较短，一轮就能看明白，深挖是浪费"),
      ),
      deepMode === "deep"
        ? h(
            "div",
            { className: "swf-note" },
            "深挖成本：" +
              deepPlan.stages +
              " 个阶段串行 · 阶段内并行派约 " +
              deepPlan.subAgents +
              " 个子代理（" +
              deepPlan.segs +
              " 段 + " +
              deepPlan.lenses +
              " 视角" +
              (deepPlan.verifyK > 0 ? "，每个视角各挖一次、各验一次" : "") +
              "）· 每个阶段独立超时 15 分钟",
          )
        : null,
      deepSteps.length
        ? h(
            "div",
            { className: "swf-deep" },
            deepSteps.map((s, i) =>
              h(
                "div",
                { className: "swf-deep-step", key: "dstep-" + s.id },
                h(
                  "div",
                  { className: "swf-deep-head" },
                  h("span", { className: "swf-deep-idx" }, i + 1 + "/" + deepSteps.length),
                  h("span", { className: "swf-deep-label" }, s.label),
                  h("span", { className: "swf-deep-detail" }, s.detail),
                  h(
                    "span",
                    { className: "swf-badge" },
                    s.status === "running"
                      ? "进行中"
                      : s.status === "done"
                        ? "完成"
                        : s.status === "partial"
                          ? "超时收口"
                          : s.status === "failed"
                            ? "失败"
                            : s.status === "cancelled"
                              ? "已中止"
                              : "等待",
                  ),
                  s.chars ? h("span", { className: "swf-deep-chars" }, s.chars + " 字") : null,
                ),
                s.marks && s.marks.length
                  ? h(
                      "div",
                      { className: "swf-deep-marks" },
                      s.marks.slice(-6).map((m, k) => h("div", { className: "swf-note", key: "dmk-" + k }, "· " + m)),
                    )
                  : null,
                s.convId
                  ? h(
                      "button",
                      { className: "swf-mini-btn", onClick: () => setDeepOpenStep(deepOpenStep === s.id ? "" : s.id) },
                      deepOpenStep === s.id ? "收起该阶段原文" : "展开该阶段原文",
                    )
                  : null,
                deepOpenStep === s.id && s.text ? h("div", { className: "swf-ai-out swf-ai-md" }, mdToReact(s.text)) : null,
              ),
            ),
          )
        : null,
      // 结果：图表 + 正文（单轮与深挖共用同一渲染，展示哪个由档位决定）
      ...(aiChartNodes(shownAiData) || []),
      shownAiText ? h("div", { className: "swf-ai-out swf-ai-md" }, mdToReact(shownAiText)) : null,
      // 唯一的操作按钮：档位决定它跑哪条管线
      h(
        "div",
        { className: "swf-actions" },
        deepMode === "deep"
          ? h(
              "button",
              {
                className: "swf-btn swf-btn-primary",
                disabled: deepBusy || aiBusy || aiStatus === "streaming" || !sessionId,
                onClick: runDeep,
              },
              deepBusy ? "深挖中…" : deepText ? "重新深挖" : "开始深挖",
            )
          : h(
              "button",
              {
                className: "swf-btn swf-btn-primary",
                disabled: aiBusy || aiStatus === "streaming" || deepBusy || !sessionId,
                onClick: runAi,
              },
              aiBusy || aiStatus === "streaming" ? t.busy : aiText ? "重新分析" : "单会话分析",
            ),
        deepBusy ? h("button", { className: "swf-btn", onClick: stopDeep }, "中止深挖") : null,
        (deepMode === "deep" ? deepLastConvId : aiConvId)
          ? h(
              "button",
              { className: "swf-btn", onClick: () => openSession(deepMode === "deep" ? deepLastConvId : aiConvId) },
              t.open,
            )
          : null,
      ),
      deepMsg ? h("div", { className: "swf-note" }, deepMsg) : null,
      saveMsg ? h("div", { className: "swf-note" }, saveMsg) : null,

      // （结果与操作按钮已并入上方「AI 分析」区块：档位决定跑哪条管线，结果按档位优先展示）

      // 完整报告：当前报告类型下的全部维度拼成 Markdown（与上方统计共用同一份 stats）
      h("div", { className: "swf-section" }, "完整报告 · " + periodLabel),
      h(
        "div",
        { className: "swf-note", style: { margin: "0 4px 6px" } },
        "点击章节开关：决定该章节是否写入 Markdown 报告。AI 章节：" +
          (shownAiText
            ? "已并入（" + String(shownAiText).length + " 字" + (deepText && shownAiText === deepText ? "，来自深挖" : "") + "）"
            : aiStatus === "streaming" || deepBusy
              ? "生成中…（Agent 写完后自动并入）"
              : "尚未生成 —— 点上方「AI 分析」里的按钮，写完后会自动并入报告"),
      ),
      h(
        "div",
        { className: "swf-words" },
        [
          ["overview", "概览"],
          ["trend", "趋势"],
          ["members", "成员榜"],
          ["network", "互动网络"],
          ["types", "类型分布"],
          ["quotes", "金句候选"],
          ["ai", "AI 分析"],
        ].map(([key, label]) =>
          h(
            "button",
            {
              key: key,
              className: "swf-chipbtn" + (reportSections[key] ? " swf-chipbtn-on" : ""),
              onClick: () => toggleSection(key),
              title: reportSections[key] ? "已包含，点击从报告中移除" : "已排除，点击加入报告",
            },
            label,
          ),
        ),
      ),
      h(
        "details",
        { className: "swf-note" },
        h("summary", null, "Markdown 预览"),
        reportMd
          ? h("div", { className: "swf-ai-out swf-ai-md" }, mdToReact(reportMd))
          : h("div", { className: "swf-ai-out swf-ai-md" }, "先点上方「统计」加载当前范围的数据。"),
      ),
      h(
        "div",
        { className: "swf-actions" },
        h("button", { className: "swf-btn", disabled: !reportMd, onClick: copyReport }, "复制 Markdown"),
        h("button", { className: "swf-btn", disabled: !reportMd, onClick: saveReport }, "保存为 MD"),
        h("button", { className: "swf-btn", disabled: !stats, onClick: saveReportHtml }, "保存为 HTML 长图"),
      ),
      // 定时日报：交给宿主定时任务（AI Loop），带幂等补发检查
      h(
        "details",
        { className: "swf-adv" },
        h("summary", null, "定时日报"),
        h(
          "div",
          { className: "swf-adv-limits" },
          h(
            "label",
            { className: "swf-note" },
            "每天 ",
            h("input", {
              className: "swf-input swf-num",
              type: "number",
              min: 0,
              max: 23,
              value: cron.hour,
              onChange: (e) => setCron((prev) => ({ ...prev, hour: Math.max(0, Math.min(23, Number(e.target.value) || 0)) })),
            }),
            " : ",
            h("input", {
              className: "swf-input swf-num",
              type: "number",
              min: 0,
              max: 59,
              value: cron.minute,
              onChange: (e) => setCron((prev) => ({ ...prev, minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })),
            }),
          ),
          h(
            "label",
            { className: "swf-toggle" },
            h("input", {
              type: "checkbox",
              checked: cron.catchup,
              onChange: (e) => setCron((prev) => ({ ...prev, catchup: e.target.checked })),
            }),
            "补发检查（每 3 小时）",
          ),
        ),
        h(
          "div",
          { className: "swf-note" },
          "定时任务由宿主的 AI Loop 执行；App 关闭期间会跳过，所以默认附带幂等补发检查（今天已生成则跳过）。",
        ),
        h(
          "div",
          { className: "swf-actions" },
          h("button", { className: "swf-btn swf-btn-primary", disabled: !sessionId, onClick: createCronTask }, "创建定时日报"),
          h("button", { className: "swf-btn", disabled: !sessionId, onClick: copyCronPrompt }, "复制提示词"),
        ),
      ),
      reportMsg ? h("div", { className: "swf-note" }, reportMsg) : null,
      aiConvId && aiStatus === "streaming" ? h("div", { className: "swf-note" }, "已创建会话 " + aiConvId + "，正在面板内流式接收总结…") : null,
      h("details", { className: "swf-note" }, h("summary", null, t.prompt), h("code", { className: "swf-code" }, prompt)),
      h("div", { className: "swf-note" }, "本地指标（发言人数 / 每小时活跃 / 参与度 / 热力 / 类型分布）由 MCP 在 SQL 侧对全量数据聚合；话题、关键词、待办与热度洞察由「深度分析」的 Agent 生成。"),
    );
  };

  /* ---- 渲染：结果表格 ---- */
  const renderRows = (rows) => {
    const sample = rows.slice(0, 20);
    const cols = [];
    for (const p of PREFERRED_COLS) {
      if (sample.some((r) => r && typeof r === "object" && r[p] !== undefined)) cols.push(p);
    }
    for (const r of sample) {
      if (!r || typeof r !== "object") continue;
      for (const k of Object.keys(r)) if (cols.indexOf(k) < 0) cols.push(k);
    }
    const use = cols.slice(0, 6);
    if (!use.length) return h("div", { className: "swf-result" }, pretty(rows, 20000));
    return h(
      "div",
      { className: "swf-tablewrap" },
      h(
        "table",
        { className: "swf-table" },
        h("thead", null, h("tr", null, use.map((c) => h("th", { key: c }, c)))),
        h(
          "tbody",
          null,
          rows.slice(0, 200).map((r, i) =>
            h(
              "tr",
              { key: i },
              use.map((c) => {
                const v = r && typeof r === "object" ? r[c] : r;
                let s = v === undefined || v === null ? "" : typeof v === "object" ? pretty(v, 200) : String(v);
                s = s.replace(/\s+/g, " ");
                // 路径列：真实图片文件直接给缩略图（仅前 12 行做内联预览，避免大量读盘）
                // .dat 是私有容器，宿主读不了，这里不做内联预览
                if (i < 12 && isRealImagePath(s)) {
                  const short = s.length > 40 ? "…" + s.slice(-38) : s;
                  return h(
                    "td",
                    { key: c, className: "swf-td-img", title: s },
                    h(ImagePreview, { api: api, path: s, title: s, compact: true, onOpen: (p) => openLocalFile(api, p) }),
                    h("div", { className: "swf-path" }, short),
                  );
                }
                if (s.length > 90) s = s.slice(0, 90) + "…";
                return h("td", { key: c, title: s }, s);
              }),
            ),
          ),
        ),
      ),
      rows.length > 200 ? h("div", { className: "swf-note" }, "仅显示前 200 行，共 " + rows.length + " " + t.rows) : null,
    );
  };

  /* ---- 渲染：MCP 能力 ---- */
  const renderField = (tool, f) => {
    const v = valueOf(tool.name, f);
    const onChange = (x) => setValue(tool.name, f.k, x);
    if (f.type === "session") {
      return h(
        "select",
        { className: "swf-field-input", value: v, onChange: (e) => onChange(e.target.value) },
        h("option", { value: "" }, f.label.indexOf("可空") >= 0 ? "（不限定）" : "— 选择群 —"),
        sessions.map((s) => h("option", { key: s.session_id, value: s.session_id }, s.display_name || s.session_id)),
      );
    }
    if (f.type === "date") {
      return h("input", { className: "swf-field-input", type: "date", value: v, onChange: (e) => onChange(e.target.value) });
    }
    if (f.type === "number") {
      return h("input", {
        className: "swf-field-input",
        type: "number",
        value: v,
        onChange: (e) => onChange(e.target.value),
      });
    }
    if (f.type === "switch") {
      return h("label", { className: "swf-toggle" }, h("input", { type: "checkbox", checked: !!v, onChange: (e) => onChange(e.target.checked) }), f.label);
    }
    if (f.type === "select") {
      const opts = f.options || [];
      return h(
        "select",
        { className: "swf-field-input", value: v, onChange: (e) => onChange(e.target.value) },
        opts.map((o, i) =>
          h("option", { key: o || "any", value: o }, f.labels && f.labels[i] ? f.labels[i] : o || "不限"),
        ),
      );
    }
    return h("input", {
      className: "swf-field-input",
      type: "text",
      placeholder: f.label,
      value: v,
      onChange: (e) => onChange(e.target.value),
    });
  };

  const renderMcp = () => {
    return h(
      "div",
      null,
      h(
        "div",
        { className: "swf-tool-row", style: { padding: "6px 4px 2px" } },
        counts ? h("span", { className: "swf-pill" }, "消息 " + fmtNum(counts.messages || 0)) : null,
        counts ? h("span", { className: "swf-pill" }, "会话 " + fmtNum(counts.sessions || 0)) : null,
        counts ? h("span", { className: "swf-pill" }, "联系人 " + fmtNum(counts.contacts || 0)) : null,
        counts ? h("span", { className: "swf-pill" }, "媒体 " + fmtNum(counts.media_files || 0)) : null,
      ),
      h("div", { className: "swf-note" }, t.mcpHint),
      TOOL_GROUPS.map((g) => {
        const list = TOOLS.filter((x) => x.group === g);
        if (!list.length) return null;
        return h(
          "div",
          { key: g },
          h("div", { className: "swf-section" }, g),
          h(
            "div",
            { className: "swf-tools" },
            list.map((tool) => {
              const on = openTool === tool.name;
              return h(
                "div",
                { className: "swf-tool" + (on ? " swf-tool-on" : ""), key: tool.name },
                h(
                  "div",
                  { className: "swf-tool-head", onClick: () => toggleTool(tool.name) },
                  h("span", { className: "swf-tool-zh", style: { flex: "0 0 auto", opacity: 1, fontWeight: 600 } }, tool.zh),
                  h("span", { className: "swf-tool-zh" }, tool.desc),
                  tool.dangerous ? h("span", { className: "swf-pill swf-pill-warn" }, "写操作") : null,
                  h("span", { className: "swf-pill" }, on ? "−" : "+"),
                ),
                on
                  ? h(
                      "div",
                      { className: "swf-tool-body" },
                      (tool.fields || []).length
                        ? h(
                            "div",
                            { className: "swf-fields" },
                            tool.fields.map((f) =>
                              h(
                                "div",
                                { className: "swf-field", key: f.k },
                                f.type === "switch" ? null : h("span", { className: "swf-field-label" }, f.label),
                                renderField(tool, f),
                              ),
                            ),
                          )
                        : h("div", { className: "swf-note", style: { margin: 0 } }, t.noFields),
                      h(
                        "div",
                        { className: "swf-tool-row" },
                        h(
                          "button",
                          {
                            className: "swf-btn swf-btn-primary swf-btn-sm",
                            disabled: callBusy,
                            onClick: () => invokeTool(tool),
                          },
                          callBusy
                            ? t.running
                            : tool.dangerous && armed !== tool.name
                              ? t.confirmRun
                              : t.run,
                        ),
                        h("button", { className: "swf-btn swf-btn-sm", onClick: () => resetTool(tool) }, t.reset),
                        h("span", { className: "swf-spacer" }),
                        h("span", { className: "swf-pill" }, tool.name),
                      ),
                      callResult
                        ? h(
                            "div",
                            null,
                            h(
                              "div",
                              { className: "swf-tool-row" },
                              callResult.ok ? h("span", { className: "swf-pill swf-pill-ok" }, "成功") : h("span", { className: "swf-pill swf-pill-warn" }, "失败"),
                              h("span", { className: "swf-pill" }, callResult.ms + " ms"),
                              callResult.count !== null && callResult.count !== undefined
                                ? h("span", { className: "swf-pill" }, callResult.count + " " + t.rows)
                                : null,
                            ),
                            callResult.error ? h("div", { className: "swf-error" }, callResult.error) : null,
                            callResult.rows && callResult.rows.length
                              ? renderRows(callResult.rows)
                              : callResult.text
                                ? h("div", { className: "swf-result" }, callResult.text)
                                : h("div", { className: "swf-note", style: { margin: 0 } }, t.empty),
                            callResult.text
                              ? h(
                                  "details",
                                  { className: "swf-note", style: { margin: "6px 0 0" } },
                                  h("summary", null, t.raw),
                                  h("div", { className: "swf-result" }, callResult.text),
                                )
                              : null,
                          )
                        : null,
                    )
                  : null,
              );
            }),
          ),
        );
      }),
    );
  };

  const seg = (id, label) =>
    h("button", { className: "swf-seg-btn" + (view === id ? " swf-seg-on" : ""), onClick: () => setView(id) }, label);

  const submit = view === "feed" ? loadFeed : loadStats;

  return h(
    "div",
    { className: "swf-root" },
    h(
      "div",
      { className: "swf-top" },
      h(
        "div",
        { className: "swf-top-row" },
        h("div", { className: "swf-seg" }, seg("feed", t.tabFeed), seg("digest", t.tabDigest), seg("mcp", t.tabMcp)),
        h("span", { className: "swf-spacer" }),
        counts
          ? h("span", { className: "swf-badge", title: "wechat MCP" }, h("span", { className: "swf-dot" }), t.connected + " · " + fmtNum(counts.messages || 0))
          : null,
      ),
      view === "mcp"
        ? null
        : h(
            "div",
            { className: "swf-top-row swf-ctrl" },
            h(
              "select",
              { className: "swf-select", value: sessionId, onChange: (e) => setSessionId(e.target.value) },
              h("option", { value: "" }, sessions.length ? "— " + t.group + " —" : "（无可用群聊）"),
              sessions.map((s) =>
                h(
                  "option",
                  { key: s.session_id, value: s.session_id },
                  (s.display_name || s.session_id) +
                    (s.message_count ? "  (" + fmtNum(s.message_count) + ")" : "") +
                    (s.unread ? " · " + fmtNum(s.unread) + t.unread : ""),
                ),
              ),
            ),
          ),
      view === "mcp"
        ? null
        : h(
            "div",
            { className: "swf-top-row swf-ctrl" },
            h(
              "div",
              { className: "swf-range", title: "时间范围（精确到分钟）" },
              h("input", { className: "swf-date", type: "date", value: start, onChange: (e) => { setStart(e.target.value); setReportPeriod("custom"); } }),
              h("input", { className: "swf-time", type: "time", step: "60", value: startTime, onChange: (e) => { setStartTime(e.target.value); setReportPeriod("custom"); }, title: "起始时刻" }),
              h("span", { className: "swf-range-sep" }, "→"),
              h("input", { className: "swf-date", type: "date", value: end, onChange: (e) => { setEnd(e.target.value); setReportPeriod("custom"); } }),
              h("input", { className: "swf-time", type: "time", step: "60", value: endTime, onChange: (e) => { setEndTime(e.target.value); setReportPeriod("custom"); }, title: "结束时刻" }),
            ),
            h("button", { className: "swf-btn swf-btn-primary", disabled: loading, onClick: submit }, loading ? t.busy : view === "feed" ? t.query : t.stats),
            h(
              "button",
              {
                className: "swf-btn swf-sync-btn" + (syncing ? " swf-syncing" : ""),
                disabled: syncing,
                title: t.syncHint,
                onClick: runSync,
              },
              h(
                "svg",
                {
                  className: "swf-sync-ico",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: 2.2,
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                },
                h("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }),
                h("polyline", { points: "21 3 21 9 15 9" }),
              ),
              syncing ? t.syncing : t.sync,
            ),
          ),
      view === "mcp"
        ? null
        : h(
            "div",
            { className: "swf-top-row swf-ctrl" },
            h(
              "div",
              { className: "swf-presets" },
              h("button", { className: "swf-chipbtn", onClick: () => applyPreset(0, "day") }, "今天"),
              h("button", { className: "swf-chipbtn", onClick: applyRolling24 }, "近 24 小时"),
              h("button", { className: "swf-chipbtn", onClick: () => applyPreset(6) }, "近 7 天"),
              h("button", { className: "swf-chipbtn", onClick: () => applyPreset(29) }, "近 30 天"),
            ),
            h("button", { className: "swf-btn", title: t.resetHint, onClick: resetFilters }, t.reset),
            view === "feed"
              ? h("input", {
                  className: "swf-input",
                  placeholder: t.keyword,
                  value: keyword,
                  onChange: (e) => setKeyword(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === "Enter") loadFeed();
                  },
                })
              : null,
            view === "feed"
              ? h("label", { className: "swf-toggle" }, h("input", { type: "checkbox", checked: onlyMedia, onChange: (e) => setOnlyMedia(e.target.checked) }), t.onlyMedia)
              : null,
            view === "feed"
              ? h("label", { className: "swf-toggle" }, h("input", { type: "checkbox", checked: onlyAt, onChange: (e) => setOnlyAt(e.target.checked) }), t.onlyAt)
              : null,
          ),
      syncMsg
        ? h(
            "div",
            {
              className:
                "swf-syncmsg" +
                (syncMsg.ok ? "" : " swf-syncmsg-err") +
                // 只有「成功且不在同步中」才淡出；同步中与失败都常驻
                (syncMsg.ok && !syncing ? " swf-syncmsg-ok" : ""),
            },
            h("span", { className: "swf-syncmsg-text" }, syncMsg.text),
            syncMsg.ok
              ? null
              : h(
                  "button",
                  { className: "swf-syncmsg-x", onClick: () => setSyncMsg(null), title: "关闭提示" },
                  "✕",
                ),
          )
        : null,
      // 提示条贴在工具栏下、滚动容器**外**：.swf-body 是滚动容器且首屏会贴底，
      // 放在里面会被滚出视口 —— 而这条提示正是「点了没反应」时要被看到的那句话。
      debug ? h("code", { className: "swf-code" }, debug) : null,
    ),
    h(
      "div",
      { className: "swf-body", ref: bodyRef },
      error ? h("div", { className: "swf-error" }, error) : null,
      view === "feed" ? renderFeed() : view === "digest" ? renderDigest() : renderMcp(),
    ),
  );
}

/* ============================ 入口 ============================ */

export default function Panel(props) {
  return h(WechatPanel, props);
}

export function mount(container) {
  container.textContent = "wechat 面板以 ESM React 组件形式导出（default export）。";
  return () => {
    container.replaceChildren();
  };
}
