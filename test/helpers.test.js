// 数据层单元测试：只测纯函数（不依赖 React / 宿主）
// 运行：node test/helpers.test.js
//
// 为什么要有它：早期版本的解包器只处理对象信封，遇到 JSON 字符串信封时
// 静默返回非数组 -> 群列表空白且不报错。这里把该契约固定成回归测试。

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const CUT = "/* ============================ 主面板";
const cutAt = src.indexOf(CUT);
if (cutAt < 0) {
  console.error("找不到主面板分界标记，测试无法继续");
  process.exit(1);
}
const head = src.slice(0, cutAt);

const ReactStub = {
  useState: () => [],
  useEffect: () => {},
  useMemo: (f) => (typeof f === "function" ? f() : undefined),
  useCallback: (f) => f,
  useRef: () => ({ current: null }),
  createElement: () => null,
};
const windowStub = { SnowAppPlugin: { React: ReactStub, icons: {}, api: {}, locale: "zh-CN" } };

const factory = new Function(
  "window",
  "module",
  "exports",
  head +
    "\nreturn { unwrapMcp, asArray, classify, isMedia, speakerColor, fmtNum, preview, dayKeyOf, hhmmOf, readAiMessage, stripAiJson, buildStatsBrief, quoteCharsHint, mdStatusOf, mdStatusRest, memberRangeText, planDeepSegments, activeDeepLenses, rangeDaysOf, deepLensCap, deepVerifyWidth, clipForStage, scopeMatches, statsIsFresh, issueHeadlineLines, editorialMetrics, normalizeEditorial, editorialPrompt, buildArtIssueHtml, buildNewspaperHtml };",
);
const lib = factory(windowStub, { exports: {} }, {});

let pass = 0;
let fail = 0;

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + "\n         期望 " + e + "\n         实际 " + a);
  }
}

function ok(name, cond) {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    console.log("  FAIL " + name);
  }
}

console.log("unwrapMcp");
const inner = JSON.stringify([{ session_id: "a@chatroom", type: "room" }]);
eq("JSON 字符串信封 -> 数组", lib.unwrapMcp(JSON.stringify({ content: [{ type: "text", text: inner }] })), [
  { session_id: "a@chatroom", type: "room" },
]);
eq("structuredContent.result", lib.unwrapMcp({ structuredContent: { result: [1, 2] } }), [1, 2]);
eq("result 字段", lib.unwrapMcp({ result: [3] }), [3]);
eq("直接数组", lib.unwrapMcp([9]), [9]);
eq("普通对象原样", lib.unwrapMcp({ total: 1 }), { total: 1 });
eq("纯文本原样", lib.unwrapMcp("hello"), "hello");
eq("双层 JSON 字符串", lib.unwrapMcp(JSON.stringify(JSON.stringify({ result: [7] }))), [7]);
eq(
  "多 text 块合并",
  lib.unwrapMcp({
    content: [
      { type: "text", text: JSON.stringify({ a: 1 }) },
      { type: "text", text: JSON.stringify({ b: 2 }) },
    ],
  }),
  [{ a: 1 }, { b: 2 }],
);
eq("null", lib.unwrapMcp(null), null);
eq("undefined", lib.unwrapMcp(undefined), null);

console.log("asArray");
eq("直接数组", lib.asArray([1]), [1]);
eq("sessions 容器", lib.asArray({ sessions: [1, 2] }), [1, 2]);
eq("messages 容器", lib.asArray({ messages: [3] }), [3]);
eq("单会话对象", lib.asArray({ session_id: "x" }), [{ session_id: "x" }]);
eq("无法识别 -> 空数组", lib.asArray({ foo: 1 }), []);

