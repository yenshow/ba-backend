const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// 使用 unzipper 或內建的解壓縮方法
let AdmZip;
try {
  AdmZip = require("adm-zip");
} catch (e) {
  // 如果沒有 adm-zip，將提示用戶安裝
}

/**
 * 下載 FFmpeg 可執行檔
 * 根據作業系統自動下載對應版本
 * 使用 gyan.dev 提供的 Windows builds（包含 GPU 編碼器支援）
 */

const FFMPEG_DIR = path.join(__dirname, "..", "ffmpeg");
const FFMPEG_BIN_DIR = path.join(FFMPEG_DIR, "bin");

// 平台映射和下載來源
const PLATFORM_CONFIG = {
  win32: {
    // Windows 所有架構使用相同的下載來源
    _default: {
      url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
      binaryName: "ffmpeg.exe",
      extractSubdir: "ffmpeg-*-essentials_build/bin",
    },
  },
  darwin: {
    // macOS 所有架構使用相同的下載來源
    _default: {
      url: "https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip",
      binaryName: "ffmpeg",
      extractSubdir: null,
    },
  },
  linux: {
    x64: {
      url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
      binaryName: "ffmpeg",
      extractSubdir: "ffmpeg-*-amd64-static",
    },
    ia32: {
      url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-i686-static.tar.xz",
      binaryName: "ffmpeg",
      extractSubdir: "ffmpeg-*-i686-static",
    },
    arm64: {
      url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz",
      binaryName: "ffmpeg",
      extractSubdir: "ffmpeg-*-arm64-static",
    },
  },
};

