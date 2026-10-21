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
    "\nreturn { unwrapMcp, asArray, classify, isMedia, speakerColor, fmtNum, preview, dayKeyOf, hhmmOf, readAiMessage, stripAiJson, buildStatsBrief, quoteCharsHint };",
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
const aiMsg = (content, status) =>
  lib.readAiMessage({ items: [{ role: "assistant", content: content, status: status || "" }] });
ok("没有 assistant 消息 -> null", lib.readAiMessage({ items: [] }) === null);
ok("裸 JSON 也算完成", aiMsg('{"risks":[],"quotes":[]}').done === true);
ok("截断的 JSON 不算完成", aiMsg('{"risks":[{"topic":"a"').done === false);
ok("围栏 JSON 算完成", aiMsg('```json{"a":1}```').done === true);
ok("状态白名单算完成", aiMsg("随便写点", "done").done === true);
ok("空正文不算完成", aiMsg("", "").done === false);
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
console.log("");
console.log("通过 " + pass + " / 失败 " + fail);
process.exit(fail === 0 ? 0 : 1);