console.log("classify / isMedia");
eq("[图片]", lib.classify("[图片]").tag, "图片");
eq("[视频]", lib.classify("[视频]").tag, "视频");
eq("[文件]", lib.classify("[文件] abc.pdf").tag, "文件");
eq("[语音]", lib.classify("[语音]").tag, "语音");
eq("[动画表情]", lib.classify("[动画表情]").tag, "表情");
eq("短括号 = 表情", lib.classify("[皱眉]").tag, "表情");
eq("URL = 链接", lib.classify("看这个 https://github.com/a/b").tag, "链接");
eq("普通文本", lib.classify("减少无用的token输出").tag, "文本");
eq("引用图片 ≠ 图片", lib.classify("[引用: [图片]] openai好强").tag, "文本");
eq("引用里的 [视频] 也不算", lib.classify("[引用: 谁: [视频]] 哈哈哈").tag, "文本");
eq("正文才是图片", lib.classify("[引用: 谁: 你好] [图片]").tag, "图片");
eq("引用前缀不影响正文链接", lib.classify("[引用: 谁: 你好] 看 https://a.b").tag, "链接");
ok("isMedia([图片])", lib.isMedia("[图片]"));
ok("isMedia(引用图片) = false", lib.isMedia("[引用: [图片]] openai好强") === false);
ok("!isMedia(普通文本)", !lib.isMedia("普通文本"));

console.log("readAiMessage");
const aiMsg = (content, status, live) =>
  lib.readAiMessage({
    items: [{ role: "assistant", content: content, status: status || "" }],
    live: live || null,
  });
ok("没有 assistant 消息 -> null", lib.readAiMessage({ items: [] }) === null);
ok("裸 JSON 也算完成", aiMsg('{"risks":[],"quotes":[]}').done === true);
ok("截断的 JSON 不算完成", aiMsg('{"risks":[{"topic":"a"').done === false);
ok("围栏 JSON 算完成", aiMsg('```json{"a":1}```').done === true);
ok("空正文不算完成", aiMsg("", "").done === false);

// 回归：单条消息 status=completed 不能当「整轮完成」
// Agent 常先发一句「先取数…」并调工具，这条消息同样是 completed；
// 早期用消息 status 判完成会立刻退订 + 停轮询，成稿永远读不到。
// live 也不能用：它是**焦点会话**状态，后台新建的会话不反映。
ok("消息 status=completed 不再单独判完成（开场白不是成稿）", aiMsg("随便写点", "completed").done === false);
ok("live.isStreaming=false 也不算完成（live 是焦点会话，不可信）", aiMsg("随便写点", "done", { isStreaming: false }).done === false);
ok("带结构化数据才完成", aiMsg('{"risks":[]}', "completed").done === true);

// 真实形态回归（会话 conv-1792581739059931300-40484 的实际结构）：
// 两条带工具调用的开场白（27 / 46 字）+ 两条 tool 结果 + 一条 3605 字成稿。
// 旧逻辑在第一条开场白处就判完成 -> 面板与导出长图只显示一句「别催」。
ok(
  "真实形态：开场白 + 工具结果 + 成稿 -> 选成稿且判完成",
  (() => {
    const r = lib.readAiMessage({
      items: [
      { role: "user", content: "提示词" },
      { role: "assistant", content: "本小姐先取出数据，再谈评价……笨蛋，别催。", status: "completed", toolCallsJson: "[]" },
      { role: "tool", content: '{"content":[{"text":"huge"}]}' },
      { role: "assistant", content: "本小姐要把剩下那批都取出来，哼。", status: "completed", toolCallsJson: "[]" },
      { role: "tool", content: '{"content":[{"text":"huge"}]}' },
      { role: "assistant", content: '## 一句话定性\n正文内容\n<<<AI_JSON>>>\n{"persona":"x"}\n<<<END>>>', status: "completed" },
      ],
    });
    return r.text.indexOf("一句话定性") >= 0 && r.done === true && r.hasJson === true;
  })(),
);
ok("只有工具调用 -> toolPending", lib.readAiMessage({ items: [{ role: "assistant", content: "", toolCallsJson: "[]" }] }).toolPending === true);

