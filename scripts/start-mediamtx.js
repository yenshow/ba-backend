/**
 * 在本機直接啟動 MediaMTX（開發用）
 * 可執行檔需放在 mediamtx/bin/mediamtx.exe（Windows）或 mediamtx/bin/mediamtx（Linux/macOS）
 * 正式環境建議用 PM2：從 ba-system 根目錄執行 pm2 start ecosystem.config.cjs --only ba-mediamtx
 */
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

const rootDir = path.resolve(__dirname, "..");
const mediamtxDir = path.join(rootDir, "mediamtx");
const configFile = "mediamtx.yml";

const isWindows = process.platform === "win32";
const exeName = isWindows ? "mediamtx.exe" : "mediamtx";
const binPath = path.join(mediamtxDir, "bin", exeName);

if (!fs.existsSync(binPath)) {
  console.error(`找不到 MediaMTX 可執行檔: ${binPath}`);
  console.error("請從 https://github.com/bluenviron/mediamtx/releases 下載並解壓至 mediamtx/bin/");
  console.error("或從 ba-system 根目錄執行: pm2 start ecosystem.config.cjs --only ba-mediamtx");
  process.exit(1);
}

const child = spawn(binPath, [configFile], {
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

process.on("SIGINT", () => {
  child.kill("SIGINT");
});
process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});
