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
  // 如果 baseDir 已經是專案根目錄（包含 package.json），直接使用
  // 否則往上查找，直到找到包含 package.json 的目錄
  let projectRoot = baseDir;
  let currentDir = baseDir;
  
  // 最多往上查找 5 層，避免無限循環
  for (let i = 0; i < 5; i++) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      projectRoot = currentDir;
      break;
    }
    const parentDir = path.resolve(currentDir, "..");
    // 如果已經到達根目錄，停止查找
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
  
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