// 回归：messages 域的 items 顺序未被官方文档承诺，而 Agent 常先用一条 assistant 消息
// 说「先取数…」并调用工具，随后才输出正文 + 结构化数据。早期实现盲取
// assistants[length-1]，倒序时抓到的正是那句开场白 —— 面板与导出长图只剩一句话。
const opening = { role: "assistant", content: "哼，先取数，本小姐从不凭空猜。", status: "completed", toolCallsJson: "[]" };
const draft = { role: "assistant", content: "正文……\n<<<AI_JSON>>>\n{\"summary\":\"x\"}\n<<<END>>>", status: "completed" };
const multi = (arr) => lib.readAiMessage({ items: arr });
ok("倒序返回时选成稿（不取开场白）", multi([draft, opening]).text.indexOf("<<<AI_JSON>>>") >= 0);
ok("正序返回时同样选成稿", multi([opening, draft]).text.indexOf("<<<AI_JSON>>>") >= 0);
ok(
  "多条都无 JSON 时取正文最长的那条",
  multi([
    { role: "assistant", content: "短" },
    { role: "assistant", content: "长得多的一段正文，用来代表成稿" },
  ]).text === "长得多的一段正文，用来代表成稿",
);
ok("全部为空但有工具调用 -> 仍判 toolPending", multi([{ role: "assistant", content: "", toolCallsJson: "[]" }]).toolPending === true);

console.log("mdStatus（状态行自动上色）");
ok("✅ 识别为 ok", lib.mdStatusOf("✅ 三条结论").kind === "ok");
ok("🚨 识别为 danger", lib.mdStatusOf("🚨 风险").kind === "danger");
ok("💡 识别为 tip", lib.mdStatusOf("💡 顺带一提").kind === "tip");
// ⚠️ 是 U+26A0 + U+FE0F 两个码点：按码点取首字符会漏掉 VS16，必须用正则
ok("⚠️（带 VS16）识别为 warn", lib.mdStatusOf("⚠️ 风险提示").kind === "warn");
ok("普通段落不识别", lib.mdStatusOf("普通文字") === null);
eq("剥掉图标与空白", lib.mdStatusRest("✅ 三条结论"), "三条结论");
eq("剥掉带 VS16 的图标", lib.mdStatusRest("⚠️ 风险提示"), "风险提示");

console.log("stripAiJson");
const norm = (s) => String(s).replace(/\n+/g, "\n");
eq(
  "剔 ```json 围栏",
  norm(lib.stripAiJson('正文A\n```json\n{"x":1}\n```\n正文B')),
  "正文A\n正文B",
);
eq(
  "剔裸 JSON 围栏",
  norm(lib.stripAiJson('正文A\n```\n{"x":1}\n```\n正文B')),
  "正文A\n正文B",
);
ok("保留普通代码块", lib.stripAiJson('说明\n```js\nconsole.log(1)\n```').indexOf("console.log(1)") >= 0);
eq("空输入", lib.stripAiJson(""), "");
// 末尾裸 JSON（模型漏了围栏与标记）—— 成员分析实测踩过：正文下方挂着一大坨 JSON
eq(
  "剔末尾裸 JSON",
  norm(lib.stripAiJson('正文A\n{"persona":"x","topics":[]}')),
  "正文A",
);
eq(
  "剔末尾裸 JSON（多行）",
  norm(lib.stripAiJson('正文A\n{\n  "persona": "x"\n}')),
  "正文A",
);
// 保守边界：JSON 不在行首（紧贴正文）时不剥，避免误伤行内提到的 JSON
eq(
  "紧贴正文的 JSON 不剥",
  lib.stripAiJson('正文A{"x":1}'),
  '正文A{"x":1}',
);
eq(
  "行内 JSON 不剥",
  lib.stripAiJson('他说 {"a":1} 是这样'),
  '他说 {"a":1} 是这样',
);
// AI_JSON 标记写法
eq(
  "剔 AI_JSON 标记块",
  norm(lib.stripAiJson('正文A\n<<<AI_JSON>>>\n{"x":1}\n<<<END>>>')),
  "正文A",
);

