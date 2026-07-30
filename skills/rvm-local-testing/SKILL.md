---
name: rvm-local-testing
description: How to run and verify the RVM desktop app + agent end-to-end on a Linux box with a real X display (:0) — driving the Tauri GUI, checking /health, the Web IDE, noVNC, and simulating missing-capability failures.
---

# Testing the RVM app/agent on a real Linux desktop

Use this when verifying changes to `rvm/agent/*.js` or the Tauri GUI on a machine where the
packaged app (deb) is already installed and running.

## Where things live

| Thing | Path / value |
|---|---|
| Deployed agent JS | `/usr/lib/RVM/_up_/agent/*.js` |
| Bundled Node (often the only Node) | `/home/ctyun/.rvm/node/bin/node` |
| Agent config | `~/.rvm/config.json` (port, token, `vnc_password`, `auto_install`, tunnel settings) |
| Live agent info | `~/.rvm/conn.json` (pid, token, port, `idePort`, `vncPort`, `capabilityStatus`) |
| Default ports | agent HTTP `9876`, code-server/serve-web `9877`, VNC `5900` |

Deploy a source change without rebuilding the deb:
`sudo cp rvm/agent/*.js /usr/lib/RVM/_up_/agent/` then restart the agent from the GUI.
Always confirm with `diff -q rvm/agent/X.js /usr/lib/RVM/_up_/agent/X.js` that the running
code is the code under test — the GUI/Rust side (`src-tauri`) cannot be updated this way and
needs a Rust toolchain to rebuild.

## Driving the GUI (no browser-automation tool needed)

The Devin `browser` tool may fail to initialize on these boxes. Use the desktop's own Firefox
on `DISPLAY=:0`; it also makes the screen recording self-explanatory.

```bash
export DISPLAY=:0
# window ids — note: parentheses in the title break xdotool's regex, search a prefix
for w in $(xdotool search --name "RVM"); do echo "$w -> $(xdotool getwindowname $w)"; done
xdotool windowsize <id> 1350 1330; xdotool windowmove <id> 40 40; xdotool windowactivate <id>

# Firefox
setsid firefox --new-window "http://127.0.0.1:9876/health" &
xdotool key ctrl+t; xdotool type --delay 20 "<url>"; xdotool key Return
# a maximized window can only be un-maximized with: xdotool windowactivate <id>; xdotool key super+Down

# screenshots (ImageMagick `import` is usually NOT installed)
ffmpeg -y -f x11grab -video_size 2560x1438 -i :0 -frames:v 1 shot.png -loglevel error
```

Clicking GUI buttons: take a screenshot, read the coordinates off it, and multiply by
`real_width / screenshot_width` (screenshots come back downscaled, e.g. 2560/1568 ≈ 1.633),
then `xdotool mousemove X Y click 1`.

GUI map (App.tsx): hero button toggles **Enable Remote Dev** / **Stop Remote Dev**; tabs are
Status / Configuration / Server / Capabilities / Logs / Outposts. A dead agent surfaces as red
text "Agent exited with code N" (produced in `src-tauri/src/lib.rs::get_agent_state`).
The **Logs** tab is the agent's stdout, kept only in memory and auto-scrolled to the tail —
early startup lines are effectively unreadable, so verify failure paths by their side effects
(process/dpkg/port state) rather than by log text.

## Endpoint checks

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.rvm/conn.json'))['token'])")
curl -s http://127.0.0.1:9876/health                      # status ok, vnc_port, ide_port
curl -s -X POST http://127.0.0.1:9876/api/exec-sync \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"cmd":"uname -n"}'                                  # no header ⇒ 401
```

- Web IDE: `http://127.0.0.1:9876/ide/?tkn=$TOKEN` (token also accepted as `?token=`).
  Sanity-check `ide_port` is **9877**, not the agent's own 9876 — the agent adopting its own
  port is a known failure mode that makes `/ide/` 502 and later makes the agent SIGKILL itself.
- noVNC: `http://127.0.0.1:9876/novnc/vnc.html?autoconnect=1&resize=scale&password=<vnc_password>&path=vnc-ws%3Ftoken%3D$TOKEN`
  The static page is unauthenticated; the `/vnc-ws` upgrade needs the token (query, Bearer, or
  `Sec-WebSocket-Protocol`). To prove the stream is live rather than a stale frame, minimize or
  move a window on `:0` and screenshot the canvas again.

## Simulating a missing optional capability (VNC)

`sudo dpkg -r --force-depends x11vnc` is reversible offline as long as
`/var/cache/apt/archives/x11vnc_*.deb` exists (check first with
`sudo apt-get install --reinstall -d -y x11vnc`); no other installed package depends on it.
Restart the agent from the GUI and expect: agent stays up, `/health` still 200, and — when
passwordless sudo is available — the agent re-installs x11vnc itself. Restore manually with
`sudo apt-get install -y x11vnc` if it does not.

## Gotchas

- `ps`/`pgrep -f "agent/agent.js"` also matches your own shell; take the pid from
  `/health` (`"pid"`) instead.
- The agent always spawns its own *quick* Cloudflare tunnel and ignores `cf_tunnel_token` /
  `public_url` in config.json; a working public hostname is usually served by a separate
  long-running `cloudflared tunnel run --token …` process. So a blank "Public URL" in the GUI
  does not mean the public endpoint is down — curl it.
- Stopping the agent can leave its `cloudflared` child orphaned; check `pgrep -a cloudflared`
  between runs.

## Devin Secrets Needed

None for local testing — the agent token comes from `~/.rvm/conn.json` on the box.
