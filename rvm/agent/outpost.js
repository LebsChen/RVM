#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const API_URL = normalizeApiUrl(process.env.DEVIN_API_URL || "https://api.devin.ai");
const TOKEN = String(process.env.DEVIN_OUTPOSTS_TOKEN || "").trim();
const OUTPOST_ID = String(process.env.OUTPOST_ID || "").trim();
const WORKDIR = String(process.env.RVM_OUTPOST_WORKDIR || "").trim();
const GATEWAY_FALLBACK = String(process.env.DEVIN_OUTPOST_GATEWAY_URL || "").trim();
const POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 600000;
const REMOTE_BASE_URL = "https://static.devin.ai/devin-rs/remote";
const RVM_ROOT = path.join(os.homedir(), ".rvm", "devin-remote");
const CACHE_ROOT = path.join(RVM_ROOT);
const SESSION_ROOT = path.join(RVM_ROOT, "sessions");
const ACCEPTOR_PATH = path.join(RVM_ROOT, "acceptor_id");
const children = new Map();
const heldClaims = new Set();
let stopping = false;
let loopRunning = false;

function normalizeApiUrl(value) {
  let url = String(value).trim().replace(/\/+$/, "");
  if (url.endsWith("/opbeta")) url = url.slice(0, -"/opbeta".length);
  return url;
}

function log(message) {
  process.stdout.write(`[outpost] ${message}\n`);
}

function warn(message) {
  process.stderr.write(`[outpost] ${message}\n`);
}

function redactSecret(text, secret) {
  return secret ? text.replaceAll(secret, "***") : text;
}

