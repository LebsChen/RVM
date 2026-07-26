"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const LOGICAL_W = 1024;
const LOGICAL_H = 768;
const screenCache = { width: 0, height: 0, at: 0 };
let lastAnnotatedDomHash = "";

function shq(s) {
  return "'" + String(s == null ? "" : s).replace(/'/g, "'\\''") + "'";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
}

function normalizeActions(body) {
  if (Array.isArray(body.actions) && body.actions.length) return body.actions.slice();
  if (body.action) return [body];
  return [];
}

function isWin() {
  return process.platform === "win32";
}

function displayEnv() {
  return process.env.DISPLAY || ":0";
}

function keyList(body) {
  if (Array.isArray(body.modifiers)) return body.modifiers.filter(Boolean).map(String);
  if (Array.isArray(body.modifier_keys)) return body.modifier_keys.filter(Boolean).map(String);
  if (Array.isArray(body.modifierKeys)) return body.modifierKeys.filter(Boolean).map(String);
  const out = [];
  for (const k of ["ctrl", "shift", "alt", "meta"]) {
    if (body[k]) out.push(k);
  }
  return out;
}

function comboParts(text) {
  return String(text || "")
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
}

function mapLogicalPoint(coord, real) {
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const [x, y] = coord.map((n) => Number(n) || 0);
  return [
    Math.max(0, Math.round((x * real.width) / LOGICAL_W)),
    Math.max(0, Math.round((y * real.height) / LOGICAL_H)),
  ];
}

function mapLogicalRegion(region, real) {
  if (!Array.isArray(region) || region.length < 4) return null;
  const [x1, y1, x2, y2] = region.map((n) => Number(n) || 0);
  const rx1 = Math.max(0, Math.round((Math.min(x1, x2) * real.width) / LOGICAL_W));
  const ry1 = Math.max(0, Math.round((Math.min(y1, y2) * real.height) / LOGICAL_H));
  const rx2 = Math.max(rx1 + 1, Math.round((Math.max(x1, x2) * real.width) / LOGICAL_W));
  const ry2 = Math.max(ry1 + 1, Math.round((Math.max(y1, y2) * real.height) / LOGICAL_H));
  return { x: rx1, y: ry1, width: rx2 - rx1, height: ry2 - ry1 };
}

async function runShell(env, cmd, cwd, timeoutMs) {
  return env.runShell(cmd, cwd, timeoutMs);
}

async function detectResolution(env, force = false) {
  const now = Date.now();
  if (!force && screenCache.width > 0 && now - screenCache.at < 30_000) {
    return { width: screenCache.width, height: screenCache.height };
  }
  let width = 0;
  let height = 0;
  if (isWin()) {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
$s = [Windows.Forms.Screen]::PrimaryScreen.Bounds
"$($s.Width)x$($s.Height)"
`;
    const r = await runShell(env, ps, undefined, 5000);
    const m = String(r.stdout || "").trim().match(/(\d+)x(\d+)/);
    if (m) {
      width = parseInt(m[1], 10);
      height = parseInt(m[2], 10);
    }
  } else {
    const r = await runShell(env, `export DISPLAY=${shq(displayEnv())}; xdpyinfo | grep dimensions`, undefined, 5000);
    const m = String(r.stdout || "").match(/(\d+)x(\d+)/);
    if (m) {
      width = parseInt(m[1], 10);
      height = parseInt(m[2], 10);
    }
  }
  if (!width || !height) throw new Error("cannot detect resolution");
  screenCache.width = width;
  screenCache.height = height;
  screenCache.at = now;
  return { width, height };
}

function winKeyCode(name) {
  const k = String(name || "").toLowerCase();
  const table = {
    ctrl: 0x11,
    control: 0x11,
    shift: 0x10,
    alt: 0x12,
    menu: 0x12,
    meta: 0x5b,
    win: 0x5b,
    windows: 0x5b,
    enter: 0x0d,
    return: 0x0d,
    tab: 0x09,
    escape: 0x1b,
    esc: 0x1b,
    backspace: 0x08,
    delete: 0x2e,
    del: 0x2e,
    space: 0x20,
    left: 0x25,
    up: 0x26,
    right: 0x27,
    down: 0x28,
    home: 0x24,
    end: 0x23,
    pageup: 0x21,
    pagedown: 0x22,
    insert: 0x2d,
  };
  if (table[k]) return table[k];
  const mf = k.match(/^f(\d{1,2})$/);
  if (mf) return 0x70 + Math.max(1, Math.min(24, parseInt(mf[1], 10))) - 1;
  if (k.length === 1) {
    const ch = k.toUpperCase();
    const code = ch.charCodeAt(0);
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)) return code;
  }
  return 0;
}

const WIN_CS = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public class CloudDevInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern void mouse_event(uint f,int x,int y,int d,int e);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] static extern short VkKeyScanEx(char ch, IntPtr dwhkl);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint idThread);
  const uint DOWN_L=0x02, UP_L=0x04, DOWN_R=0x08, UP_R=0x10, DOWN_M=0x20, UP_M=0x40, WHEEL=0x0800, HWHEEL=0x01000, KEYUP=0x0002;
  static byte Vk(string key) {
    key = (key ?? "").Trim().ToLowerInvariant();
    switch (key) {
      case "ctrl": case "control": return 0x11;
      case "shift": return 0x10;
      case "alt": case "menu": return 0x12;
      case "meta": case "win": case "windows": return 0x5b;
      case "enter": case "return": return 0x0d;
      case "tab": return 0x09;
      case "escape": case "esc": return 0x1b;
      case "backspace": return 0x08;
      case "delete": case "del": return 0x2e;
      case "space": return 0x20;
      case "left": return 0x25;
      case "up": return 0x26;
      case "right": return 0x27;
      case "down": return 0x28;
      case "home": return 0x24;
      case "end": return 0x23;
      case "pageup": return 0x21;
      case "pagedown": return 0x22;
      case "insert": return 0x2d;
    }
    if (key.Length == 1) {
      var c = key[0];
      if (c >= 'a' && c <= 'z') return (byte)char.ToUpperInvariant(c);
      if (c >= '0' && c <= '9') return (byte)c;
      var scan = VkKeyScanEx(c, GetKeyboardLayout(0));
      if (scan != -1) return (byte)(scan & 0xff);
    }
    int f;
    if (key.Length > 1 && key[0] == 'f' && int.TryParse(key.Substring(1), out f) && f >= 1 && f <= 24) return (byte)(0x70 + f - 1);
    return 0;
  }
  public static void Move(int x,int y){ SetCursorPos(x,y); }
  public static string Cursor(){ POINT p; return GetCursorPos(out p) ? p.X + "," + p.Y : "0,0"; }
  public static void LeftDown(){ mouse_event(DOWN_L,0,0,0,0); }
  public static void LeftUp(){ mouse_event(UP_L,0,0,0,0); }
  public static void RightDown(){ mouse_event(DOWN_R,0,0,0,0); }
  public static void RightUp(){ mouse_event(UP_R,0,0,0,0); }
  public static void MiddleDown(){ mouse_event(DOWN_M,0,0,0,0); }
  public static void MiddleUp(){ mouse_event(UP_M,0,0,0,0); }
  public static void Click(int x,int y,string button){
    SetCursorPos(x,y);
    if ((button ?? "").ToLowerInvariant() == "right") { RightDown(); RightUp(); }
    else if ((button ?? "").ToLowerInvariant() == "middle") { MiddleDown(); MiddleUp(); }
    else { LeftDown(); LeftUp(); }
  }
  public static void DoubleClick(int x,int y,string button){
    SetCursorPos(x,y);
    if ((button ?? "").ToLowerInvariant() == "right") { RightDown(); RightUp(); RightDown(); RightUp(); }
    else if ((button ?? "").ToLowerInvariant() == "middle") { MiddleDown(); MiddleUp(); MiddleDown(); MiddleUp(); }
    else { LeftDown(); LeftUp(); LeftDown(); LeftUp(); }
  }
  public static void TripleClick(int x,int y,string button){
    SetCursorPos(x,y);
    for (int i = 0; i < 3; i++) {
      if ((button ?? "").ToLowerInvariant() == "right") { RightDown(); RightUp(); }
      else if ((button ?? "").ToLowerInvariant() == "middle") { MiddleDown(); MiddleUp(); }
      else { LeftDown(); LeftUp(); }
    }
  }
  public static void Drag(int x1,int y1,int x2,int y2,string button){
    SetCursorPos(x1,y1);
    if ((button ?? "").ToLowerInvariant() == "right") RightDown();
    else if ((button ?? "").ToLowerInvariant() == "middle") MiddleDown();
    else LeftDown();
    Thread.Sleep(20);
    SetCursorPos(x2,y2);
    Thread.Sleep(20);
    if ((button ?? "").ToLowerInvariant() == "right") RightUp();
    else if ((button ?? "").ToLowerInvariant() == "middle") MiddleUp();
    else LeftUp();
  }
  public static void Scroll(int x,int y,int delta){
    SetCursorPos(x,y);
    mouse_event(WHEEL,0,0,delta,0);
  }
  public static void HScroll(int x,int y,int delta){
    SetCursorPos(x,y);
    mouse_event(HWHEEL,0,0,delta,0);
  }
  public static void KeyDown(string key){ var vk = Vk(key); if (vk != 0) keybd_event(vk,0,0,UIntPtr.Zero); }
  public static void KeyUp(string key){ var vk = Vk(key); if (vk != 0) keybd_event(vk,0,KEYUP,UIntPtr.Zero); }
  public static void KeyPress(string key){ KeyDown(key); KeyUp(key); }
  public static void Type(string text){ try { System.Windows.Forms.SendKeys.SendWait(text); } catch { System.Windows.Forms.SendKeys.SendWait(text.Replace("+", "{+}").Replace("^", "{^}").Replace("%", "{%}").Replace("~", "{~}").Replace("(", "{(}").Replace(")", "{)}").Replace("[", "{[}").Replace("]", "{]}").Replace("{", "{{}").Replace("}", "{}}")); } }
}
`;

function buildWinPs(bodyLines) {
  return `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing @'
${WIN_CS}
'@
${bodyLines.join("\n")}
`;
}

async function winRun(env, bodyLines, timeoutMs) {
  return runShell(env, buildWinPs(bodyLines), undefined, timeoutMs);
}

async function linuxMouse(env, cmd, timeoutMs = 5000) {
  return runShell(env, `export DISPLAY=${shq(displayEnv())}; ${cmd}`, undefined, timeoutMs);
}

async function currentCursor(env) {
  if (isWin()) {
    const r = await winRun(env, ['[CloudDevInput]::Cursor()'], 5000);
    const m = String(r.stdout || "").trim().match(/(\d+),(\d+)/);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [0, 0];
  }
  const r = await linuxMouse(env, "xdotool getmouselocation --shell", 5000);
  const mx = String(r.stdout || "").match(/X=(\d+)/);
  const my = String(r.stdout || "").match(/Y=(\d+)/);
  return [mx ? parseInt(mx[1], 10) : 0, my ? parseInt(my[1], 10) : 0];
}

async function runLinuxCombo(env, keys, body, timeoutMs = 5000) {
  const mods = keys.map((k) => k.toLowerCase());
  const xdotoolMods = mods.map((m) => (m === "control" ? "ctrl" : m)).join(" ");
  const [x, y] = body.coordinate ? await mapCoordinate(env, body.coordinate) : await currentCursor(env);
  const mouseBtn = body.button === "right" ? "3" : body.button === "middle" ? "2" : "1";
  const down = mods.map((m) => `xdotool keydown ${shq(m === "control" ? "ctrl" : m)}`).join("; ");
  const up = mods.slice().reverse().map((m) => `xdotool keyup ${shq(m === "control" ? "ctrl" : m)}`).join("; ");
  const click = `xdotool mousemove ${x} ${y} click ${mouseBtn}`;
  const cmd = [down, click, up].filter(Boolean).join("; ");
  return linuxMouse(env, cmd, timeoutMs);
}

async function mapCoordinate(env, coord) {
  const real = await detectResolution(env);
  return mapLogicalPoint(coord, real) || [0, 0];
}

async function mapRegion(env, region) {
  const real = await detectResolution(env);
  return mapLogicalRegion(region, real);
}

async function captureLinuxScreen(env, tmpIn, tmpOut, region, timeoutMs = 15000) {
  const grab = `export DISPLAY=${shq(displayEnv())}; (scrot ${shq(tmpIn)} 2>/dev/null || maim ${shq(tmpIn)} 2>/dev/null || import -window root ${shq(tmpIn)} 2>/dev/null)`;
  const r = await runShell(env, grab, undefined, timeoutMs);
  if (r.exit_code !== 0) return { error: `screenshot failed: ${r.stderr || r.stdout || "unknown"}` };
  if (region) {
    const crop = `${tmpOut}`;
    const cmd = `convert ${shq(tmpIn)} -crop ${region.width}x${region.height}+${region.x}+${region.y} +repage ${shq(crop)}`;
    const rr = await runShell(env, cmd, undefined, 30000);
    if (rr.exit_code !== 0) return { error: `crop failed: ${rr.stderr || rr.stdout || "unknown"}` };
  } else {
    const rr = await runShell(env, `convert ${shq(tmpIn)} -resize ${LOGICAL_W}x${LOGICAL_H}! ${shq(tmpOut)}`, undefined, 30000);
    if (rr.exit_code !== 0) return { error: `resize failed: ${rr.stderr || rr.stdout || "unknown"}` };
  }
  const data = fs.readFileSync(tmpOut);
  try { fs.unlinkSync(tmpIn); } catch {}
  try { if (tmpOut !== tmpIn) fs.unlinkSync(tmpOut); } catch {}
  return { image: data.toString("base64"), format: "png" };
}

async function captureWinScreen(env, tmpOut, region) {
  const out = tmpOut.replace(/'/g, "''");
  const regionCode = region
    ? `
$bmp2 = New-Object Drawing.Bitmap(${region.width},${region.height})
$g2 = [Drawing.Graphics]::FromImage($bmp2)
$g2.DrawImage($bmp, 0, 0, [Drawing.Rectangle]::new(${region.x},${region.y},${region.width},${region.height}), [Drawing.GraphicsUnit]::Pixel)
$g2.Dispose()
$bmp.Dispose()
$bmp2.Save('${out}','Png')
$bmp2.Dispose()
`
    : `
$bmp2 = New-Object Drawing.Bitmap(1024,768)
$g2 = [Drawing.Graphics]::FromImage($bmp2)
$g2.DrawImage($bmp, 0, 0, 1024, 768)
$g2.Dispose()
$bmp.Dispose()
$bmp2.Save('${out}','Png')
$bmp2.Dispose()
`;
  const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$s = [Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object Drawing.Bitmap($s.Width,$s.Height)
$g = [Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($s.Location,[Drawing.Point]::Empty,$s.Size)
$g.Dispose()
${regionCode}
[Convert]::ToBase64String([IO.File]::ReadAllBytes('${out}'))
`;
  const r = await runShell(env, ps, undefined, 20000);
  return r.exit_code === 0 ? { image: String(r.stdout || "").trim(), format: "png" } : { error: `screenshot failed: ${r.stderr || r.stdout || "unknown"}` };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("dom timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function withDomIfVisible(env, payload, log) {
  try {
    const dom = await withTimeout(readAnnotatedDom(env, log), 12000);
    if (dom && dom.dom) {
      const hash = crypto.createHash("sha256").update(dom.dom).digest("hex");
      if (hash === lastAnnotatedDomHash) {
        payload.dom = "(annotated DOM identical, omitted)";
      } else {
        payload.dom = dom.dom;
        lastAnnotatedDomHash = hash;
      }
    }
  } catch {}
  return payload;
}

async function cdpCall(env, wsUrl, method, params = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let done = false;
    let sockRef = null;
    let timer = null;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { if (sockRef) sockRef.end(); } catch {}
      fn(v);
    };
    timer = setTimeout(() => finish(reject, new Error(`cdp timeout: ${method}`)), Math.max(1000, timeoutMs | 0));
    env.wsClientConnect(wsUrl, (err, sock, head) => {
      if (err) return finish(reject, err);
      sockRef = sock;
      const id = Math.floor(Math.random() * 1e9);
      const reader = env.makeWsMsgReader((opcode, payload) => {
        if (opcode === 0x01 || opcode === 0x02) {
          try {
            const msg = JSON.parse(payload.toString("utf8"));
            if (msg.id === id) {
              if (msg.error) finish(reject, new Error(msg.error.message || "cdp error"));
              else finish(resolve, msg.result || {});
            }
          } catch {}
        }
      });
      sock.on("data", reader);
      sock.on("error", (e) => finish(reject, e));
      sock.on("close", () => finish(reject, new Error("cdp socket closed")));
      try {
        const msg = Buffer.from(JSON.stringify({ id, method, params }));
        sock.write(env.wsFrameMasked(msg, 0x01));
        if (head && head.length) reader(head);
      } catch (e) {
        finish(reject, e);
      }
    });
  });
}

async function findVisiblePage(env, log) {
  const port = await env.ensureCdpBrowser(log);
  const list = await env.cdpHttpGetJson(port, "/json");
  const pages = Array.isArray(list) ? list.filter((t) => t && t.type === "page" && t.webSocketDebuggerUrl) : [];
  let visibleFallback = null;
  let anyFallback = null;
  for (const page of pages) {
    try {
      try { await cdpCall(env, page.webSocketDebuggerUrl, "Runtime.enable", {}); } catch {}
      try { await cdpCall(env, page.webSocketDebuggerUrl, "Page.enable", {}); } catch {}
      const vis = await cdpCall(env, page.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true, awaitPromise: false });
      const info = { port, wsUrl: page.webSocketDebuggerUrl, url: page.url || "", title: page.title || "" };
      const blank = !info.url || info.url === "about:blank" || info.url.startsWith("about:blank");
      if (vis && vis.result && vis.result.value === "visible") {
        if (!blank) return info;
        if (!visibleFallback) visibleFallback = info;
      }
      if (!anyFallback && !blank) anyFallback = info;
      if (!anyFallback) anyFallback = info;
    } catch {}
  }
  if (visibleFallback) return visibleFallback;
  if (anyFallback) return anyFallback;
  if (pages[0]) return { port, wsUrl: pages[0].webSocketDebuggerUrl, url: pages[0].url || "", title: pages[0].title || "" };
  return null;
}

async function readAnnotatedDom(env, log) {
  const port = await env.ensureCdpBrowser(log);
  const target = (await findVisiblePage(env, log)) || { port, wsUrl: await env.getCdpPageWsUrl(port) };
  if (!target || !target.wsUrl) return null;
  try { await cdpCall(env, target.wsUrl, "Page.bringToFront", {}); } catch {}
  try { await cdpCall(env, target.wsUrl, "Runtime.enable", {}); } catch {}
  try { await cdpCall(env, target.wsUrl, "Page.enable", {}); } catch {}
  const readyAt = Date.now();
  for (;;) {
    const state = await cdpCall(env, target.wsUrl, "Runtime.evaluate", { expression: "document.readyState", returnByValue: true, awaitPromise: false });
    if (state && state.result && state.result.value === "complete") break;
    if (Date.now() - readyAt > 5000) break;
    await sleep(100);
  }
  const src = fs.readFileSync(path.join(__dirname, "annotateDom.js"), "utf8");
  const idx = src.indexOf("([interactiveElementCount");
  if (idx < 0) throw new Error("annotateDom.js missing entry point");
  const expr = `(() => { try { return (${src.slice(idx).trim()})([0, false, true]).dom; } catch (e) { return "__RVM_ANNOTATE_ERROR__" + String((e && e.stack) || (e && e.message) || e); } })()`;
  const out = await cdpCall(env, target.wsUrl, "Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: false,
  });
  const value = out && out.result ? out.result.value : null;
  if (typeof value !== "string") return null;
  if (value.startsWith("__RVM_ANNOTATE_ERROR__")) {
    return { ok: false, error: value.slice("__RVM_ANNOTATE_ERROR__".length) || "annotateDom failed", blank: false };
  }
  if (!value.trim()) {
    const url = String(target.url || "").trim();
    const blank = !url || url === "about:blank" || url.startsWith("about:");
    return {
      ok: true,
      dom: "",
      text: blank
        ? "当前页面为空白页(about:blank)，无可注释 DOM"
        : "当前页面没有可注释 DOM",
      blank: true,
    };
  }
  return { ok: true, dom: value, text: value, blank: false };
}

async function doMouseAction(env, action, body, realPointGetter) {
  const mods = keyList(body);
  if (isWin()) {
    const point = body.start_coordinate ? await mapCoordinate(env, body.start_coordinate) : (body.coordinate ? await mapCoordinate(env, body.coordinate) : await currentCursor(env));
    const [x, y] = point;
    const button = body.button || (action.includes("right") ? "right" : action.includes("middle") ? "middle" : "left");
    const modDown = mods.map((m) => `[CloudDevInput]::KeyDown('${m}')`);
    const modUp = mods.slice().reverse().map((m) => `[CloudDevInput]::KeyUp('${m}')`);
    const mouseCall =
      action === "mouse_move" ? `[CloudDevInput]::Move(${x},${y})` :
      action === "left_mouse_down" ? `[CloudDevInput]::Move(${x},${y}); [CloudDevInput]::LeftDown()` :
      action === "left_mouse_up" ? `[CloudDevInput]::Move(${x},${y}); [CloudDevInput]::LeftUp()` :
      action === "left_click" ? `[CloudDevInput]::Click(${x},${y},'${button}')` :
      action === "right_click" ? `[CloudDevInput]::Click(${x},${y},'right')` :
      action === "middle_click" ? `[CloudDevInput]::Click(${x},${y},'middle')` :
      action === "double_click" ? `[CloudDevInput]::DoubleClick(${x},${y},'${button}')` :
      action === "triple_click" ? `[CloudDevInput]::TripleClick(${x},${y},'${button}')` :
      action === "left_click_drag" ? `[CloudDevInput]::Drag(${x},${y},${body.coordinate ? (await mapCoordinate(env, body.coordinate))[0] : (body.coordinate2 ? (await mapCoordinate(env, body.coordinate2))[0] : x)},${body.coordinate ? (await mapCoordinate(env, body.coordinate))[1] : (body.coordinate2 ? (await mapCoordinate(env, body.coordinate2))[1] : y)},'${button}')` :
      action === "scroll" ? (String(body.scroll_direction || "down").toLowerCase() === "left" || String(body.scroll_direction || "").toLowerCase() === "right" ? `[CloudDevInput]::HScroll(${x},${y},${(String(body.scroll_direction || "down").toLowerCase() === "left" ? -1 : 1) * (Number(body.scroll_amount) || 3) * 120})` : `[CloudDevInput]::Scroll(${x},${y},${(String(body.scroll_direction || "down").toLowerCase() === "up" ? 1 : -1) * (Number(body.scroll_amount) || 3) * 120})`) :
      null;
    if (!mouseCall) return { error: `unknown mouse action: ${action}` };
    const ps = buildWinPs([...modDown, mouseCall, ...modUp]);
    const r = await runShell(env, ps, undefined, 10000);
    return r.exit_code === 0 ? { ok: true } : { error: r.stderr || r.stdout || "mouse action failed" };
  }

  const disp = `export DISPLAY=${shq(displayEnv())}; `;
  const [x, y] = body.start_coordinate ? await mapCoordinate(env, body.start_coordinate) : (body.coordinate ? await mapCoordinate(env, body.coordinate) : await currentCursor(env));
  const [x2, y2] = body.coordinate ? await mapCoordinate(env, body.coordinate) : (body.coordinate2 ? await mapCoordinate(env, body.coordinate2) : [x, y]);
  const modDown = mods.map((m) => `xdotool keydown ${shq(String(m).toLowerCase() === "control" ? "ctrl" : m)}`).join("; ");
  const modUp = mods.slice().reverse().map((m) => `xdotool keyup ${shq(String(m).toLowerCase() === "control" ? "ctrl" : m)}`).join("; ");
  const button = body.button === "right" ? "3" : body.button === "middle" ? "2" : "1";
  let cmd = "";
  switch (action) {
    case "mouse_move":
      cmd = `xdotool mousemove ${x} ${y}`;
      break;
    case "left_mouse_down":
      cmd = `xdotool mousemove ${x} ${y}; xdotool mousedown 1`;
      break;
    case "left_mouse_up":
      cmd = `xdotool mousemove ${x} ${y}; xdotool mouseup 1`;
      break;
    case "left_click":
    case "right_click":
    case "middle_click":
      cmd = `xdotool mousemove ${x} ${y}; xdotool click ${button}`;
      break;
    case "double_click":
      cmd = `xdotool mousemove ${x} ${y}; xdotool click --repeat 2 ${button}`;
      break;
    case "triple_click":
      cmd = `xdotool mousemove ${x} ${y}; xdotool click --repeat 3 ${button}`;
      break;
    case "left_click_drag":
      cmd = `xdotool mousemove ${x} ${y}; xdotool mousedown 1; xdotool mousemove ${x2} ${y2}; xdotool mouseup 1`;
      break;
    case "scroll": {
      const dir = String(body.scroll_direction || "down").toLowerCase();
      const clicks = Number(body.scroll_amount) || 3;
      const wheel = dir === "left" ? "6" : dir === "right" ? "7" : dir === "up" ? "4" : "5";
      cmd = `xdotool mousemove ${x} ${y}; xdotool click --repeat ${clicks} ${wheel}`;
      break;
    }
    default:
      return { error: `unknown mouse action: ${action}` };
  }
  const full = [modDown, cmd, modUp].filter(Boolean).join("; ");
  const r = await runShell(env, `${disp}${full}`, undefined, 10000);
  return r.exit_code === 0 ? { ok: true } : { error: r.stderr || r.stdout || "mouse action failed" };
}

async function doKeyAction(env, action, body) {
  const key = String(body.key || body.text || "");
  if (isWin()) {
    const mods = comboParts(key);
    const combo = mods.length > 1 ? mods : [key];
    const main = combo[combo.length - 1];
    const modsOnly = combo.slice(0, -1);
    const lines = [];
    for (const m of modsOnly) lines.push(`[CloudDevInput]::KeyDown('${m}')`);
    if (action === "hold_key") {
      lines.push(`[CloudDevInput]::KeyDown('${main}')`);
      lines.push(`Start-Sleep -Milliseconds ${Math.max(0, Number(body.duration) || 0)}`);
      lines.push(`[CloudDevInput]::KeyUp('${main}')`);
    } else {
      lines.push(`[CloudDevInput]::KeyPress('${main}')`);
    }
    for (const m of modsOnly.slice().reverse()) lines.push(`[CloudDevInput]::KeyUp('${m}')`);
    const r = await winRun(env, lines, 10000);
    return r.exit_code === 0 ? { ok: true } : { error: r.stderr || r.stdout || "key action failed" };
  }
  const mods = comboParts(key).map((k) => String(k).toLowerCase() === "control" ? "ctrl" : k.toLowerCase());
  if (action === "hold_key") {
    const cmd = [
      ...mods.slice(0, -1).map((m) => `xdotool keydown ${shq(m)}`),
      `xdotool keydown ${shq(mods[mods.length - 1] || key)}`,
      `sleep ${Math.max(0, Number(body.duration) || 0) / 1000}`,
      `xdotool keyup ${shq(mods[mods.length - 1] || key)}`,
      ...mods.slice(0, -1).reverse().map((m) => `xdotool keyup ${shq(m)}`),
    ].join("; ");
    const r = await linuxMouse(env, cmd, Math.max(5000, (Number(body.duration) || 0) + 2000));
    return r.exit_code === 0 ? { ok: true } : { error: r.stderr || r.stdout || "hold key failed" };
  }
  const combo = comboParts(key).map((k) => (String(k).toLowerCase() === "control" ? "ctrl" : k.toLowerCase())).join("+");
  const r = await linuxMouse(env, `xdotool key --clearmodifiers ${shq(combo || key)}`, undefined, 5000);
  return r.exit_code === 0 ? { ok: true } : { error: r.stderr || r.stdout || "key action failed" };
}

async function doType(env, text) {
  const t = String(text || "");
  if (isWin()) {
    const r = await winRun(env, [`[CloudDevInput]::Type(${JSON.stringify(t)})`], Math.max(10000, t.length * 20));
    return r.exit_code === 0 ? { ok: true } : { error: r.stderr || r.stdout || "type failed" };
  }
  const r = await linuxMouse(env, `xdotool type --delay 12 -- ${shq(t)}`, Math.max(10000, t.length * 20));
  return r.exit_code === 0 ? { ok: true } : { error: r.stderr || r.stdout || "type failed" };
}

async function doWait(body) {
  await sleep(Number(body.duration) || 0);
  return { ok: true };
}

async function doCursorPosition(env) {
  const [x, y] = await currentCursor(env);
  return { ok: true, coordinate: [x, y], x, y };
}

async function doResolution(env) {
  const { width, height } = await detectResolution(env, true);
  return { width, height };
}

async function captureFull(env, region = null) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inFile = path.join(os.tmpdir(), `clouddev-computer-${id}-in.png`);
  const outFile = path.join(os.tmpdir(), `clouddev-computer-${id}-out.png`);
  if (isWin()) return captureWinScreen(env, outFile, region);
  return captureLinuxScreen(env, inFile, outFile, region);
}

async function doScreenshot(env, log) {
  const shot = await captureFull(env, null);
  if (shot.error) return shot;
  return withDomIfVisible(env, shot, log);
}

async function doZoom(env, body, log) {
  const region = await mapRegion(env, body.region);
  if (!region) return { error: "region required" };
  const shot = await captureFull(env, region);
  if (shot.error) return shot;
  return withDomIfVisible(env, shot, log);
}

async function readDomResult(env, log) {
  const dom = await readAnnotatedDom(env, log);
  if (!dom) return { ok: false, text: "No visible browser page or CDP unavailable." };
  if (dom.ok === false) return { ok: false, text: `annotateDom failed: ${dom.error || "unknown error"}` };
  if (dom.blank) return { ok: true, text: dom.text || "当前页面为空白页(about:blank)，无可注释 DOM" };
  const hash = crypto.createHash("sha256").update(dom.dom).digest("hex");
  if (hash === lastAnnotatedDomHash) {
    return { ok: true, text: "(annotated DOM identical, omitted)" };
  }
  lastAnnotatedDomHash = hash;
  return { ok: true, text: dom.dom, dom: dom.dom };
}

function domPerceptionPageFn() {
  const MAX = 20000;
  const norm = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  const lines = [];
  let chars = 0;
  let truncated = false;
  const push = (value) => {
    const line = norm(value);
    if (!line) return;
    if (chars + line.length + (lines.length ? 2 : 0) > MAX) {
      truncated = true;
      return;
    }
    lines.push(line);
    chars += line.length;
  };
  const isVisible = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(el);
    if (!style) return true;
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return !!(rect.width || rect.height || rect.top || rect.left);
  };
  const labelFor = (el) => {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const value = labelledBy.split(/\s+/).map((id) => {
        const labelEl = document.getElementById(id);
        return labelEl ? (labelEl.innerText || labelEl.textContent || "") : "";
      }).join(" ");
      const text = norm(value);
      if (text) return text;
    }
    const ariaLabel = norm(el.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    const id = el.getAttribute("id");
    if (id) {
      const label = document.querySelector("label[for='" + String(CSS.escape(id)) + "']");
      const text = norm(label && (label.innerText || label.textContent));
      if (text) return text;
    }
    const ancestorLabel = el.closest ? el.closest("label") : null;
    const ancestorText = norm(ancestorLabel && (ancestorLabel.innerText || ancestorLabel.textContent));
    if (ancestorText) return ancestorText;
    const placeholder = norm(el.getAttribute("placeholder"));
    if (placeholder) return placeholder;
    return "";
  };
  const inlineText = (node) => {
    let out = "";
    for (const child of node.childNodes || []) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent || "";
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName ? child.tagName.toLowerCase() : "";
        if (tag === "a") {
          const text = norm(child.innerText || child.textContent);
          const href = norm(child.getAttribute("href"));
          out += "[" + (text || href || "link") + "](" + (href || "#") + ")";
        } else if (tag === "br") {
          out += "\\n";
        } else {
          out += inlineText(child);
        }
      }
    }
    return norm(out);
  };
  const fieldLine = (el, kind) => {
    const label = labelFor(el);
    let value = "";
    if (kind === "select") {
      value = norm(Array.from(el.selectedOptions || []).map((opt) => opt.innerText || opt.textContent || "").join(" "));
    } else {
      value = norm(el.value != null ? el.value : (el.textContent || ""));
    }
    const details = [];
    if (label) details.push("label=" + label);
    if (value) details.push("value=" + value);
    if (kind) details.push("type=" + kind);
    if (details.length) push("- [field] " + details.join(" · "));
  };
  const visit = (node) => {
    if (!node || truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = norm(node.textContent);
      if (text) push(text);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    if (!isVisible(el)) return;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") return;
    if (tag === "title") {
      push("# " + norm(el.textContent));
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      push(new Array(Number(tag.slice(1)) + 1).join("#") + " " + norm(el.textContent));
      return;
    }
    if (tag === "a") {
      const text = norm(el.innerText || el.textContent);
      const href = norm(el.getAttribute("href"));
      push("[" + (text || href || "link") + "](" + (href || "#") + ")");
      return;
    }
    if (tag === "button") {
      push("[button] " + norm(el.innerText || el.textContent));
      return;
    }
    if (tag === "input") {
      fieldLine(el, el.getAttribute("type") || "input");
      return;
    }
    if (tag === "textarea") {
      fieldLine(el, "textarea");
      return;
    }
    if (tag === "select") {
      fieldLine(el, "select");
      return;
    }
    if (tag === "li") {
      push("- " + (inlineText(el) || norm(el.innerText || el.textContent)));
      return;
    }
    if (tag === "p") {
      push(inlineText(el) || norm(el.innerText || el.textContent));
      return;
    }
    const childElements = Array.from(el.children || []);
    if (!childElements.length) {
      const text = norm(el.innerText || el.textContent);
      if (text) push(text);
      return;
    }
    for (const child of el.childNodes || []) visit(child);
  };
  const title = norm(document.title);
  if (title) push("# " + title);
  if (document.body) visit(document.body);
  let markdown = lines.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  if (markdown.length > MAX) {
    markdown = markdown.slice(0, MAX - 16).trimEnd() + "\n\n…[truncated]";
  }
  return { ok: true, mode: "dom", url: String(location.href || ""), markdown, text: markdown };
}

function buildDomPerceptionExpression() {
  return "(" + domPerceptionPageFn.toString() + ")()";
}

async function domPerceptionResult(env, log) {
  const target = await findVisiblePage(env, log);
  if (!target || !target.wsUrl) return null;
  const url = String(target.url || "").trim();
  const blank = !url || url === "about:blank" || url.startsWith("about:blank");
  if (blank) {
    return {
      ok: true,
      mode: "dom",
      url,
      markdown: "",
      text: "当前页面为空白页(about:blank)，无可感知内容",
    };
  }
  try {
    try { await cdpCall(env, target.wsUrl, "Page.bringToFront", {}); } catch {}
    try { await cdpCall(env, target.wsUrl, "Runtime.enable", {}); } catch {}
    try { await cdpCall(env, target.wsUrl, "Page.enable", {}); } catch {}
    const expr = buildDomPerceptionExpression();
    const out = await cdpCall(env, target.wsUrl, "Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: false,
    });
    const value = out && out.result ? out.result.value : null;
    if (value && typeof value === "object" && value.mode === "dom") {
      return {
        ok: true,
        mode: "dom",
        url: String(value.url || url),
        markdown: String(value.markdown || ""),
        text: String(value.text || value.markdown || ""),
      };
    }
  } catch (e) {
    log(`[perception] dom mode failed: ${e && e.message ? e.message : e}`);
  }
  return null;
}

async function uiaPerceptionResult(env, log) {
  if (!isWin()) return null;
  try {
    const lines = [
      `Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes`,
      `Add-Type @'`,
      `using System;`,
      `using System.Runtime.InteropServices;`,
      `public static class CloudDevUia {`,
      `  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();`,
      `}`,
      `'@`,
      `$root = [System.Windows.Automation.AutomationElement]::FromHandle([CloudDevUia]::GetForegroundWindow())`,
      `if (-not $root) { return "" }`,
      `$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker`,
      `$out = New-Object System.Collections.Generic.List[string]`,
      `function Walk([System.Windows.Automation.AutomationElement] $el, [int] $depth) {`,
      `  if (-not $el -or $depth -gt 6) { return }`,
      `  try {`,
      `    $name = ($el.Current.Name | ForEach-Object { "$_".Trim() })`,
      `    $type = $el.Current.ControlType.LocalizedControlType`,
      `    $indent = ("  " * $depth)`,
      `    $line = "$indent- $type$((if ($name) { ' ' + $name } else { '' }))"`,
      `    if ($line.Trim()) { [void]$out.Add($line.TrimEnd()) }`,
      `    $child = $walker.GetFirstChild($el)`,
      `    while ($child) { Walk $child ($depth + 1); $child = $walker.GetNextSibling($child) }`,
      `  } catch { }`,
      `}`,
      `Walk $root 0`,
      `($out -join [Environment]::NewLine)`,
    ];
    const r = await winRun(env, lines, 12000);
    const md = String(r.stdout || "").trim();
    if (!md) return null;
    return { ok: true, mode: "uia", markdown: md, text: md };
  } catch (e) {
    log(`[perception] uia mode failed: ${e && e.message ? e.message : e}`);
    return null;
  }
}

async function perceptionResult(env, log) {
  const dom = await domPerceptionResult(env, log);
  if (dom) return dom;
  const uia = await uiaPerceptionResult(env, log);
  if (uia) return uia;
  const shot = await captureFull(env, null);
  if (shot.error) {
    return { ok: false, mode: "screenshot", error: shot.error, note: "no DOM/UIA perception available; returning screenshot" };
  }
  return {
    ok: true,
    mode: "screenshot",
    image: shot.image,
    format: shot.format,
    note: "no DOM/UIA perception available; returning screenshot",
  };
}

async function dispatchAction(env, body, log) {
  const action = String(body.action || "").trim();
  const normalized = {
    click: "left_click",
    move: "mouse_move",
    key: "key",
    type: "type",
    screenshot: "screenshot",
    resolution: "resolution",
    perception: "perception",
  }[action] || action;
  switch (normalized) {
    case "mouse_move":
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
    case "left_click_drag":
    case "left_mouse_down":
    case "left_mouse_up":
    case "scroll":
      return doMouseAction(env, normalized, body);
    case "key":
      return doKeyAction(env, "key", body);
    case "type":
      return doType(env, body.text);
    case "hold_key":
      return doKeyAction(env, "hold_key", body);
    case "wait":
      return doWait(body);
    case "cursor_position":
      return doCursorPosition(env);
    case "screenshot":
      return doScreenshot(env, log);
    case "zoom":
      return doZoom(env, body, log);
    case "read_dom":
      return readDomResult(env, log);
    case "perception":
      return perceptionResult(env, log);
    case "resolution":
      return doResolution(env);
    default:
      return { error: `unknown action: ${action}` };
  }
}

async function handleComputerUse(body, env) {
  const actions = normalizeActions(body);
  const log = typeof env.log === "function" ? env.log : (() => {});
  if (!actions.length) return { error: "action required" };

  let last = { ok: true };
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const result = await dispatchAction(env, action, log);
    if (result && result.error) return result;
    last = result || last;
    if (result && (result.image || result.dom || action.action === "read_dom" || action.action === "screenshot" || action.action === "zoom" || action.action === "perception")) return result;
  }
  return last;
}

module.exports = { handleComputerUse };
