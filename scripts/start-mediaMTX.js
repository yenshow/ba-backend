const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

/**
 * 啟動 MediaMTX 服務
 */

const MEDIAMTX_DIR = path.join(__dirname, "..", "mediamtx");
const MEDIAMTX_BIN = path.join(MEDIAMTX_DIR, "bin", process.platform === "win32" ? "mediamtx.exe" : "mediamtx");
const MEDIAMTX_CONFIG = path.join(MEDIAMTX_DIR, "mediamtx.yml");
const MEDIAMTX_PID_FILE = path.join(MEDIAMTX_DIR, "mediamtx.pid");
const MEDIAMTX_LOG_FILE = path.join(MEDIAMTX_DIR, "logs", "mediamtx.log");

function checkMediaMTXInstalled() {
  if (!fs.existsSync(MEDIAMTX_BIN)) {
    console.error("[MediaMTX] MediaMTX 未安裝");
    console.error(`[MediaMTX] 請先執行: npm run mediamtx:download`);
    process.exit(1);
  }
}

function checkMediaMTXRunning() {
  if (fs.existsSync(MEDIAMTX_PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(MEDIAMTX_PID_FILE, "utf8").trim(), 10);
      // 檢查進程是否存在
      try {
        process.kill(pid, 0); // 發送信號 0 檢查進程是否存在
        console.log(`[MediaMTX] MediaMTX 已在運行中 (PID: ${pid})`);
        return true;
      } catch (error) {
        // 進程不存在，刪除 PID 檔案
        fs.unlinkSync(MEDIAMTX_PID_FILE);
      }
    } catch (error) {
      // PID 檔案損壞，刪除它
      fs.unlinkSync(MEDIAMTX_PID_FILE);
    }
  }
  return false;
}

function ensureDirectories() {
  // 確保日誌目錄存在
  const logDir = path.dirname(MEDIAMTX_LOG_FILE);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // 確保配置檔案存在
  if (!fs.existsSync(MEDIAMTX_CONFIG)) {
    const defaultConfig = path.join(__dirname, "..", "mediamtx.yml");
    if (fs.existsSync(defaultConfig)) {
      fs.copyFileSync(defaultConfig, MEDIAMTX_CONFIG);
      console.log(`[MediaMTX] 已創建配置檔案: ${MEDIAMTX_CONFIG}`);
    } else {
      console.warn(`[MediaMTX] 配置檔案不存在: ${MEDIAMTX_CONFIG}`);
    }
  }
}

function startMediaMTX() {
  ensureDirectories();

  const logStream = fs.createWriteStream(MEDIAMTX_LOG_FILE, { flags: "a" });
  
  const args = [];
  if (fs.existsSync(MEDIAMTX_CONFIG)) {
    args.push(MEDIAMTX_CONFIG);
  }

  console.log(`[MediaMTX] 正在啟動 MediaMTX...`);
  console.log(`[MediaMTX] 執行檔: ${MEDIAMTX_BIN}`);
  console.log(`[MediaMTX] 配置檔: ${MEDIAMTX_CONFIG}`);
  console.log(`[MediaMTX] 日誌檔: ${MEDIAMTX_LOG_FILE}`);

  const mediamtx = spawn(MEDIAMTX_BIN, args, {
    cwd: MEDIAMTX_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // 保存 PID
  fs.writeFileSync(MEDIAMTX_PID_FILE, mediamtx.pid.toString());

  // 輸出處理
  mediamtx.stdout.on("data", (data) => {
    const message = data.toString();
    logStream.write(message);
    // 只顯示關鍵訊息
    if (message.includes("listener opened") || message.includes("error")) {
      process.stdout.write(`[MediaMTX] ${message}`);
    }
  });

  mediamtx.stderr.on("data", (data) => {
    const message = data.toString();
    logStream.write(message);
    process.stderr.write(`[MediaMTX] ${message}`);
  });

  mediamtx.on("error", (error) => {
    console.error(`[MediaMTX] 啟動失敗:`, error.message);
    fs.unlinkSync(MEDIAMTX_PID_FILE);
    process.exit(1);
  });

  mediamtx.on("exit", (code) => {
    console.log(`[MediaMTX] MediaMTX 已退出 (代碼: ${code})`);
    if (fs.existsSync(MEDIAMTX_PID_FILE)) {
      fs.unlinkSync(MEDIAMTX_PID_FILE);
    }
    logStream.end();
  });

  // 處理程序退出
  process.on("SIGINT", () => {
    console.log("\n[MediaMTX] 正在停止 MediaMTX...");
    mediamtx.kill("SIGTERM");
    setTimeout(() => {
      if (!mediamtx.killed) {
        mediamtx.kill("SIGKILL");
      }
      process.exit(0);
    }, 5000);
  });

  process.on("SIGTERM", () => {
    mediamtx.kill("SIGTERM");
    setTimeout(() => {
      if (!mediamtx.killed) {
        mediamtx.kill("SIGKILL");
      }
      process.exit(0);
    }, 5000);
  });

  console.log(`[MediaMTX] MediaMTX 已啟動 (PID: ${mediamtx.pid})`);
  console.log(`[MediaMTX] API 地址: http://localhost:9997`);
  console.log(`[MediaMTX] HLS 地址: http://localhost:8888`);
  console.log(`[MediaMTX] WebRTC 地址: http://localhost:8889`);
  console.log(`[MediaMTX] RTSP 地址: rtsp://localhost:8554`);
  console.log(`[MediaMTX] 按 Ctrl+C 停止服務`);

  // 保持進程運行（不要使用 unref，這樣 Node.js 會等待子進程）
  // mediamtx.unref(); // 移除這行，讓 Node.js 保持運行
  
  // 確保 Node.js 進程不會退出，等待 MediaMTX 進程
  // 在 Windows 上，我們需要保持事件循環運行
  // 由於我們已經監聽了 mediamtx 的 stdout/stderr，事件循環會自動保持運行
}

function main() {
  checkMediaMTXInstalled();

  if (checkMediaMTXRunning()) {
    process.exit(0);
  }

  startMediaMTX();
}

if (require.main === module) {
  main();
}

module.exports = { main, checkMediaMTXInstalled, checkMediaMTXRunning };