function safeError(error) {
  const message = error && error.message ? error.message : String(error);
  return redactSecret(message, TOKEN)
    .replace(/cog_[A-Za-z0-9._-]+/g, "cog_***")
    .replace(/connect[_-]?token[=:]\s*[^\s,}"']+/gi, "connect_token=***");
}

function redactOutput(value, connectToken) {
  return redactSecret(redactSecret(String(value), TOKEN), connectToken)
    .replace(/cog_[A-Za-z0-9._-]+/g, "cog_***")
    .replace(/connect[_-]?token[=:]\s*[^\s,}"']+/gi, "connect_token=***");
}

function safeSessionId(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "session";
}

function getValue(object, ...names) {
  if (!object || typeof object !== "object") return undefined;
  for (const name of names) {
    if (object[name] !== undefined && object[name] !== null) return object[name];
  }
  return undefined;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function itemArray(payload) {
  if (Array.isArray(payload)) return payload;
  const raw = objectValue(payload);
  for (const key of ["items", "devins", "data", "results"]) {
    const value = raw[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = itemArray(value);
      if (nested) return nested;
    }
  }
  return null;
}

function unwrapPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  for (const key of ["item", "devin", "data", "result"]) {
    if (payload[key] && typeof payload[key] === "object") return payload[key];
  }
  return payload;
}

function parseEntry(payload) {
  const raw = objectValue(unwrapPayload(payload));
  const metadata = objectValue(raw.metadata);
  const spec = objectValue(raw.spec);
  const status = objectValue(raw.status);
  return {
    raw,
    metadata,
    spec,
    status,
    sessionId: String(getValue(metadata, "session_id", "sessionId", "id")
      ?? getValue(raw, "session_id", "sessionId", "id") ?? ""),
    platform: String(getValue(spec, "platform") ?? getValue(raw, "platform") ?? ""),
    remoteSha: String(getValue(spec, "remote_binary_sha", "remoteBinarySha")
      ?? getValue(raw, "remote_binary_sha", "remoteBinarySha") ?? ""),
    phase: String(getValue(status, "phase") ?? getValue(raw, "phase") ?? ""),
    sessionStatus: String(getValue(status, "session_status", "sessionStatus")
      ?? getValue(raw, "session_status", "sessionStatus") ?? ""),
    gatewayUrl: String(getValue(status, "gateway_url", "gatewayUrl")
      ?? getValue(raw, "gateway_url", "gatewayUrl") ?? ""),
    connectToken: String(getValue(status, "connect_token", "connectToken")
      ?? getValue(raw, "connect_token", "connectToken") ?? ""),
    acceptorId: String(getValue(status, "acceptor_id", "acceptorId")
      ?? getValue(raw, "acceptor_id", "acceptorId") ?? ""),
    claimDeadline: getValue(status, "claim_deadline", "claimDeadline")
      ?? getValue(raw, "claim_deadline", "claimDeadline"),
  };
}

async function request(method, endpoint, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}/opbeta${endpoint}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${TOKEN}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`queue API returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return {};
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function listEntries(params) {
  const query = new URLSearchParams(params);
  const payload = await request("GET", `/outposts/devins?${query}`);
  const items = itemArray(payload);
  return items ? items.map(parseEntry) : [];
}

async function getEntry(sessionId) {
  try {
    return parseEntry(await request("GET", `/outposts/devins/${encodeURIComponent(sessionId)}`));
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function claim(sessionId) {
  const payload = await request("POST", `/outposts/devins/${encodeURIComponent(sessionId)}/claim`, {
    body: { acceptor_id: await acceptorId() },
  });
  heldClaims.add(sessionId);
  const entry = parseEntry(payload);
  const raw = objectValue(unwrapPayload(payload));
  const status = objectValue(raw.status);
  return {
    entry,
    gatewayUrl: String(getValue(status, "gateway_url", "gatewayUrl")
      ?? getValue(raw, "gateway_url", "gatewayUrl") ?? GATEWAY_FALLBACK),
    connectToken: String(getValue(status, "connect_token", "connectToken")
      ?? getValue(raw, "connect_token", "connectToken") ?? ""),
  };
}

async function release(sessionId) {
  await request("POST", `/outposts/devins/${encodeURIComponent(sessionId)}/release`, {
    body: { acceptor_id: await acceptorId() },
  });
}

async function acceptorId() {
  await fs.promises.mkdir(RVM_ROOT, { recursive: true });
  try {
    const existing = (await fs.promises.readFile(ACCEPTOR_PATH, "utf8")).trim();
    if (existing) return existing;
  } catch {}
  const generated = `rvm-${crypto.randomBytes(12).toString("hex")}`;
  try {
    await fs.promises.writeFile(ACCEPTOR_PATH, `${generated}\n`, { flag: "wx" });
    return generated;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return (await fs.promises.readFile(ACCEPTOR_PATH, "utf8")).trim();
  }
}

function remoteFilename(sha, platform) {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error("invalid remote binary SHA");
  if (platform === "windows") return `devin-remote_${sha}_windows_x64.exe`;
  if (platform === "linux") return `devin-remote_${sha}_linux_x64`;
  throw new Error(`unsupported Outpost platform: ${platform}`);
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function expectedChecksum(sha, url) {
  // A full 64-hex SHA from the trusted queue is authoritative; the CDN
  // sidecar checksum only guards transfer integrity for short prefixes.
  if (/^[0-9a-f]{64}$/i.test(sha)) return sha.toLowerCase();
  const checksumResponse = await fetchWithTimeout(`${url}.sha256`, REQUEST_TIMEOUT_MS);
  if (!checksumResponse.ok) {
    throw new Error(`checksum download returned HTTP ${checksumResponse.status}`);
  }
  const expected = (await checksumResponse.text()).match(/[0-9a-f]{64}/i)?.[0]?.toLowerCase();
  if (!expected) throw new Error("checksum response did not contain SHA-256");
  return expected;
}

async function downloadRemote(sha, platform) {
  const filename = remoteFilename(sha, platform);
  const directory = path.join(CACHE_ROOT, sha);
  const binary = path.join(directory, platform === "windows" ? "devin-remote.exe" : "devin-remote");
  await fs.promises.mkdir(directory, { recursive: true });
  const url = `${REMOTE_BASE_URL}/${filename}`;
  const partial = `${binary}.partial-${process.pid}`;
  try {
    const expected = await expectedChecksum(sha, url);
    if (await fileMatchesChecksum(binary, expected)) return binary;
    const response = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS);
    if (!response.ok || !response.body) throw new Error(`remote download returned HTTP ${response.status}`);
    const file = fs.createWriteStream(partial, { mode: 0o755 });
    try {
      await pipeline(Readable.fromWeb(response.body), file);
    } catch (error) {
      file.destroy();
      throw error;
    }
    const actual = await sha256File(partial);
    if (actual !== expected) throw new Error("downloaded devin-remote checksum mismatch");
    await fs.promises.rm(binary, { force: true });
    await fs.promises.rename(partial, binary);
    if (platform !== "windows") await fs.promises.chmod(binary, 0o755);
    return binary;
  } catch (error) {
    await fs.promises.rm(partial, { force: true }).catch(() => {});
    throw new Error(`unable to cache devin-remote ${sha}: ${safeError(error)}`);
  }
}

async function fileMatchesChecksum(filePath, expected) {
  try {
    return (await sha256File(filePath)) === expected;
  } catch {
    return false;
  }
}

function prependPath(prefixes, separator, current) {
  const values = [];
  for (const prefix of prefixes) {
    if (!prefix || values.some((value) => value.toLowerCase() === prefix.toLowerCase())
      || current.split(separator).some((value) => value.toLowerCase() === prefix.toLowerCase())) continue;
    try {
      if (fs.existsSync(prefix) && fs.statSync(prefix).isDirectory()) values.push(prefix);
    } catch {}
  }
  return values.concat(current ? [current] : []).join(separator);
}

function windowsEnvironment(sessionId, gatewayUrl, connectToken, stateDir) {
  const env = { ...process.env };
  const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
  const systemDrive = env.SystemDrive || (systemRoot.match(/^[A-Za-z]:/)?.[0] || "C:");
  const userProfile = env.USERPROFILE || env.HOME || os.homedir();
  const programFiles = env.ProgramFiles || `${systemDrive}\\Program Files`;
  const pathValue = prependPath([
    path.join(os.homedir(), ".rvm", "git", "usr", "bin"),
    path.join(os.homedir(), ".rvm", "git", "mingw64", "bin"),
    path.join(os.homedir(), ".rvm", "git", "cmd"),
    `${systemRoot}\\System32`,
  ], ";", env.PATH || "");
  Object.assign(env, {
    SystemRoot: systemRoot,
    WINDIR: env.WINDIR || systemRoot,
    SystemDrive: systemDrive,
    ComSpec: env.ComSpec || `${systemRoot}\\System32\\cmd.exe`,
    PATHEXT: env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
    ProgramFiles: programFiles,
    ProgramW6432: env.ProgramW6432 || programFiles,
    "ProgramFiles(x86)": env["ProgramFiles(x86)"] || `${systemDrive}\\Program Files (x86)`,
    ProgramData: env.ProgramData || `${systemDrive}\\ProgramData`,
    ALLUSERSPROFILE: env.ALLUSERSPROFILE || env.ProgramData || `${systemDrive}\\ProgramData`,
    HOME: env.HOME || userProfile,
    USERPROFILE: userProfile,
    LOCALAPPDATA: env.LOCALAPPDATA || path.join(userProfile, "AppData", "Local"),
    APPDATA: env.APPDATA || path.join(userProfile, "AppData", "Roaming"),
    TEMP: env.TEMP || env.TMP || `${systemRoot}\\Temp`,
    TMP: env.TMP || env.TEMP || `${systemRoot}\\Temp`,
    LANG: env.LANG || "C.UTF-8",
    TZ: env.TZ || "UTC",
    PATH: pathValue,
  });
  return addRemoteEnvironment(env, sessionId, gatewayUrl, connectToken, stateDir);
}

function linuxEnvironment(sessionId, gatewayUrl, connectToken, stateDir) {
  const env = { ...process.env };
  env.PATH = env.PATH || "/usr/local/bin:/usr/bin:/bin";
  env.HOME = env.HOME || os.homedir();
  env.USER = env.USER || os.userInfo().username;
  env.LOGNAME = env.LOGNAME || env.USER;
  env.TMPDIR = env.TMPDIR || "/tmp";
  env.LANG = env.LANG || "C.UTF-8";
  env.TZ = env.TZ || "UTC";
  env.DISPLAY = env.DISPLAY || ":0";
  env.XAUTHORITY = env.XAUTHORITY || path.join(env.HOME, ".Xauthority");
  return addRemoteEnvironment(env, sessionId, gatewayUrl, connectToken, stateDir);
}

function addRemoteEnvironment(env, sessionId, gatewayUrl, connectToken, stateDir) {
  Object.assign(env, {
    DEVIN_OUTPOST_GATEWAY_URL: gatewayUrl,
    DEVIN_OUTPOST_CONNECT_TOKEN: connectToken,
    DEVIN_OUTPOST_SESSION_ID: sessionId,
    DEVIN_REMOTE_STATE_DIR: stateDir,
    DEVIN_OUTPOST_DESKTOP: "true",
  });
  const chrome = process.env.DEVIN_CHROME_PATH || process.env.CHROME_PATH;
  if (chrome) env.DEVIN_CHROME_PATH = chrome;
  return env;
}

async function startSession(entry, claimed) {
  const sessionId = entry.sessionId;
  if (!sessionId || children.has(sessionId)) return;
  if (!entry.remoteSha || !entry.platform) {
    warn(`Skipping session ${sessionId}: missing platform or remote SHA`);
    if (claimed) await safeRelease(sessionId);
    return;
  }
  const hostPlatform = process.platform === "win32" ? "windows" : "linux";
  if (entry.platform.toLowerCase() !== hostPlatform) return;
  let claimResult = null;
  try {
    if (!claimed) {
      claimResult = await claim(sessionId);
      entry = { ...entry, ...claimResult.entry, status: claimResult.entry.status || entry.status };
    } else {
      const current = await getEntry(sessionId);
      if (current) entry = current;
      claimResult = {
        gatewayUrl: entry.gatewayUrl || GATEWAY_FALLBACK,
        connectToken: entry.connectToken,
      };
    }
    const gatewayUrl = claimResult.gatewayUrl || GATEWAY_FALLBACK;
    const connectToken = claimResult.connectToken;
    if (!gatewayUrl || !connectToken) throw new Error("claim response omitted gateway URL or connect token");
    const binary = await downloadRemote(entry.remoteSha, hostPlatform);
    const stateDir = path.join(SESSION_ROOT, safeSessionId(sessionId), "state");
    await fs.promises.mkdir(stateDir, { recursive: true });
    const cwd = WORKDIR || process.cwd();
    const env = hostPlatform === "windows"
      ? windowsEnvironment(sessionId, gatewayUrl, connectToken, stateDir)
      : linuxEnvironment(sessionId, gatewayUrl, connectToken, stateDir);
    const child = spawn(binary, ["serve"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.set(sessionId, { child, entry, claimed: true, connectToken });
    heldClaims.add(sessionId);
    child.stdout.on("data", (data) => {
      process.stdout.write(`[remote ${sessionId}] ${redactOutput(data.toString(), connectToken)}`);
    });
    child.stderr.on("data", (data) => {
      process.stderr.write(`[remote ${sessionId}] ${redactOutput(data.toString(), connectToken)}`);
    });
    child.once("error", (error) => warn(`devin-remote ${sessionId} failed: ${safeError(error)}`));
    child.once("exit", (code, signal) => {
      const current = children.get(sessionId);
      if (current) current.exited = true;
      log(`devin-remote exited for ${sessionId} (${code ?? signal ?? "unknown"})`);
    });
    log(`Serving session ${sessionId}`);
  } catch (error) {
    if (error.status === 409) {
      log(`Claim lost for session ${sessionId}`);
      return;
    }
    warn(`Failed to serve session ${sessionId}: ${safeError(error)}`);
    if (claimResult || claimed || heldClaims.has(sessionId)) await safeRelease(sessionId);
  }
}

async function safeRelease(sessionId) {
  try {
    await release(sessionId);
    heldClaims.delete(sessionId);
    log(`Released session ${sessionId}`);
  } catch (error) {
    warn(`Failed to release session ${sessionId}: ${safeError(error)}`);
  }
}

async function stopSession(sessionId, reason) {
  const record = children.get(sessionId);
  if (!record) return;
  children.delete(sessionId);
  await terminateChild(record.child);
  await safeRelease(sessionId);
  log(`Stopped session ${sessionId} (${reason})`);
}

function terminateChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      killer.once("exit", () => resolve());
      killer.once("error", () => { try { child.kill(); } catch {} resolve(); });
      return;
    }
    try { child.kill("SIGTERM"); } catch {}
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve();
    }, 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function supervise() {
  for (const [sessionId, record] of [...children]) {
    if (record.exited || record.child.exitCode !== null) {
      await stopSession(sessionId, "process exited");
      continue;
    }
    try {
      const entry = await getEntry(sessionId);
      if (!entry) {
        await stopSession(sessionId, "queue entry disappeared (suspended)");
      } else if (["suspended", "terminated"].includes(entry.sessionStatus.toLowerCase())) {
        await stopSession(sessionId, `session ${entry.sessionStatus}`);
      }
    } catch (error) {
      warn(`Status poll failed for ${sessionId}: ${safeError(error)}`);
    }
  }
}

async function reconcile() {
  const [pending, claimed] = await Promise.all([
    listEntries({ outpost: OUTPOST_ID, phase: "pending", first: "200" }),
    listEntries({ outpost: OUTPOST_ID, phase: "claimed", acceptor_id: await acceptorId(), first: "200" }),
  ]);
  for (const entry of claimed) await startSession(entry, true);
  for (const entry of pending) await startSession(entry, false);
  await supervise();
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`Stopping (${signal})`);
  for (const sessionId of [...children.keys()]) await stopSession(sessionId, "shutdown");
  for (const sessionId of [...heldClaims]) await safeRelease(sessionId);
  process.exit(0);
}

async function main() {
  if (!TOKEN || !OUTPOST_ID) throw new Error("DEVIN_OUTPOSTS_TOKEN and OUTPOST_ID are required");
  await fs.promises.mkdir(SESSION_ROOT, { recursive: true });
  log(`Started for outpost ${OUTPOST_ID} as ${await acceptorId()}`);
  while (!stopping) {
    if (!loopRunning) {
      loopRunning = true;
      try {
        await reconcile();
      } catch (error) {
        warn(`Reconcile failed: ${safeError(error)}`);
      } finally {
        loopRunning = false;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
// The RVM GUI closes our piped stdin to request a graceful shutdown
// (Windows has no SIGTERM delivery for hidden-console children).
process.stdin.resume();
process.stdin.once("end", () => void shutdown("stdin closed"));
process.stdin.once("close", () => void shutdown("stdin closed"));
process.once("uncaughtException", (error) => {
  warn(`Fatal error: ${safeError(error)}`);
  void shutdown("uncaughtException");
});
process.once("unhandledRejection", (error) => {
  warn(`Unhandled error: ${safeError(error)}`);
});

main().catch((error) => {
  warn(safeError(error));
  process.exitCode = 1;
});
