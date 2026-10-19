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
    "\nreturn { unwrapMcp, asArray, classify, isMedia, speakerColor, fmtNum, preview, dayKeyOf, hhmmOf, readAiMessage };",
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

console.log("其他");
ok("speakerColor 稳定", lib.speakerColor("Moment") === lib.speakerColor("Moment"));
ok("speakerColor 可区分", lib.speakerColor("Moment") !== lib.speakerColor("Chimney."));
eq("fmtNum 257827", lib.fmtNum(257827), "257.8k");
eq("fmtNum 2955", lib.fmtNum(2955), "2955");
eq("dayKeyOf", lib.dayKeyOf("2026-10-18 00:01:08"), "2026-10-18");
eq("hhmmOf", lib.hhmmOf("2026-10-18 00:01:08"), "00:01");

console.log("");
console.log("通过 " + pass + " / 失败 " + fail);
process.exit(fail === 0 ? 0 : 1);
