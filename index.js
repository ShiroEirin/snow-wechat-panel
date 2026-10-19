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
const { useState, useEffect, useMemo, useCallback } = React;

const MCP_SERVER = "wechat";
const PAGE_LIMIT = 200;
const ACCENT = "#3b82f6";

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
  return h(
    "div",
    { className: box + " swf-imgbox-fail" },
    h("span", { className: "swf-imgfail-t" }, "图片未解密"),
    h("span", { className: "swf-imgfail-d", title: state.error }, state.error || "未知原因"),
    state.hint ? h("span", { className: "swf-imgfail-d" }, state.hint) : null,
    state.datPath
      ? h("span", { className: "swf-imgfail-d", title: state.datPath }, "加密原图：…" + String(state.datPath).slice(-44))
      : null,
    h(
      "div",
      { className: "swf-imgfail-ops" },
      h("button", { className: "swf-btn swf-btn-mini", onClick: load }, "重试"),
      openTarget && onOpen
        ? h("button", { className: "swf-btn swf-btn-mini", onClick: () => onOpen(openTarget) }, "打开文件")
        : null,
    ),
  );
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

function classify(content) {
  const c = String(content === undefined || content === null ? "" : content);
  if (c.indexOf("<sysmsg") >= 0) return { tag: "系统", text: c };
  if (c.indexOf("[图片]") >= 0 || c.indexOf("[照片]") >= 0) return { tag: "图片", text: c };
  if (c.indexOf("[视频]") >= 0) return { tag: "视频", text: c };
  if (c.indexOf("[文件]") >= 0 || c.indexOf("[文档]") >= 0) return { tag: "文件", text: c };
  if (c.indexOf("[语音]") >= 0) return { tag: "语音", text: c };
  if (c.indexOf("[动画表情]") >= 0) return { tag: "表情", text: c };
  if (c.indexOf("[聊天记录]") >= 0) return { tag: "聊天记录", text: c };
  if (c.indexOf("http://") >= 0 || c.indexOf("https://") >= 0) return { tag: "链接", text: c };
  if (c.length > 0 && c.length <= 12 && c.charAt(0) === "[" && c.charAt(c.length - 1) === "]") {
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
function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}
function dateStr(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
function todayStr() {
  return dateStr(new Date());
}
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateStr(d);
}

/** 高频片段：CJK/英数连续段做 2-gram（无分词依赖的轻量近似） */
function topWords(texts, limit) {
  const counts = Object.create(null);
  for (const raw of texts) {
    const t = String(raw || "");
    let buf = "";
    const flush = () => {
      if (buf.length >= 2) {
        for (let i = 0; i + 1 < buf.length; i++) {
          const g = buf.slice(i, i + 2);
          counts[g] = (counts[g] || 0) + 1;
        }
      }
      buf = "";
    };
    for (let i = 0; i < t.length; i++) {
      const code = t.charCodeAt(i);
      const isCJK = code >= 0x4e00 && code <= 0x9fff;
      const isWord = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      if (isCJK || isWord) buf += t.charAt(i);
      else flush();
    }
    flush();
  }
  return Object.keys(counts)
    .map((w) => ({ word: w, count: counts[w] }))
    .filter((x) => x.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit || 18);
}

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
    name: "sync_wechat_database",
    group: "风格与维护",
    zh: "同步微信数据",
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
    capped: en ? "Capped at 200 — narrow the range." : "已达单次 200 条上限，请缩小范围。",
    total: en ? "Messages" : "消息数",
    senders: en ? "Active" : "活跃人数",
    peak: en ? "Peak" : "峰值时段",
    days: en ? "Days" : "天数",
    hourly: en ? "Hourly distribution" : "按小时分布",
    topSenders: en ? "Top senders" : "活跃发言者",
    types: en ? "Message types" : "消息类型",
    words: en ? "Frequent phrases" : "高频片段（2-gram）",
    ai: en ? "AI deep summary" : "AI 深度总结",
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
  const [start, setStart] = useState(daysAgoStr(6));
  const [end, setEnd] = useState(todayStr());
  const [keyword, setKeyword] = useState("");
  const [onlyMedia, setOnlyMedia] = useState(false);
  const [onlyAt, setOnlyAt] = useState(false);

  const [messages, setMessages] = useState([]);
  // username → 头像 data URL。一次批量取回后按 sender_username 复用，缺失的不进 Map
  const [avatars, setAvatars] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [capped, setCapped] = useState(false);
  const [debug, setDebug] = useState("");

  const [stats, setStats] = useState(null);
  const [words, setWords] = useState([]);
  const [types, setTypes] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [created, setCreated] = useState(null);

  const [openTool, setOpenTool] = useState("");
  const [values, setValues] = useState({});
  const [armed, setArmed] = useState("");
  const [callBusy, setCallBusy] = useState(false);
  const [callResult, setCallResult] = useState(null);

  // 同步（重新解密 + 重建索引）：手动触发，成功后就地刷新群列表与信息流
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [sessionsNonce, setSessionsNonce] = useState(0);

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

  /* ---- 信息流 ---- */
  const loadFeed = useCallback(async () => {
    if (!sessionId) {
      setError(t.pick);
      return;
    }
    setLoading(true);
    setError("");
    setCreated(null);
    try {
      const list = keyword.trim()
        ? await callTool(api, "search_wechat_messages", { query: keyword.trim(), session_id: sessionId, limit: PAGE_LIMIT })
        : await callTool(api, "get_messages_by_range", { session_id: sessionId, start: start, end: end, limit: PAGE_LIMIT });
      const arr = asArray(list);
      setMessages(arr);
      setCapped(arr.length >= PAGE_LIMIT);
      setDebug("");
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
      setMessages([]);
      setError(errText(err));
    }
    setLoading(false);
  }, [api, sessionId, keyword, start, end, t.pick]);

  useEffect(() => {
    if (dep.phase === "ready" && sessionId) loadFeed();
    // 仅依赖就绪 / 切换群聊时自动查询
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep.phase, sessionId]);

  /* ---- 统计 ---- */
  const loadStats = useCallback(async () => {
    if (!sessionId) {
      setError(t.pick);
      return;
    }
    setLoading(true);
    setError("");
    setCreated(null);
    try {
      const s = await callTool(api, "get_chat_activity_stats", { session_id: sessionId, start: start, end: end });
      setStats(s && typeof s === "object" ? s : null);
      const msgs = await callTool(api, "get_messages_by_range", { session_id: sessionId, start: start, end: end, limit: PAGE_LIMIT });
      const arr = asArray(msgs);
      setWords(topWords(arr.map((m) => (m && m.content) || ""), 18));
      const buckets = Object.create(null);
      for (const m of arr) {
        const tag = classify(m && m.content).tag;
        buckets[tag] = (buckets[tag] || 0) + 1;
      }
      setTypes({ total: arr.length, buckets: buckets });
    } catch (err) {
      setStats(null);
      setError(errText(err));
    }
    setLoading(false);
  }, [api, sessionId, start, end, t.pick]);

  const prompt = useMemo(
    () =>
      [
        "请对本机微信会话做一次群聊总结（只读，不要向微信发送任何消息）。",
        "",
        "会话：" + ((current && current.display_name) || sessionId) + "（session_id: " + sessionId + "）",
        "时间范围：" + start + " ~ " + end,
        "",
        "请用 wechat MCP 工具取数，例如：",
        "- get_messages_by_range(session_id, start, end, limit=200, offset)：按范围取消息，支持 offset 翻页",
        "- get_chat_activity_stats(session_id, start, end)：活跃度统计",
        "- list_chatroom_members(chatroom_id)：群成员名单",
        "",
        "然后输出：",
        "1. 一句话摘要",
        "2. 主要议题（分点，标注参与人）",
        "3. 关键结论 / 待办 / 需要谁跟进",
        "4. 值得注意的链接或文件",
      ].join("\n"),
    [current, sessionId, start, end],
  );

  const runAi = useCallback(async () => {
    if (!sessionId) {
      setError(t.pick);
      return;
    }
    setAiBusy(true);
    setError("");
    setCreated(null);
    try {
      const directoryId = await resolveDirectoryId(api);
      const res = await api.write.run("conversations.create", {
        directoryId: directoryId,
        title: "群总结：" + ((current && current.display_name) || sessionId) + " " + start,
        text: prompt,
        autoReply: true,
      });
      if (!res || !res.ok) {
        const why = res && res.denied ? res.denied.reason : res && res.error ? res.error : "未知错误";
        throw new Error("创建会话失败：" + why);
      }
      setCreated(res.data || null);
    } catch (err) {
      setError(errText(err));
    }
    setAiBusy(false);
  }, [api, current, sessionId, start, prompt, t.pick]);

  const openSession = useCallback(async () => {
    if (!created || !created.conversationId) return;
    const res = await api.write.run("conversations.activate", { conversationId: created.conversationId });
    if (!res || !res.ok) setError("打开会话失败：" + (res && res.error ? res.error : "未知错误"));
  }, [api, created]);

  /* ---- MCP 能力 ---- */
  const ctx = { sessionId: sessionId, start: start, end: end };

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
    // 日期组按新 → 旧；组内消息也按新 → 旧（信息流以最新记录优先展示）。
    // sameBurst 用时间差绝对值，所以倒序后连续发言的分组仍然正确。
    return Array.from(map.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, list]) => [day, list.slice().reverse()]);
  }, [visible]);

  /* ---- 重置：把群选择 / 日期范围 / 关键词 / 过滤条件恢复默认 ---- */
  const resetFilters = useCallback(() => {
    setSessionId("");
    setStart(daysAgoStr(6));
    setEnd(todayStr());
    setKeyword("");
    setOnlyMedia(false);
    setOnlyAt(false);
    setMessages([]);
    setStats(null);
    setWords([]);
    setTypes(null);
    setCapped(false);
    setError("");
    setDebug("");
    setSyncMsg(null);
    log(api, "filters reset");
  }, [api]);

  /* ---- 手动同步：重新解密源库 + 重建索引 ---- */
  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const raw = await callToolRaw(api, "sync_wechat_database", { redecrypt: true });
      const r = unwrapMcp(raw);
      if (r && r.ok === false) {
        const why = ((r.decrypt_step || {}).error) || (r.etl_step && r.etl_step.reason) || "未知原因";
        setSyncMsg({ ok: false, text: t.syncFail + "：" + String(why).slice(0, 240) });
        log(api, "sync 失败：" + why);
      } else {
        const etl = (r && r.etl_step) || {};
        const secs = ((r && r.decrypt_step) || {}).seconds;
        setSyncMsg({
          ok: true,
          text: t.syncOk + " · " + fmtNum(etl.messages || 0) + " " + t.total + (secs ? " · 解密 " + secs + "s" : ""),
        });
        log(api, "sync ok -> " + preview(etl, 200));
        // 索引变了：重拉群列表（消息数变化）+ 当前信息流
        setSessionsNonce((n) => n + 1);
        if (sessionId) await loadFeed();
      }
    } catch (err) {
      setSyncMsg({ ok: false, text: t.syncFail + "：" + errText(err) });
    }
    setSyncing(false);
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
          className: "swf-msg" + (cont ? " swf-msg-cont" : ""),
          key: key,
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
        className: "swf-msg" + (cont ? " swf-msg-cont" : ""),
        key: key,
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
        q ? h("div", { className: "swf-quote" }, q.quote) : null,
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
        debug ? h("code", { className: "swf-code" }, debug) : null,
      );
    }
    return h(
      "div",
      null,
      capped ? h("div", { className: "swf-note" }, t.capped) : null,
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
    const topSenders = (stats && stats.top_senders) || [];
    const hours = [];
    for (let i = 0; i < 24; i++) hours.push(pad2(i));
    let maxHour = 1;
    let peakKey = "";
    let peakVal = 0;
    if (hourly) {
      for (const k of Object.keys(hourly)) {
        const v = Number(hourly[k]) || 0;
        if (v > maxHour) maxHour = v;
        if (v > peakVal) {
          peakVal = v;
          peakKey = k;
        }
      }
    }
    const maxSender = topSenders.reduce((a, s) => Math.max(a, Number(s.message_count) || 0), 1);
    const typeKeys = types ? Object.keys(types.buckets).sort((a, b) => types.buckets[b] - types.buckets[a]) : [];
    const maxType = typeKeys.reduce((a, k) => Math.max(a, types.buckets[k]), 1);
    const dayCount = stats && stats.daily_distribution ? Object.keys(stats.daily_distribution).length : 0;

    return h(
      "div",
      null,
      stats
        ? h(
            "div",
            { className: "swf-cards" },
            h("div", { className: "swf-card swf-card-accent" }, h("div", { className: "swf-card-k" }, t.total), h("div", { className: "swf-card-v" }, fmtNum(stats.total_messages || 0))),
            h("div", { className: "swf-card" }, h("div", { className: "swf-card-k" }, t.senders), h("div", { className: "swf-card-v" }, String(topSenders.length))),
            h("div", { className: "swf-card swf-card-accent" }, h("div", { className: "swf-card-k" }, t.peak), h("div", { className: "swf-card-v" }, peakKey ? peakKey + ":00" : "—")),
            h("div", { className: "swf-card" }, h("div", { className: "swf-card-k" }, t.days), h("div", { className: "swf-card-v" }, String(dayCount))),
          )
        : h("div", { className: "swf-empty" }, loading ? t.busy : t.noMsgs),

      topSenders.length
        ? h(
            "div",
            null,
            h("div", { className: "swf-section" }, t.topSenders),
            h(
              "div",
              { className: "swf-chips" },
              topSenders.slice(0, 8).map((s) =>
                h(
                  "span",
                  { className: "swf-chip", key: s.username || s.display_name },
                  h("span", { className: "swf-chip-av", style: { background: speakerColor(s.display_name || s.username) } }, avatarChar(s.display_name || s.username)),
                  s.display_name || s.username,
                  h("span", { className: "swf-chip-n" }, String(s.message_count || 0)),
                ),
              ),
            ),
          )
        : null,

      hourly
        ? h(
            "div",
            null,
            h("div", { className: "swf-section" }, t.hourly),
            h(
              "div",
              { className: "swf-hours" },
              hours.map((k) =>
                h(
                  "div",
                  { className: "swf-hour", key: k, title: k + ":00 — " + (Number(hourly[k]) || 0) },
                  h("div", { className: "swf-hour-bar", style: { height: ((Number(hourly[k]) || 0) / maxHour) * 100 + "%" } }),
                  k.charAt(1) === "0" ? h("div", { className: "swf-hour-k" }, k) : null,
                ),
              ),
            ),
          )
        : null,

      topSenders.length
        ? h(
            "div",
            null,
            h("div", { className: "swf-section" }, t.topSenders + " · 排行"),
            topSenders.map((s) =>
              h(
                "div",
                { className: "swf-bar-row", key: "bar-" + (s.username || s.display_name) },
                h("div", { className: "swf-bar-label", title: s.display_name || s.username }, s.display_name || s.username),
                h(
                  "div",
                  { className: "swf-bar-track" },
                  h("div", {
                    className: "swf-bar-fill",
                    style: {
                      width: ((Number(s.message_count) || 0) / maxSender) * 100 + "%",
                      background: speakerColor(s.display_name || s.username),
                    },
                  }),
                ),
                h("div", { className: "swf-bar-num" }, String(s.message_count || 0)),
              ),
            ),
          )
        : null,

      typeKeys.length
        ? h(
            "div",
            null,
            h("div", { className: "swf-section" }, t.types),
            typeKeys.map((k) =>
              h(
                "div",
                { className: "swf-bar-row", key: "type-" + k },
                h("div", { className: "swf-bar-label" }, k),
                h(
                  "div",
                  { className: "swf-bar-track" },
                  h("div", { className: "swf-bar-fill", style: { width: (types.buckets[k] / maxType) * 100 + "%", background: ACCENT } }),
                ),
                h("div", { className: "swf-bar-num" }, String(types.buckets[k])),
              ),
            ),
          )
        : null,

      words.length
        ? h(
            "div",
            null,
            h("div", { className: "swf-section" }, t.words),
            h(
              "div",
              { className: "swf-words" },
              words.map((w) => h("span", { className: "swf-word", key: w.word }, w.word, " ", h("b", null, String(w.count)))),
            ),
          )
        : null,

      h(
        "div",
        { className: "swf-actions" },
        h("button", { className: "swf-btn swf-btn-primary", disabled: aiBusy || !sessionId, onClick: runAi }, aiBusy ? t.busy : t.ai),
        created && created.conversationId ? h("button", { className: "swf-btn", onClick: openSession }, t.open) : null,
      ),
      created && created.conversationId ? h("div", { className: "swf-note" }, "已创建会话 " + created.conversationId + "，Agent 正在后台生成总结。") : null,
      h("details", { className: "swf-note" }, h("summary", null, t.prompt), h("code", { className: "swf-code" }, prompt)),
      h("div", { className: "swf-note" }, "统计快路径不消耗模型 token；「AI 深度总结」会新建一个 Agent 会话并把取数任务交给它。"),
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
                  (s.display_name || s.session_id) + (s.message_count ? "  (" + fmtNum(s.message_count) + ")" : ""),
                ),
              ),
            ),
          ),
      view === "mcp"
        ? null
        : h(
            "div",
            { className: "swf-top-row swf-ctrl" },
            h("input", { className: "swf-date", type: "date", value: start, onChange: (e) => setStart(e.target.value) }),
            h("input", { className: "swf-date", type: "date", value: end, onChange: (e) => setEnd(e.target.value) }),
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
        ? h("div", { className: "swf-syncmsg" + (syncMsg.ok ? "" : " swf-syncmsg-err") }, syncMsg.text)
        : null,
    ),
    h(
      "div",
      { className: "swf-body" },
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
