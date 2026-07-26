"use strict";
// gh-mirror.js — optional GitHub download accelerator.
//
// When the user configures a "GitHub 加速地址" in the Server tab it is passed to
// the agent via the GITHUB_MIRROR env var. We use it to rewrite github.com /
// raw.githubusercontent.com / objects.githubusercontent.com download URLs so the
// binary/tarball downloads (cloudflared, noVNC, TightVNC, ...) go through the
// mirror instead of hitting GitHub directly.
//
// Supported mirror formats (auto-detected):
//   1. Prefix proxy (ghproxy style):   https://ghproxy.com/
//      -> https://ghproxy.com/https://github.com/owner/repo/...
//   2. Template with {url} placeholder: https://my.proxy/?target={url}
//      -> the whole original URL is substituted for {url} (URL-encoded).
//   3. Bare host / prefix without trailing slash: https://gh.example.com
//      -> treated as a prefix and joined with a single slash.
//
// SECURITY / TRUST BOUNDARY: some of the accelerated downloads are executables
// (cloudflared, TightVNC). We do not verify checksums/signatures of mirrored
// artifacts, so a configured mirror is fully trusted to serve authentic
// binaries. Only set GITHUB_MIRROR to a mirror you trust; leave it empty to
// download directly from GitHub.

// Default accelerator when GITHUB_MIRROR is unset. gh-proxy.com is a widely used
// prefix proxy; the Server UI pre-fills this value and it keeps behavior in sync
// with the noVNC/TightVNC retry mirror (which also default to gh-proxy.com).
const DEFAULT_MIRROR = "https://gh-proxy.com/";

function ghMirror(url) {
  const raw = process.env.GITHUB_MIRROR;
  // Unset env -> default mirror. Explicit empty string -> direct GitHub (opt-out).
  const m = (raw === undefined ? DEFAULT_MIRROR : String(raw)).trim();
  if (!m || typeof url !== "string") return url;
  if (!/^https?:\/\/(github\.com|[^/]*\.githubusercontent\.com)\//i.test(url)) {
    return url; // only rewrite GitHub-hosted URLs
  }
  // 2) explicit template
  if (m.includes("{url}")) {
    return m.replace("{url}", encodeURIComponent(url));
  }
  // 1) prefix proxy — mirror ends with a slash or clearly wraps the full URL
  //    e.g. https://ghproxy.com/ or https://mirror.ghproxy.com/
  if (/\/$/.test(m)) {
    return m + url;
  }
  // Heuristic: if it looks like a bare host (no path segment), treat as prefix.
  return m.replace(/\/+$/, "") + "/" + url;
}

module.exports = { ghMirror };