console.log("其他");
ok("speakerColor 稳定", lib.speakerColor("Moment") === lib.speakerColor("Moment"));
ok("speakerColor 可区分", lib.speakerColor("Moment") !== lib.speakerColor("Chimney."));
eq("fmtNum 257827", lib.fmtNum(257827), "257.8k");
eq("fmtNum 2955", lib.fmtNum(2955), "2955");
eq("dayKeyOf", lib.dayKeyOf("2026-10-18 00:01:08"), "2026-10-18");
eq("hhmmOf", lib.hhmmOf("2026-10-18 00:01:08"), "00:01");

console.log("buildStatsBrief（统计基线注入）");
// 回归：v0.32.13 在 renderDigest 里漏了 stats 判空，导致「Cannot read properties of null」白屏。
// 统计基线构造函数本身也必须能承受 stats 为 null / 字段缺失。
const briefNull = lib.buildStatsBrief(null, null, "x@chatroom", "2026-10-21 00:00:00", "2026-10-21 23:59:59");
ok("stats 为 null 不崩（有兜底文案）", briefNull.indexOf("未加载统计基线") >= 0);
const briefEmpty = lib.buildStatsBrief({}, null, "x@chatroom", "2026-10-21 00:00:00", "2026-10-21 23:59:59");
ok("stats 为空对象不崩", typeof briefEmpty === "string" && briefEmpty.length > 0);
// 回归：字段名必须与 MCP 的 _system_events 对齐（此前读 withdrawn / system，两个都不存在，
// 注入给 Agent 的基线永远是「0 / 0」）。
const briefSys = lib.buildStatsBrief(
  { total_messages: 2227, unique_senders: 99, system_events: { recall_like_count: 19, system_message_count: 19 } },
  { display_name: "测试群" },
  "x@chatroom",
  "2026-10-21 00:00:00",
  "2026-10-21 23:59:59",
);
ok("撤回/系统消息读真实字段名", briefSys.indexOf("19 / 19") >= 0);
ok("不再输出假的 0 / 0", briefSys.indexOf("0 / 0") < 0);


console.log("quoteCharsHint（引用搬运提示）");
// 回归：chars 只算自己说的话、chars_total 含被引原文；差距明显时才提示。
ok("差距明显时提示含引用字数", lib.quoteCharsHint({ chars: 2456, chars_total: 6605 }) === "含引用 4149 字");
ok("差距不大时不打扰", lib.quoteCharsHint({ chars: 100, chars_total: 105 }) === "");
ok("没有 chars_total 时为空串", lib.quoteCharsHint({ chars: 100 }) === "");
ok("chars_total 小于等于 chars 时为空串", lib.quoteCharsHint({ chars: 100, chars_total: 100 }) === "");

console.log("memberRangeText（成员画像实际查询范围）");
// 回归：画像此前不显示查询范围，用户无法判断「130 条」到底是一天还是整段。
// 只认 MCP 回显的 time_range（范围变化后自动重取到的就是这份），null = 全部历史。
ok(
  "有范围时截到分钟",
  lib.memberRangeText({ time_range: { start: "2026-10-01 00:00:00", end: "2026-10-21 23:59:59" } }) ===
    "2026-10-01 00:00 ~ 2026-10-21 23:59",
);
ok("不限范围（MCP 返回 null）显示全部历史", lib.memberRangeText({ time_range: null }) === "全部历史");
ok("没有 profile 时不崩", lib.memberRangeText(null) === "全部历史");
ok("字段缺失时回退全部历史", lib.memberRangeText({ time_range: { start: "2026-10-01" } }) === "全部历史");
console.log("深挖流水线宽度（按跨度缩放）");
// 回归：早期版本不管跨度都跑「4 段 + 7 视角 + 7 验证 = 19 个子代理」，
// 日报被当成月报处理；第③阶段的 prompt 因此滚到 49176 字，把宿主渲染打崩。
const day = ["2026-10-22 00:00:00", "2026-10-22 23:59:59"];
const week = ["2026-10-01 00:00:00", "2026-10-07 23:59:59"];
const month = ["2026-10-01 00:00:00", "2026-10-31 23:59:59"];
const bigGroup = { total_messages: 5000 };

