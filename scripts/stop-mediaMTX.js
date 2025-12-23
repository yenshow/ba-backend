const path = require("path");
const fs = require("fs");

/**
 * 停止 MediaMTX 服務
 */

const MEDIAMTX_DIR = path.join(__dirname, "..", "mediamtx");
const MEDIAMTX_PID_FILE = path.join(MEDIAMTX_DIR, "mediamtx.pid");

function stopMediaMTX() {
  if (!fs.existsSync(MEDIAMTX_PID_FILE)) {
    console.log("[MediaMTX] MediaMTX 未運行");
    return;
  }

  try {
    const pid = parseInt(fs.readFileSync(MEDIAMTX_PID_FILE, "utf8").trim(), 10);
    
    console.log(`[MediaMTX] 正在停止 MediaMTX (PID: ${pid})...`);

    try {
      // 嘗試優雅停止
      process.kill(pid, "SIGTERM");
      
      // 等待進程結束
      let attempts = 0;
      const maxAttempts = 10;
      
      const checkInterval = setInterval(() => {
        attempts++;
        try {
          process.kill(pid, 0); // 檢查進程是否存在
          if (attempts >= maxAttempts) {
            // 強制終止
            console.log(`[MediaMTX] 強制終止 MediaMTX...`);
            process.kill(pid, "SIGKILL");
            clearInterval(checkInterval);
            cleanup();
          }
        } catch (error) {
          // 進程已結束
          clearInterval(checkInterval);
          cleanup();
        }
      }, 500);
      
    } catch (error) {
      if (error.code === "ESRCH") {
        // 進程不存在
        console.log("[MediaMTX] MediaMTX 進程不存在");
        cleanup();
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error(`[MediaMTX] 停止失敗:`, error.message);
    cleanup();
  }
}

function cleanup() {
  if (fs.existsSync(MEDIAMTX_PID_FILE)) {
    fs.unlinkSync(MEDIAMTX_PID_FILE);
  }
  console.log("[MediaMTX] MediaMTX 已停止");
}

function main() {
  stopMediaMTX();
}

if (require.main === module) {
  main();
}

module.exports = { main, stopMediaMTX };

