const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");

// 使用 unzipper 或內建的解壓縮方法
let AdmZip;
try {
  AdmZip = require("adm-zip");
} catch (e) {
  // 如果沒有 adm-zip，將提示用戶安裝
}

/**
 * 下載 MediaMTX 可執行檔
 * 根據作業系統自動下載對應版本
 */

const MEDIAMTX_VERSION = "v1.15.5"; // 更新到最新穩定版本
const MEDIAMTX_DIR = path.join(__dirname, "..", "mediamtx");
const MEDIAMTX_BIN_DIR = path.join(MEDIAMTX_DIR, "bin");

// 平台映射
const PLATFORM_MAP = {
  "win32": {
    x64: "windows_amd64",
    ia32: "windows_386",
    arm64: "windows_arm64"
  },
  "darwin": {
    x64: "darwin_amd64",
    arm64: "darwin_arm64"
  },
  "linux": {
    x64: "linux_amd64",
    ia32: "linux_386",
    arm: "linux_armv7",
    arm64: "linux_arm64"
  }
};

function getDownloadUrl() {
  const platform = process.platform;
  const arch = process.arch;
  
  const platformMap = PLATFORM_MAP[platform];
  if (!platformMap) {
    throw new Error(`不支援的平台: ${platform}`);
  }

  const archName = platformMap[arch];
  if (!archName) {
    throw new Error(`不支援的架構: ${platform} ${arch}`);
  }

  // Windows 使用 .zip，其他平台使用 .tar.gz
  // 文件名格式：mediamtx_v1.15.5_windows_amd64.zip（保留 v 前綴）
  const archiveExt = platform === "win32" ? ".zip" : ".tar.gz";
  const versionStr = MEDIAMTX_VERSION.startsWith("v") ? MEDIAMTX_VERSION : `v${MEDIAMTX_VERSION}`;
  const filename = `mediamtx_${versionStr}_${archName}${archiveExt}`;
  const binaryName = platform === "win32" ? "mediamtx.exe" : "mediamtx";
  
  return {
    url: `https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/${filename}`,
    archiveFilename: filename,
    binaryName: binaryName,
    fullPath: path.join(MEDIAMTX_BIN_DIR, binaryName),
    isZip: platform === "win32"
  };
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`[MediaMTX] 正在下載: ${url}`);
    
    const protocol = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    
    protocol.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // 處理重定向
        return downloadFile(response.headers.location, dest)
          .then(resolve)
          .catch(reject);
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`下載失敗: HTTP ${response.statusCode}`));
        return;
      }
      
      const totalSize = parseInt(response.headers["content-length"], 10);
      let downloadedSize = 0;
      
      response.on("data", (chunk) => {
        downloadedSize += chunk.length;
        const percent = totalSize ? ((downloadedSize / totalSize) * 100).toFixed(2) : 0;
        process.stdout.write(`\r[MediaMTX] 下載進度: ${percent}%`);
      });
      
      response.pipe(file);
      
      file.on("finish", () => {
        file.close();
        console.log("\n[MediaMTX] 下載完成");
        resolve();
      });
      
      file.on("error", (err) => {
        fs.unlinkSync(dest);
        reject(err);
      });
    }).on("error", reject);
  });
}

function makeExecutable(filePath) {
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(filePath, 0o755);
    } catch (error) {
      console.warn(`[MediaMTX] 無法設置執行權限: ${error.message}`);
    }
  }
}

function extractZip(zipPath, extractTo, binaryName) {
  if (!AdmZip) {
    throw new Error("需要 adm-zip 套件來解壓縮 ZIP 文件。請執行: npm install adm-zip");
  }
  
  console.log(`[MediaMTX] 正在解壓縮 ZIP 文件...`);
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  
  // 查找 mediamtx.exe（可能在根目錄或子目錄中）
  const binaryEntry = entries.find(entry => {
    const entryName = entry.entryName.replace(/\\/g, "/"); // 統一使用正斜線
    return entryName === binaryName || 
           entryName.endsWith(`/${binaryName}`) ||
           entryName.endsWith(`\\${binaryName}`);
  });
  
  if (!binaryEntry) {
    // 列出所有條目以便調試
    console.error(`[MediaMTX] ZIP 文件中的條目:`);
    entries.slice(0, 10).forEach(entry => {
      console.error(`  - ${entry.entryName}`);
    });
    throw new Error(`在 ZIP 文件中找不到 ${binaryName}`);
  }
  
  console.log(`[MediaMTX] 找到 ${binaryName} 在: ${binaryEntry.entryName}`);
  
  // 提取整個 ZIP 到臨時目錄
  const tempExtractDir = path.join(extractTo, "temp_extract");
  if (fs.existsSync(tempExtractDir)) {
    fs.rmSync(tempExtractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempExtractDir, { recursive: true });
  
  zip.extractAllTo(tempExtractDir, true);
  
  // 查找提取後的文件
  const extractedPath = path.join(tempExtractDir, binaryEntry.entryName.replace(/\\/g, path.sep));
  const targetPath = path.join(extractTo, binaryName);
  
  if (!fs.existsSync(extractedPath)) {
    // 嘗試在子目錄中查找
    const searchPaths = [
      path.join(tempExtractDir, binaryName),
      path.join(tempExtractDir, "mediamtx", binaryName),
      path.join(tempExtractDir, `mediamtx_${MEDIAMTX_VERSION.replace("v", "")}`, binaryName)
    ];
    
    for (const searchPath of searchPaths) {
      if (fs.existsSync(searchPath)) {
        fs.copyFileSync(searchPath, targetPath);
        fs.rmSync(tempExtractDir, { recursive: true, force: true });
        console.log(`[MediaMTX] 已提取 ${binaryName} 到 ${targetPath}`);
        return;
      }
    }
    
    throw new Error(`無法找到提取後的 ${binaryName} 文件`);
  }
  
  // 移動文件到正確位置
  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }
  fs.copyFileSync(extractedPath, targetPath);
  
  // 清理臨時目錄
  fs.rmSync(tempExtractDir, { recursive: true, force: true });
  
  console.log(`[MediaMTX] 已提取 ${binaryName} 到 ${targetPath}`);
}

