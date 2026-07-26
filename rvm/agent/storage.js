"use strict";
// Storage module — binary upload/download, file restore, scratchpad
// Maps to official devin-remote storage.rs

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const SCRATCHPAD_DIR = path.join(os.homedir(), ".rvm", "scratchpad");

function handleRoute(route, method, headers, body) {
  const sub = route.replace("/api/storage/", "");

  switch (sub) {
    case "upload": return handleUpload(headers, body);
    case "download": return handleDownload(body);
    case "restore": return handleRestore(body);
    case "delete-created": return handleDeleteCreated(body);
    case "recreate-deleted": return handleRecreateDeleted(body);
    case "stat": return handleStat(body);
    case "mkdir": return handleMkdir(body);
    case "rename": return handleRename(body);
    case "copy": return handleCopy(body);
    case "delete": return handleDelete(body);
    case "exists": return handleExists(body);
    case "hash": return handleHash(body);
    default:
      return { status: 404, body: { error: `unknown storage route: ${sub}` } };
  }
}

const MAX_UPLOAD_URL_BYTES = 200 * 1024 * 1024;
const MAX_UPLOAD_REDIRECTS = 5;

function downloadUrlToFile(rawUrl, filePath, redirects = 0) {
  let target;
  try { target = new URL(rawUrl); } catch { return Promise.reject(new Error("url must be a valid HTTP or HTTPS URL")); }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return Promise.reject(new Error("url must use http or https"));
  }
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.get(target, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_UPLOAD_REDIRECTS) {
          reject(new Error("too many redirects"));
          return;
        }
        const next = new URL(res.headers.location, target).toString();
        downloadUrlToFile(next, filePath, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`download failed with HTTP ${res.statusCode}`));
        return;
      }
      const announced = Number(res.headers["content-length"] || 0);
      if (announced > MAX_UPLOAD_URL_BYTES) {
        res.resume();
        reject(new Error("download too large (maximum 200MB)"));
        return;
      }
      const tempPath = `${filePath}.download-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
      const out = fs.createWriteStream(tempPath, { flags: "wx" });
      let bytes = 0;
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        out.destroy();
        try { fs.unlinkSync(tempPath); } catch {}
        reject(err);
      };
      out.on("error", fail);
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_UPLOAD_URL_BYTES) {
          res.destroy();
          fail(new Error("download too large (maximum 200MB)"));
          return;
        }
        if (!failed) out.write(chunk);
      });
      res.on("error", fail);
      res.on("end", () => {
        if (failed) return;
        out.end(() => {
          try {
            fs.renameSync(tempPath, filePath);
            resolve(bytes);
          } catch (e) {
            fail(e);
          }
        });
      });
    });
    req.on("error", reject);
  });
}

async function handleUpload(headers, body) {
  const { path: filePath, content, encoding, url } = body;
  if (!filePath) return { status: 400, body: { error: "path required" } };
  const hasContent = content !== undefined && content !== null;
  const hasUrl = url !== undefined && url !== null && String(url).trim() !== "";
  if (hasContent && hasUrl) return { status: 400, body: { error: "content and url are mutually exclusive" } };
  if (!hasContent && !hasUrl) return { status: 400, body: { error: "content or url required" } };
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (hasUrl) {
      const bytes = await downloadUrlToFile(String(url), filePath);
      return { status: 200, body: { ok: true, path: filePath, bytes, source: "url" } };
    }
    if (encoding === "base64") {
      const buf = Buffer.from(content, "base64");
      fs.writeFileSync(filePath, buf);
      return { status: 200, body: { ok: true, path: filePath, bytes: buf.length } };
    }
    fs.writeFileSync(filePath, content || "", "utf8");
    return { status: 200, body: { ok: true, path: filePath, bytes: Buffer.byteLength(content || "") } };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

function handleDownload(body) {
  const { path: filePath, encoding } = body;
  if (!filePath) return { status: 400, body: { error: "path required" } };
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 50 * 1024 * 1024) {
      return { status: 413, body: { error: "file too large (>50MB)" } };
    }
    if (encoding === "base64") {
      const buf = fs.readFileSync(filePath);
      return { status: 200, body: { path: filePath, content: buf.toString("base64"), encoding: "base64", size: stat.size } };
    }
    const content = fs.readFileSync(filePath, "utf8");
    return { status: 200, body: { path: filePath, content, size: stat.size } };
  } catch (e) {
    return { status: 404, body: { error: String(e.message || e) } };
  }
}

function handleRestore(body) {
  const { path: filePath, content, encoding } = body;
  if (!filePath) return { status: 400, body: { error: "path required" } };
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (encoding === "base64") {
      fs.writeFileSync(filePath, Buffer.from(content, "base64"));
    } else {
      fs.writeFileSync(filePath, content || "", "utf8");
    }
    return { status: 200, body: { ok: true, restored: filePath } };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

function handleDeleteCreated(body) {
  const { path: filePath } = body;
  if (!filePath) return { status: 400, body: { error: "path required" } };
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
      }
    }
    return { status: 200, body: { ok: true, deleted: filePath } };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

function handleRecreateDeleted(body) {
  const { path: filePath, content, encoding, is_dir } = body;
  if (!filePath) return { status: 400, body: { error: "path required" } };
  try {
    if (is_dir) {
      fs.mkdirSync(filePath, { recursive: true });
    } else {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (encoding === "base64") {
        fs.writeFileSync(filePath, Buffer.from(content || "", "base64"));
      } else {
        fs.writeFileSync(filePath, content || "", "utf8");
      }
    }
    return { status: 200, body: { ok: true, recreated: filePath } };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

function handleStat(body) {
  const { path: filePath } = body;
  if (!filePath) return { status: 400, body: { error: "path required" } };
  try {
    const stat = fs.statSync(filePath);
    return {
      status: 200,
      body: {
        path: filePath,
        size: stat.size,
        isFile: stat.isFile(),
        isDir: stat.isDirectory(),
        isSymlink: stat.isSymbolicLink(),
        mode: stat.mode,
        mtime: stat.mtime.toISOString(),
        ctime: stat.ctime.toISOString(),
      },
    };
  } catch (e) {
    return { status: 404, body: { error: String(e.message || e) } };
  }
}

function handleMkdir(body) {
  const { path: dirPath } = body;
  if (!dirPath) return { status: 400, body: { error: "path required" } };
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return { status: 200, body: { ok: true, path: dirPath } };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

function handleRename(body) {
  const { from, to } = body;
  if (!from || !to) return { status: 400, body: { error: "from and to required" } };
  try {
    const toDir = path.dirname(to);
    if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
    fs.renameSync(from, to);
    return { status: 200, body: { ok: true, from, to } };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

function handleCopy(body) {
  const { from, to } = body;
  if (!from || !to) return { status: 400, body: { error: "from and to required" } };
  try {
    const toDir = path.dirname(to);
    if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
    fs.copyFileSync(from, to);
    return { status: 200, body: { ok: true, from, to } };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

function handleDelete(body) {
  const { path: filePath, recursive } = body;
  if (!filePath) return { status: 400, body: { error: "path required" } };
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        fs.rmSync(filePath, { recursive: recursive !== false, force: true });
      } else {
        fs.unlinkSync(filePath);
      }
    }
    return { status: 200, body: { ok: true, deleted: filePath } };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

function handleExists(body) {
  const { path: filePath } = body;
  if (!filePath) return { status: 400, body: { error: "path required" } };
  return { status: 200, body: { path: filePath, exists: fs.existsSync(filePath) } };
}

function handleHash(body) {
  const { path: filePath, algorithm } = body;
  if (!filePath) return { status: 400, body: { error: "path required" } };
  try {
    const algo = algorithm || "sha256";
    const hash = crypto.createHash(algo);
    const data = fs.readFileSync(filePath);
    hash.update(data);
    return { status: 200, body: { path: filePath, algorithm: algo, hash: hash.digest("hex") } };
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

// ── Scratchpad ─────────────────────────────────────────────────────────────

function handleScratchpad(route, method, body) {
  const sub = route.replace("/api/scratchpad/", "");

  if (sub === "write" && method === "POST") {
    const { key, content, encoding } = body;
    if (!key) return { status: 400, body: { error: "key required" } };
    try {
      if (!fs.existsSync(SCRATCHPAD_DIR)) fs.mkdirSync(SCRATCHPAD_DIR, { recursive: true });
      const fp = path.join(SCRATCHPAD_DIR, key);
      if (encoding === "base64") {
        fs.writeFileSync(fp, Buffer.from(content || "", "base64"));
      } else {
        fs.writeFileSync(fp, content || "", "utf8");
      }
      return { status: 200, body: { ok: true, key } };
    } catch (e) {
      return { status: 500, body: { error: String(e.message || e) } };
    }
  }

  if (sub === "read" && method === "POST") {
    const { key, encoding } = body;
    if (!key) return { status: 400, body: { error: "key required" } };
    try {
      const fp = path.join(SCRATCHPAD_DIR, key);
      if (!fs.existsSync(fp)) return { status: 404, body: { error: "key not found" } };
      if (encoding === "base64") {
        return { status: 200, body: { key, content: fs.readFileSync(fp).toString("base64"), encoding: "base64" } };
      }
      return { status: 200, body: { key, content: fs.readFileSync(fp, "utf8") } };
    } catch (e) {
      return { status: 500, body: { error: String(e.message || e) } };
    }
  }

  if (sub === "list") {
    try {
      if (!fs.existsSync(SCRATCHPAD_DIR)) return { status: 200, body: { keys: [] } };
      const keys = fs.readdirSync(SCRATCHPAD_DIR);
      return { status: 200, body: { keys } };
    } catch (e) {
      return { status: 500, body: { error: String(e.message || e) } };
    }
  }

  if (sub === "delete" && method === "POST") {
    const { key } = body;
    if (!key) return { status: 400, body: { error: "key required" } };
    try {
      const fp = path.join(SCRATCHPAD_DIR, key);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      return { status: 200, body: { ok: true, deleted: key } };
    } catch (e) {
      return { status: 500, body: { error: String(e.message || e) } };
    }
  }

  return { status: 404, body: { error: `unknown scratchpad route: ${sub}` } };
}

module.exports = { handleRoute, handleUpload, handleDownload, handleScratchpad };