ok("rangeDaysOf 日跨度≈1", Math.abs(lib.rangeDaysOf(day[0], day[1]) - 1) < 0.01);
ok("rangeDaysOf 非法输入回退 1 天", lib.rangeDaysOf("", "") === 1);

eq("deepLensCap 日级 4 个", lib.deepLensCap(lib.rangeDaysOf(day[0], day[1])), 4);
eq("deepLensCap 周级 5 个", lib.deepLensCap(lib.rangeDaysOf(week[0], week[1])), 5);
eq("deepLensCap 月级 7 个", lib.deepLensCap(lib.rangeDaysOf(month[0], month[1])), 7);

eq("deepVerifyWidth 日级单代理", lib.deepVerifyWidth(lib.rangeDaysOf(day[0], day[1])), 1);
eq("deepVerifyWidth 周级 2 个", lib.deepVerifyWidth(lib.rangeDaysOf(week[0], week[1])), 2);
eq("deepVerifyWidth 月级 4 个", lib.deepVerifyWidth(lib.rangeDaysOf(month[0], month[1])), 4);

eq("planDeepSegments 日级不分段", lib.planDeepSegments(day[0], day[1], bigGroup, 0).length, 1);
const weekSegs = lib.planDeepSegments(week[0], week[1], bigGroup, 0);
ok("planDeepSegments 周级 2-3 段", weekSegs.length >= 2 && weekSegs.length <= 3);
const monthSegs = lib.planDeepSegments(month[0], month[1], bigGroup, 0);
ok("planDeepSegments 月级 4-8 段", monthSegs.length >= 4 && monthSegs.length <= 8);
eq("planDeepSegments 尊重显式 want", lib.planDeepSegments(month[0], month[1], bigGroup, 6).length, 6);

const allDims = { topics: true, todos: true, titles: true, sentiment: true, risks: true, quotes: true };
eq(
  "activeDeepLenses 日级裁到 4 个且按优先级",
  lib.activeDeepLenses(allDims, 1).map((x) => x[0]),
  ["topics", "people", "risks", "wild"],
);
eq("activeDeepLenses 月级全开 7 个", lib.activeDeepLenses(allDims, 30).length, 7);
eq(
  "activeDeepLenses 维度开关少于此数时不做补齐",
  lib.activeDeepLenses({ topics: true, quotes: true }, 1).map((x) => x[0]),
  ["topics", "quotes", "wild"],
);

console.log("clipForStage（阶段间裁剪）");
ok("未超限时原样返回", lib.clipForStage("abc", 100) === "abc");
const longText = "A".repeat(5000) + "B".repeat(5000);
const clipped = lib.clipForStage(longText, 1000);
ok("超限时裁到上限附近", clipped.length < 1300);
ok("裁剪后带省略标记", clipped.indexOf("中间省略") >= 0);
ok("裁剪后保留尾部", clipped.indexOf("B".repeat(50)) >= 0);

console.log("scopeMatches / statsIsFresh（口径守卫）");
// 回归：换日期后不能把上一段时间的总结恢复成「当前结果」；
// 深挖也不能把旧群/旧时间窗的统计当成「权威基线」。
const s1 = { rangeStart: "2026-10-01 00:00:00", rangeEnd: "2026-10-01 23:59:59" };
ok("范围完全一致才算匹配", lib.scopeMatches(s1, s1.rangeStart, s1.rangeEnd, false) === true);
ok("结束时间不同即不匹配", lib.scopeMatches(s1, s1.rangeStart, "2026-10-02 23:59:59", false) === false);
ok("全历史缓存不能当范围结果", lib.scopeMatches({ allTime: true }, "", "", false) === false);
ok("全历史模式只认全历史缓存", lib.scopeMatches({ allTime: true }, "x", "y", true) === true);
ok("旧缓存缺范围时视为不匹配", lib.scopeMatches({ text: "old" }, s1.rangeStart, s1.rangeEnd, false) === false);

