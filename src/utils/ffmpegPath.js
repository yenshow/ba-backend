const path = require("path");
const fs = require("fs");

/**
 * 取得 FFmpeg 執行檔路徑（共用函數）
 * 優先順序：
 * 1) 環境變數 FFMPEG_PATH
 * 2) 下載的最新版本（ffmpeg/bin/ffmpeg.exe 或 ffmpeg/bin/ffmpeg）
 * 3) @ffmpeg-installer/ffmpeg（npm install 時自動帶下來，可能版本較舊）
 * 4) 系統 PATH 中的 ffmpeg
 * 
 * @param {string} baseDir - 基礎目錄（用於計算相對路徑，通常是 __dirname）
 * @returns {string} FFmpeg 執行檔路徑
 */
function resolveFfmpegPath(baseDir = __dirname) {
  // 1. 環境變數優先
  if (process.env.FFMPEG_PATH && typeof process.env.FFMPEG_PATH === "string") {
    return process.env.FFMPEG_PATH;
  }

  // 2. 檢查下載的最新版本（ffmpeg/bin/）
  // 從 baseDir 計算到專案根目錄的路徑
  const projectRoot = path.resolve(baseDir, "..", "..");
  const downloadedPath = path.join(
    projectRoot,
    "ffmpeg",
    "bin",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
  );
  if (fs.existsSync(downloadedPath)) {
    return downloadedPath;
  }

  // 3. 使用 @ffmpeg-installer/ffmpeg（備用，可能版本較舊）
  try {
    // eslint-disable-next-line global-require
    const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
    if (ffmpegInstaller && ffmpegInstaller.path) {
      return ffmpegInstaller.path;
    }
  } catch (e) {
    // ignore, fallback to PATH
  }

  // 4. 系統 PATH
  return "ffmpeg";
}

module.exports = { resolveFfmpegPath };

