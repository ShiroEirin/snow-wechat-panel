// 真 React 挂载回归：node --check 与模板测试都抓不到 useCallback 依赖数组的 TDZ。
// v0.32.28 初版曾连续踩中 cancelAiRetry / runAi 前向引用，导致整个 AppErrorBoundary 白屏。
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { act } = React;

(async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://panel.test/", pretendToBeVisual: true });
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  // Node 24 的全局 navigator 是 getter，不能像普通字段一样 Object.assign。
  Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const sanitized = src.replace(/^export default /m, "const __Panel = ").replace(/^export function mount/m, "function __mount");
  const api = {
    metadata: {
      get: async (domain) => domain === "projects"
        ? { directories: [{ path: "C:/project", isActive: true }] }
        : { items: [] },
      subscribe: async () => () => {},
      domains: async () => [],
    },
    write: {
      run: async () => ({ ok: true, data: {} }),
      domains: () => [{ id: "mcpTools", granted: true, actions: [{ id: "mcpTools.call", granted: true }] }],
    },
    storage: { getJson: async () => null, setJson: async () => ({ ok: true }) },
    assets: { resolve: (x) => x },
    log: () => {},
    t: (x) => x,
  };
  window.SnowAppPlugin = { React, api, icons: {}, locale: "zh-CN" };
  window.snow = { readFileContent: async () => "" };
  const Panel = new Function("window", "module", "exports", sanitized + "\nreturn __Panel;")(window, { exports: {} }, {});
  const errors = [];
  const oldError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => {
      root.render(React.createElement(Panel, { api, locale: "zh-CN" }));
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    const text = document.body.textContent;
    if (!text.includes("信息流") || !text.includes("总结")) throw new Error("面板未渲染预期导航");
    const tabs = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent === "总结");
    if (!tabs.length) throw new Error("未找到总结标签");
    await act(async () => {
      tabs[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    if (!document.body.textContent.includes("画报 · HTML")) throw new Error("总结 / 画报视图未完成渲染");
    if (errors.length) throw new Error("React 渲染错误：" + errors.join("\n"));
    console.log("通过：真实 React 面板挂载、总结 / 画报视图渲染与卸载；无 TDZ / render error");
  } finally {
    await act(async () => root.unmount());
    console.error = oldError;
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