ok(
  "统计同群同范围才算新鲜",
  lib.statsIsFresh("room-a", { start: "a", end: "b" }, "room-a", "a", "b") === true,
);
ok("统计跨群不新鲜", lib.statsIsFresh("room-a", { start: "a", end: "b" }, "room-b", "a", "b") === false);
ok("统计范围不符不新鲜", lib.statsIsFresh("room-a", { start: "a", end: "b" }, "room-a", "a", "c") === false);
ok("没有统计作用域时不新鲜", lib.statsIsFresh("", { start: "", end: "" }, "room-a", "", "") === false);

console.log("面板初始化顺序");
// 回归：v0.32.26 曾把 liveScopeRef.current 的赋值写在 rangeStart 声明之前，
// 运行时抛 Cannot access 'rangeStart' before initialization，整块面板白屏。
// node --check 只查语法，抓不到 TDZ，所以这里用源码位置固定顺序。
const liveAssignAt = src.indexOf("liveScopeRef.current = { sessionId");
const rangeDeclAt = src.indexOf("const rangeStart = useMemo");
ok("rangeStart 有声明", rangeDeclAt > 0);
ok("liveScopeRef 赋值在 rangeStart 声明之后", liveAssignAt > rangeDeclAt && liveAssignAt > 0);

// v0.32.27 曾让 runEditorial/saveIssue 的依赖数组直接引用声明在后面（6243+）的
// shownAiText / periodLabel，初始化阶段就抛 Cannot access 'shownAiText' before initialization。
const reStart = src.indexOf("const runEditorial =");
const reEnd = src.indexOf("const memberPrompt", reStart);
const issueBlock = src.slice(reStart, reEnd);
ok("画报回调不直接引用后置变量", issueBlock.indexOf("shownAiText") < 0 && issueBlock.indexOf("shownAiData") < 0 && issueBlock.indexOf("periodLabel: periodLabel") < 0);
const issueAssignAt = src.indexOf("issueCtxRef.current = {");
const shownDeclAt = src.indexOf("const shownAiText");
const periodDeclAt = src.indexOf("const periodLabel = useMemo");
ok("issueCtxRef 在后置变量声明之后赋值", issueAssignAt > shownDeclAt && issueAssignAt > periodDeclAt && issueAssignAt > 0);

console.log("画报 · 编辑部分析与模板");
const issueStats = {
  total_messages: 1234,
  unique_senders: 42,
  hourly_distribution: { "09": 5, "10": 12, "21": 3 },
  top_phrases: [{ phrase: "炼丹", count: 9 }],
  member_rank: [
    { display_name: "小王", username: "u1", messages: 20 },
    { display_name: "小李", username: "u2", messages: 12 },
  ],
  highlights: [{ text: "原话一条", sender_name: "小王", time: "2026-10-20 10:05:00" }],
  system_events: { recall_rate: 0.0125 },
};
const issueMetrics = lib.editorialMetrics(issueStats);
ok("画报指标：总量/人数", issueMetrics.total === 1234 && issueMetrics.senders === 42);
ok("画报指标：峰值小时", issueMetrics.peakHour === "10" && issueMetrics.peakCount === 12);
ok("画报指标：热词与撤回率", issueMetrics.topPhrase === "炼丹" && issueMetrics.recallRate === "1.3%");

const headLines = lib.issueHeadlineLines("一群人，把深夜调成了工作台", 11.5);
ok("标题按词分行且不丢字", headLines.join("") === "一群人，把深夜调成了工作台");
ok("标题不出现单字掉行", headLines.length === 2 && headLines[1] !== "台");
const longLines = lib.issueHeadlineLines("这一条特别长的标题用来确认分行不会把词拆开也不会超过四行", 11.5);
ok("超长标题最多四行", longLines.length <= 4 && longLines.length >= 2);