function getDownloadConfig() {
  const platform = process.platform;
  const arch = process.arch;

  const platformConfig = PLATFORM_CONFIG[platform];
  if (!platformConfig) {
    throw new Error(`不支援的平台: ${platform}`);
  }

  // 優先使用架構特定配置，否則使用 _default
  const archConfig = platformConfig[arch] || platformConfig._default;
  if (!archConfig) {
    throw new Error(`不支援的架構: ${platform} ${arch}`);
  }

  return {
    ...archConfig,
    fullPath: path.join(FFMPEG_BIN_DIR, archConfig.binaryName),
    isZip: archConfig.url.endsWith(".zip"),
  };
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`[FFmpeg] 正在下載: ${url}`);

    const protocol = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);

    protocol
      .get(url, (response) => {
        // 處理所有重定向狀態碼（301, 302, 303, 307, 308）
        if (
          response.statusCode === 301 ||
          response.statusCode === 302 ||
          response.statusCode === 303 ||
          response.statusCode === 307 ||
          response.statusCode === 308
        ) {
          // 處理重定向
          const redirectUrl = response.headers.location;
          if (!redirectUrl) {
            reject(new Error(`重定向但沒有提供新的 URL`));
            return;
          }
          return downloadFile(redirectUrl, dest).then(resolve).catch(reject);
        }

        if (response.statusCode !== 200) {
          reject(new Error(`下載失敗: HTTP ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers["content-length"], 10);
        let downloadedSize = 0;

        response.on("data", (chunk) => {
          downloadedSize += chunk.length;
          const percent = totalSize
            ? ((downloadedSize / totalSize) * 100).toFixed(2)
            : 0;
          process.stdout.write(`\r[FFmpeg] 下載進度: ${percent}%`);
        });

        response.pipe(file);

        file.on("finish", () => {
          file.close();
          console.log("\n[FFmpeg] 下載完成");
          resolve();
        });

        file.on("error", (err) => {
          fs.unlinkSync(dest);
          reject(err);
        });
      })
      .on("error", reject);
  });
}

function makeExecutable(filePath) {
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(filePath, 0o755);
    } catch (error) {
      console.warn(`[FFmpeg] 無法設置執行權限: ${error.message}`);
    }
  }
}

/**
 * 查找提取後的二進制文件
 */
function findExtractedBinary(tempExtractDir, binaryName, extractSubdir) {
  // 先嘗試直接查找
  const directPath = path.join(tempExtractDir, binaryName);
  if (fs.existsSync(directPath)) {
    return directPath;
  }

  // 嘗試在子目錄中查找
  if (extractSubdir) {
    const dirs = fs.readdirSync(tempExtractDir);
    const pattern = extractSubdir.replace("*", ".*");
    const matchingDir = dirs.find((dir) => dir.match(pattern));
    if (matchingDir) {
      const subPath = path.join(tempExtractDir, matchingDir, binaryName);
      if (fs.existsSync(subPath)) {
        return subPath;
      }
    }
  }

  return null;
}

function extractZip(zipPath, extractTo, binaryName, extractSubdir) {
  if (!AdmZip) {
    throw new Error(
      "需要 adm-zip 套件來解壓縮 ZIP 文件。請執行: npm install adm-zip"
    );
  }

  console.log(`[FFmpeg] 正在解壓縮 ZIP 文件...`);
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  // 查找二進制文件
  const binaryEntry = entries.find((entry) => {
    const entryName = entry.entryName.replace(/\\/g, "/");
    return (
      entryName === binaryName ||
      entryName.endsWith(`/${binaryName}`) ||
      entryName.endsWith(`\\${binaryName}`)
    );
  });

  if (!binaryEntry) {
    console.error(`[FFmpeg] ZIP 文件中的條目（前 20 個）:`);
    entries.slice(0, 20).forEach((entry) => {
      console.error(`  - ${entry.entryName}`);
    });
    throw new Error(`在 ZIP 文件中找不到 ${binaryName}`);
  }

  console.log(`[FFmpeg] 找到 ${binaryName} 在: ${binaryEntry.entryName}`);

  // 提取整個 ZIP 到臨時目錄
  const tempExtractDir = path.join(extractTo, "temp_extract");
  if (fs.existsSync(tempExtractDir)) {
    fs.rmSync(tempExtractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempExtractDir, { recursive: true });
  zip.extractAllTo(tempExtractDir, true);

  // 查找提取後的文件
  const extractedPath = path.join(
    tempExtractDir,
    binaryEntry.entryName.replace(/\\/g, path.sep)
  );
  const foundPath =
    fs.existsSync(extractedPath)
      ? extractedPath
      : findExtractedBinary(tempExtractDir, binaryName, extractSubdir);

  if (!foundPath) {
    throw new Error(`無法找到提取後的 ${binaryName} 文件`);
  }

  // 移動文件到正確位置
  const targetPath = path.join(extractTo, binaryName);
  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }
  fs.copyFileSync(foundPath, targetPath);

  // 清理臨時目錄
  fs.rmSync(tempExtractDir, { recursive: true, force: true });
  console.log(`[FFmpeg] 已提取 ${binaryName} 到 ${targetPath}`);
}

function extractTarXz(tarXzPath, extractTo, binaryName, extractSubdir) {
  console.log(`[FFmpeg] 正在解壓縮 TAR.XZ 文件...`);

  try {
    const tempExtractDir = path.join(extractTo, "temp_extract");
    if (fs.existsSync(tempExtractDir)) {
      fs.rmSync(tempExtractDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempExtractDir, { recursive: true });

    execSync(`tar -xJf "${tarXzPath}" -C "${tempExtractDir}"`, {
      stdio: "inherit",
    });

    // 查找提取後的文件
    const foundPath = findExtractedBinary(tempExtractDir, binaryName, extractSubdir);
    if (!foundPath) {
      throw new Error(`無法找到提取後的 ${binaryName} 文件`);
    }

    // 移動文件到正確位置
    const targetPath = path.join(extractTo, binaryName);
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
    fs.copyFileSync(foundPath, targetPath);

    // 清理臨時目錄
    fs.rmSync(tempExtractDir, { recursive: true, force: true });
    console.log(`[FFmpeg] 已提取 ${binaryName} 到 ${targetPath}`);
  } catch (error) {
    throw new Error(`解壓縮失敗: ${error.message}`);
  }
}

async function main() {
  try {
    console.log("[FFmpeg] 開始下載 FFmpeg...");
    console.log(`[FFmpeg] 平台: ${process.platform} ${process.arch}`);

    // 確保目錄存在
    if (!fs.existsSync(FFMPEG_BIN_DIR)) {
      fs.mkdirSync(FFMPEG_BIN_DIR, { recursive: true });
    }

    // 獲取下載配置
    const config = getDownloadConfig();
    console.log(`[FFmpeg] 目標檔案: ${config.fullPath}`);

    // 檢查是否已存在
    if (fs.existsSync(config.fullPath)) {
      console.log(`[FFmpeg] FFmpeg 已存在: ${config.fullPath}`);
      console.log("[FFmpeg] 如需重新下載，請先刪除現有文件");
      return;
    }

    // 下載檔案到臨時位置
    const archiveExt = config.isZip ? ".zip" : ".tar.xz";
    const tempArchivePath = path.join(
      FFMPEG_BIN_DIR,
      `ffmpeg${archiveExt}`
    );
    console.log(`[FFmpeg] 下載壓縮檔到: ${tempArchivePath}`);

    await downloadFile(config.url, tempArchivePath);

    // 解壓縮
    if (config.isZip) {
      if (!AdmZip) {
        console.error(
          "[FFmpeg] 錯誤: 需要 adm-zip 套件來解壓縮 ZIP 文件"
        );
        console.error("[FFmpeg] 請執行: npm install adm-zip");
        process.exit(1);
      }
      extractZip(
        tempArchivePath,
        FFMPEG_BIN_DIR,
        config.binaryName,
        config.extractSubdir
      );
    } else {
      extractTarXz(
        tempArchivePath,
        FFMPEG_BIN_DIR,
        config.binaryName,
        config.extractSubdir
      );
    }

    // 刪除臨時壓縮檔
    if (fs.existsSync(tempArchivePath)) {
      fs.unlinkSync(tempArchivePath);
      console.log(`[FFmpeg] 已刪除臨時壓縮檔: ${tempArchivePath}`);
    }

    // 設置執行權限（非 Windows）
    makeExecutable(config.fullPath);

    console.log(`[FFmpeg] FFmpeg 已下載到: ${config.fullPath}`);
    console.log("[FFmpeg] 下載完成！");

    // 驗證 FFmpeg 版本
    try {
      const { spawnSync } = require("child_process");
      const result = spawnSync(config.fullPath, ["-version"], {
        encoding: "utf8",
        timeout: 5000,
      });
      if (result.stdout) {
        const versionLine = result.stdout.split("\n")[0];
        console.log(`[FFmpeg] 版本資訊: ${versionLine}`);
      }
    } catch (error) {
      console.warn(`[FFmpeg] 無法驗證版本: ${error.message}`);
    }
  } catch (error) {
    console.error("[FFmpeg] 下載失敗:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, getDownloadConfig };

