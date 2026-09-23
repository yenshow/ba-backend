/**
 * 在本機直接啟動 MediaMTX（開發用）
 * 可執行檔：mediamtx/bin/mediamtx(.exe)
 * 出貨：WinSW `{Product}-MediaMTX` → 本腳本；開發：`npm run mediamtx`
 */
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const {
  getMediamtxDir,
  getMediamtxGeneratedConfigPath,
} = require("../src/utils/baDataPaths");
const { generateMediaMtxConfig } = require("./generate-mediamtx-config");

const mediamtxDir = getMediamtxDir();
const generatedConfigPath = getMediamtxGeneratedConfigPath();
const binPath = path.join(
  mediamtxDir,
  "bin",
  process.platform === "win32" ? "mediamtx.exe" : "mediamtx",
);

const main = async () => {
  if (!fs.existsSync(binPath)) {
    console.error(`找不到 MediaMTX 可執行檔: ${binPath}`);
    console.error("請從 https://github.com/bluenviron/mediamtx/releases 下載並解壓至 mediamtx/bin/");
    console.error("出貨環境請確認 WinSW MediaMTX 服務與 mediamtx/bin 是否就緒");
    process.exit(1);
  }

  try {
    await generateMediaMtxConfig();
  } catch (err) {
    console.error("產生 mediamtx.generated.yml 失敗，無法啟動 MediaMTX");
    console.error(err?.message || err);
    process.exit(1);
  }

  // 設定已寫入檔案。關掉連線池，避免 PostgreSQL 重啟時閒置連線打掛這個包裝行程。
  try {
    const db = require("../src/database/db");
    await db.close();
  } catch (closeErr) {
    console.error(closeErr?.message || closeErr);
  }

  fs.mkdirSync(path.join(mediamtxDir, "logs"), { recursive: true });

  const child = spawn(binPath, [generatedConfigPath], {
    cwd: mediamtxDir,
    stdio: "inherit",
    windowsHide: true,
  });

  let stopRequested = false;

  const requestStop = (signal) => {
    stopRequested = true;
    child.kill(signal);
  };

  child.on("error", (err) => {
    console.error("啟動 MediaMTX 失敗:", err.message);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (
      stopRequested ||
      signal === "SIGINT" ||
      signal === "SIGTERM"
    ) {
      process.exit(0);
    }
    if (code !== null && code !== 0) process.exit(code);
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));
};

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