const fallbackIssue = lib.normalizeEditorial(null, {
  stats: issueStats,
  title: "测试群",
  rangeLabel: "2026-10-20 ~ 2026-10-20",
  periodLabel: "日报",
  avatarMap: {},
});
ok("无 AI 时仍能出头条", fallbackIssue.headline.indexOf("测试群") >= 0);
ok("无 AI 时小节不为空", fallbackIssue.sections.length >= 1);
ok("无 AI 时人物来自成员榜", fallbackIssue.characters.length === 2 && fallbackIssue.characters[0].name === "小王");
ok("无 AI 时时间线来自峰值", fallbackIssue.timeline.length >= 1 && fallbackIssue.timeline[0].time === "10:00");
ok("无 AI 时金句来自 highlights", fallbackIssue.quotes.length === 1 && fallbackIssue.quotes[0].text === "原话一条");

const promptText = lib.editorialPrompt({
  sessionName: "测试群",
  rangeStart: "2026-10-20 00:00:00",
  rangeEnd: "2026-10-20 23:59:59",
  statsBrief: "消息总量：1234",
  prevText: "已有结论",
});
ok("编辑部分析提示词含契约字段", promptText.indexOf('"headline"') >= 0 && promptText.indexOf('"characters"') >= 0);
ok("编辑部分析提示词带统计基线", promptText.indexOf("消息总量：1234") >= 0);

const artHtml = lib.buildArtIssueHtml({
  aiData: {
    kicker: "群像志",
    headline: "<script>alert(1)</script>",
    deck: "副标题",
    lead: "导语",
    sections: [{ title: "一节", body: "正文", pull_quote: "拉引" }],
    characters: [{ name: "小王", role: "水群王", quote: "原话" }],
    timeline: [{ time: "10:00", event: "峰值" }],
    quotes: [{ text: "金句", who: "小王", time: "10:05" }],
    closing: "下期见",
  },
  stats: issueStats,
  title: "测试群",
  rangeLabel: "2026-10-20 ~ 2026-10-20",
  periodLabel: "日报",
  skin: "noir",
  generatedAt: "2026-10-20 23:00",
});
ok("艺术画报是完整 HTML", artHtml.indexOf("<!doctype html>") === 0 && artHtml.indexOf("</html>") > 0);
ok("艺术画报带皮肤与动效", artHtml.indexOf('data-skin="noir"') >= 0 && artHtml.indexOf("IntersectionObserver") >= 0);
ok("艺术画报转义脚本注入", artHtml.indexOf("<script>alert(1)</script>") < 0 && artHtml.indexOf("&lt;script&gt;") >= 0);
ok("艺术画报无外链资源", artHtml.indexOf('src="http') < 0 && artHtml.indexOf("<link") < 0);

const paperHtml = lib.buildNewspaperHtml({
  aiData: fallbackIssue,
  stats: issueStats,
  title: "测试群",
  rangeLabel: "2026-10-20 ~ 2026-10-20",
  periodLabel: "日报",
  variant: "extra",
  generatedAt: "2026-10-20 23:00",
});
ok("报纸画报是完整 HTML", paperHtml.indexOf("<!doctype html>") === 0 && paperHtml.indexOf("</html>") > 0);
ok("报纸画报带版式与打印样式", paperHtml.indexOf('data-variant="extra"') >= 0 && paperHtml.indexOf("@media print") >= 0);
ok("报纸画报包含分栏与首字下沉", paperHtml.indexOf("columns:3") >= 0 && paperHtml.indexOf("first-letter") >= 0);
ok("报纸画报无外链资源", paperHtml.indexOf('src="http') < 0 && paperHtml.indexOf("<link") < 0);

console.log("");
console.log("通过 " + pass + " / 失败 " + fail);
process.exit(fail === 0 ? 0 : 1);
