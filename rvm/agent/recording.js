"use strict";
// Screen recording module — start/stop desktop recording
// Maps to official devin-remote RecordingStart/RecordingStop tool types

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

let recordingProc = null;
let recordingFile = null;

async function handleRoute(route, method, body) {
  const sub = route.replace("/api/recording/", "");

  switch (sub) {
    case "start": return startRecording(body);
    case "stop": return stopRecording(body);
    case "status": return getStatus();
    default:
      return { status: 404, body: { error: `unknown recording route: ${sub}` } };
  }
}

function startRecording(body) {
  if (recordingProc) {
    return { status: 409, body: { error: "Recording already in progress", file: recordingFile } };
  }

  const isWin = process.platform === "win32";
  const outDir = body.output_dir || path.join(os.homedir(), ".rvm", "recordings");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const fileName = `recording-${Date.now()}.mp4`;
  recordingFile = path.join(outDir, fileName);

  if (isWin) {
    // Use PowerShell to invoke Windows screen capture
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
$rec = [Windows.Forms.Screen]::PrimaryScreen.Bounds
# ffmpeg approach
ffmpeg -y -f gdigrab -framerate 10 -i desktop -t ${body.max_duration || 300} '${recordingFile.replace(/'/g, "''")}'
`;
    recordingProc = spawn("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore", windowsHide: true });
  } else {
    // Linux: use ffmpeg with x11grab
    const display = process.env.DISPLAY || ":0";
    recordingProc = spawn("ffmpeg", [
      "-y", "-f", "x11grab", "-framerate", "10",
      "-video_size", body.resolution || "1920x1080",
      "-i", display,
      "-t", String(body.max_duration || 300),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      recordingFile,
    ], { stdio: "ignore" });
  }

  recordingProc.on("exit", () => {
    recordingProc = null;
  });

  return { status: 200, body: { ok: true, file: recordingFile, pid: recordingProc.pid } };
}

function stopRecording() {
  if (!recordingProc) {
    return { status: 200, body: { ok: true, message: "No recording in progress" } };
  }

  try {
    // Send SIGINT (or 'q' for ffmpeg) to gracefully stop
    recordingProc.kill("SIGINT");
  } catch {}

  const file = recordingFile;
  recordingProc = null;
  recordingFile = null;

  // Wait a bit for file to finalize
  return { status: 200, body: { ok: true, file } };
}

function getStatus() {
  return {
    status: 200,
    body: {
      recording: !!recordingProc,
      file: recordingFile,
      pid: recordingProc ? recordingProc.pid : null,
    },
  };
}

function cleanup() {
  if (recordingProc) {
    try { recordingProc.kill("SIGINT"); } catch {}
    recordingProc = null;
  }
}

module.exports = { handleRoute, cleanup };
