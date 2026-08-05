/**
 * 在本機直接啟動 MediaMTX（開發用）
 * 可執行檔需放在 mediamtx/bin/mediamtx.exe（Windows）或 mediamtx/bin/mediamtx（Linux/macOS）
 * 出貨由 WinSW `{Product}-MediaMTX` 服務啟動本腳本；本機開發：`npm run mediamtx`
 */
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const {
  getMediamtxDir,
  getMediamtxGeneratedConfigPath,
} = require("../src/utils/baDataPaths");

const rootDir = path.resolve(__dirname, "..");
const mediamtxDir = getMediamtxDir();
const generatedConfigPath = getMediamtxGeneratedConfigPath();

const isWindows = process.platform === "win32";
const exeName = isWindows ? "mediamtx.exe" : "mediamtx";
const binPath = path.join(mediamtxDir, "bin", exeName);

if (!fs.existsSync(binPath)) {
  console.error(`找不到 MediaMTX 可執行檔: ${binPath}`);
  console.error("請從 https://github.com/bluenviron/mediamtx/releases 下載並解壓至 mediamtx/bin/");
  console.error("出貨環境請確認 WinSW MediaMTX 服務與 mediamtx/bin 是否就緒");
  process.exit(1);
}

// 統一作法：啟動前一律由 DB 產生完整設定檔
try {
  // eslint-disable-next-line global-require
  const { spawnSync } = require("child_process");
  const generatorPath = path.join(rootDir, "scripts", "generate-mediamtx-config.js");
  const res = spawnSync(process.execPath, [generatorPath], {
    cwd: rootDir,
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  if (res.status !== 0) {
    console.error("產生 mediamtx.generated.yml 失敗，無法啟動 MediaMTX");
    process.exit(res.status || 1);
  }
} catch (e) {
  console.error("產生 mediamtx.generated.yml 失敗:", e?.message || e);
  process.exit(1);
}

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

process.on("SIGINT", () => {
  child.kill("SIGINT");
});
process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});
