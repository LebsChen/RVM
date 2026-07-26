"use strict";

const fs = require("fs");
const path = require("path");

const MAX_EVENTS = 2000;
const MAX_DETAILS = 2048;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

let dataDir = __dirname;
let filePath = path.join(dataDir, "worklog.jsonl");
let sequencePath = path.join(dataDir, "worklog.seq");
let events = [];
let nextId = 1;

function configure(dir) {
  dataDir = dir || __dirname;
  filePath = path.join(dataDir, "worklog.jsonl");
  sequencePath = path.join(dataDir, "worklog.seq");
  events = [];
  nextId = 1;
  load();
}

function load() {
  let persistedNextId = 1;
  try {
    persistedNextId = Math.max(Number(fs.readFileSync(sequencePath, "utf8")) || 1, 1);
  } catch { /* first run or unavailable storage */ }
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(-MAX_EVENTS)) {
      try {
        const event = JSON.parse(line);
        if (event && typeof event.id === "string" && typeof event.ts === "number") events.push(event);
      } catch { /* skip malformed lines */ }
    }
    const last = events.at(-1);
    if (last) persistedNextId = Math.max(
      persistedNextId,
      ...events.map((event) => (Number(event.id) || 0) + 1),
    );
  } catch { /* first run or unavailable storage */ }
  nextId = persistedNextId;
}

function redact(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/\bcog_[A-Za-z0-9._-]+\b/g, "cog_[REDACTED]")
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+\b/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_=-]+\b/gi, "[REDACTED]")
    .replace(/((?:authorization|token|password|secret|api[_-]?key|credential|cookie)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]");
}

function safeDetails(value) {
  if (value == null) return undefined;
  if (typeof value === "string") return redact(value).slice(0, MAX_DETAILS);
  if (Array.isArray(value)) return value.map(safeDetails);
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/(authorization|token|password|secret|api[_-]?key|credential|cookie)/i.test(key)) continue;
      out[key] = safeDetails(item);
    }
    return out;
  }
  return value;
}

function trimFileIfNeeded() {
  try {
    if (fs.statSync(filePath).size > MAX_FILE_BYTES) {
      fs.renameSync(filePath, `${filePath}.1`);
    }
  } catch { /* best effort persistence */ }
}

function record(type, category, title, details) {
  const event = {
    id: String(nextId++),
    ts: Date.now(),
    type: String(type || "status_change"),
    category: String(category || "agent"),
    title: redact(String(title || "")).slice(0, 500),
  };
  const safe = safeDetails(details);
  if (safe !== undefined) {
    const serialized = JSON.stringify(safe);
    event.details = serialized.length > MAX_DETAILS
      ? serialized.slice(0, MAX_DETAILS)
      : safe;
  }
  events.push(event);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(sequencePath, String(nextId), "utf8");
    trimFileIfNeeded();
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
  } catch { /* worklog persistence must never break an operation */ }
  return event;
}

function query(afterId, limit) {
  const after = Number(afterId) || 0;
  const count = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const result = events.filter((event) => (Number(event.id) || 0) > after).slice(0, count);
  return { events: result, last_id: result.at(-1)?.id || (events.at(-1)?.id || String(after)) };
}

function clear() {
  events = [];
  try { fs.rmSync(filePath, { force: true }); } catch { /* best effort */ }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(sequencePath, String(nextId), "utf8");
  } catch { /* best effort persistence */ }
  return { ok: true };
}

async function handleRoute(route, method, body) {
  if (method !== "POST") return { status: 405, body: { error: "worklog endpoint only accepts POST" } };
  const sub = route.replace("/api/worklog/", "");
  if (sub === "query") return { status: 200, body: query(body?.after_id, body?.limit) };
  if (sub === "clear") return { status: 200, body: clear() };
  return { status: 404, body: { error: `unknown worklog route: ${sub}` } };
}

configure(process.env.CONN_DIR || __dirname);

module.exports = { configure, record, query, clear, handleRoute, redact };