function extractTarGz(tarGzPath, extractTo, binaryName) {
  console.log(`[MediaMTX] 正在解壓縮 TAR.GZ 文件...`);
  
  // 使用 tar 命令解壓縮（大多數 Unix 系統都有）
  try {
    execSync(`tar -xzf "${tarGzPath}" -C "${extractTo}" ${binaryName}`, {
      stdio: "inherit"
    });
    
    // 移動文件到正確位置（如果需要的話）
    const extractedPath = path.join(extractTo, binaryName);
    const targetPath = path.join(extractTo, binaryName);
    
    if (fs.existsSync(extractedPath) && extractedPath !== targetPath) {
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      fs.renameSync(extractedPath, targetPath);
    }
    
    console.log(`[MediaMTX] 已提取 ${binaryName} 到 ${targetPath}`);
  } catch (error) {
    throw new Error(`解壓縮失敗: ${error.message}`);
  }
}

async function main() {
  try {
    console.log("[MediaMTX] 開始下載 MediaMTX...");
    console.log(`[MediaMTX] 版本: ${MEDIAMTX_VERSION}`);
    console.log(`[MediaMTX] 平台: ${process.platform} ${process.arch}`);

    // 確保目錄存在
    if (!fs.existsSync(MEDIAMTX_BIN_DIR)) {
      fs.mkdirSync(MEDIAMTX_BIN_DIR, { recursive: true });
    }

    // 獲取下載 URL
    const { url, archiveFilename, binaryName, fullPath, isZip } = getDownloadUrl();
    console.log(`[MediaMTX] 目標檔案: ${fullPath}`);

    // 下載檔案到臨時位置
    const tempArchivePath = path.join(MEDIAMTX_BIN_DIR, archiveFilename);
    console.log(`[MediaMTX] 下載壓縮檔到: ${tempArchivePath}`);
    
    await downloadFile(url, tempArchivePath);

    // 解壓縮
    if (isZip) {
      if (!AdmZip) {
        console.error("[MediaMTX] 錯誤: 需要 adm-zip 套件來解壓縮 ZIP 文件");
        console.error("[MediaMTX] 請執行: npm install adm-zip");
        process.exit(1);
      }
      extractZip(tempArchivePath, MEDIAMTX_BIN_DIR, binaryName);
    } else {
      extractTarGz(tempArchivePath, MEDIAMTX_BIN_DIR, binaryName);
    }

    // 刪除臨時壓縮檔
    if (fs.existsSync(tempArchivePath)) {
      fs.unlinkSync(tempArchivePath);
      console.log(`[MediaMTX] 已刪除臨時壓縮檔: ${tempArchivePath}`);
    }

    // 設置執行權限（非 Windows）
    makeExecutable(fullPath);

    console.log(`[MediaMTX] MediaMTX 已下載到: ${fullPath}`);
    console.log("[MediaMTX] 下載完成！");
    
    // 複製配置檔案
    const configSource = path.join(__dirname, "..", "mediamtx.yml");
    const configDest = path.join(MEDIAMTX_DIR, "mediamtx.yml");
    
    if (fs.existsSync(configSource)) {
      if (!fs.existsSync(configDest)) {
        fs.copyFileSync(configSource, configDest);
        console.log(`[MediaMTX] 配置檔案已複製到: ${configDest}`);
      }
    } else {
      console.warn(`[MediaMTX] 配置檔案不存在: ${configSource}`);
    }

  } catch (error) {
    console.error("[MediaMTX] 下載失敗:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, getDownloadUrl };

