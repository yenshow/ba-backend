/**
 * 在本機直接啟動 MediaMTX（開發用）
 * 可執行檔：mediamtx/bin/mediamtx(.exe)
 * 出貨：WinSW `{Product}-MediaMTX` → 本腳本；開發：`npm run mediamtx`
 */
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const {
  getMediamtxDir,
  getMediamtxGeneratedConfigPath,
} = require("../src/utils/baDataPaths");

const rootDir = path.resolve(__dirname, "..");
const mediamtxDir = getMediamtxDir();
const generatedConfigPath = getMediamtxGeneratedConfigPath();
const binPath = path.join(
  mediamtxDir,
  "bin",
  process.platform === "win32" ? "mediamtx.exe" : "mediamtx",
);

if (!fs.existsSync(binPath)) {
  console.error(`找不到 MediaMTX 可執行檔: ${binPath}`);
  console.error("請從 https://github.com/bluenviron/mediamtx/releases 下載並解壓至 mediamtx/bin/");
  console.error("出貨環境請確認 WinSW MediaMTX 服務與 mediamtx/bin 是否就緒");
  process.exit(1);
}

const gen = spawnSync(
  process.execPath,
  [path.join(rootDir, "scripts", "generate-mediamtx-config.js")],
  { cwd: rootDir, stdio: "inherit", windowsHide: true, env: process.env },
);
if (gen.status !== 0) {
  console.error("產生 mediamtx.generated.yml 失敗，無法啟動 MediaMTX");
  process.exit(gen.status || 1);
}

fs.mkdirSync(path.join(mediamtxDir, "logs"), { recursive: true });

const child = spawn(binPath, [generatedConfigPath], {
  cwd: mediamtxDir,
  stdio: "inherit",
  windowsHide: true,
});

child.on("error", (err) => {
  console.error("啟動 MediaMTX 失敗:", err.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (code !== null && code !== 0) process.exit(code);
  if (signal) process.exit(1);
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
