/**
 * NVIDIA 驅動和 CUDA 安裝檢查腳本
 * 用於驗證系統是否正確安裝了 NVIDIA 驅動和 CUDA Toolkit
 */

const { execSync } = require("child_process");
const { resolveFfmpegPath } = require("../src/utils/ffmpegPath");
const path = require("path");

console.log("=".repeat(60));
console.log("NVIDIA 驅動和 CUDA 安裝檢查");
console.log("=".repeat(60));
console.log();

let allChecksPassed = true;

/**
 * 執行命令並捕獲輸出
 */
function execCommand(command, description) {
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    return { success: true, output: output.trim() };
  } catch (error) {
    return {
      success: false,
      error: error.message || "命令執行失敗",
      stderr: error.stderr?.toString() || "",
    };
  }
}

/**
 * 檢查項目
 */
function checkItem(name, command, description) {
  process.stdout.write(`檢查 ${name}... `);
  const result = execCommand(command, description);

  if (result.success) {
    console.log("✅ 通過");
    if (result.output) {
      // 只顯示關鍵資訊
      const lines = result.output.split("\n");
      const importantLines = lines
        .filter((line) => {
          const lower = line.toLowerCase();
          return (
            lower.includes("nvidia") ||
            lower.includes("cuda") ||
            lower.includes("driver") ||
            lower.includes("version") ||
            lower.includes("gpu")
          );
        })
        .slice(0, 5); // 最多顯示 5 行

      if (importantLines.length > 0) {
        importantLines.forEach((line) => {
          console.log(`   ${line}`);
        });
      }
    }
    return true;
  } else {
    console.log("❌ 失敗");
    if (result.error) {
      console.log(`   錯誤: ${result.error}`);
    }
    if (result.stderr) {
      const errorMsg = result.stderr.trim();
      if (errorMsg && !errorMsg.includes("不是內部或外部命令")) {
        console.log(`   詳細: ${errorMsg.substring(0, 100)}`);
      }
    }
    return false;
  }
}

// 檢查 1: NVIDIA 驅動程式
console.log("【檢查 1】NVIDIA 驅動程式");
console.log("-".repeat(60));
const nvidiaCheck = checkItem(
  "NVIDIA 驅動",
  "nvidia-smi",
  "檢查 NVIDIA 驅動是否安裝"
);

if (!nvidiaCheck) {
  console.log();
  console.log("⚠️  警告: 未檢測到 NVIDIA 驅動");
  console.log("   請參考 docs/NVIDIA_CUDA_INSTALLATION_GUIDE.md 進行安裝");
  allChecksPassed = false;
}
console.log();

// 檢查 2: CUDA Toolkit
console.log("【檢查 2】CUDA Toolkit");
console.log("-".repeat(60));
const cudaCheck = checkItem(
  "CUDA 編譯器",
  "nvcc --version",
  "檢查 CUDA Toolkit 是否安裝"
);

if (!cudaCheck) {
  console.log();
  console.log("⚠️  警告: 未檢測到 CUDA Toolkit");
  console.log("   請參考 docs/NVIDIA_CUDA_INSTALLATION_GUIDE.md 進行安裝");
  allChecksPassed = false;
}
console.log();

// 檢查 3: FFmpeg NVENC 支援
console.log("【檢查 3】FFmpeg NVENC 支援");
console.log("-".repeat(60));

try {
  const ffmpegPath = resolveFfmpegPath(__dirname);
  process.stdout.write(`檢查 FFmpeg NVENC 編碼器... `);

  const encodersOutput = execSync(
    `"${ffmpegPath}" -encoders 2>&1`,
    { encoding: "utf-8", timeout: 10000 }
  );

  const hasH264Nvenc = encodersOutput.includes("h264_nvenc");
  const hasHevcNvenc = encodersOutput.includes("hevc_nvenc");

  if (hasH264Nvenc || hasHevcNvenc) {
    console.log("✅ 通過");
    if (hasH264Nvenc) {
      console.log("   ✓ h264_nvenc 編碼器可用");
    }
    if (hasHevcNvenc) {
      console.log("   ✓ hevc_nvenc 編碼器可用");
    }
  } else {
    console.log("❌ 失敗");
    console.log("   錯誤: FFmpeg 未編譯 NVENC 支援");
    console.log("   請確認使用的 FFmpeg 版本支援 NVENC");
    allChecksPassed = false;
  }
} catch (error) {
  console.log("❌ 失敗");
  console.log(`   錯誤: ${error.message}`);
  allChecksPassed = false;
}
console.log();

// 檢查 4: FFmpeg 版本資訊
console.log("【檢查 4】FFmpeg 版本資訊");
console.log("-".repeat(60));

try {
  const ffmpegPath = resolveFfmpegPath(__dirname);
  process.stdout.write(`檢查 FFmpeg 版本... `);

  const versionOutput = execSync(
    `"${ffmpegPath}" -version 2>&1`,
    { encoding: "utf-8", timeout: 10000 }
  );

  const lines = versionOutput.split("\n");
  const versionLine = lines.find((line) => line.includes("ffmpeg version"));
  const configLine = lines.find((line) => line.includes("configuration:"));

  if (versionLine) {
    console.log("✅ 通過");
    console.log(`   ${versionLine.trim()}`);
    if (configLine) {
      const hasNvenc = configLine.includes("--enable-nvenc");
      const hasNvdec = configLine.includes("--enable-nvdec");
      if (hasNvenc) {
        console.log("   ✓ 編譯時已啟用 NVENC");
      }
      if (hasNvdec) {
        console.log("   ✓ 編譯時已啟用 NVDEC");
      }
      if (!hasNvenc && !hasNvdec) {
        console.log("   ⚠️  編譯時未啟用 NVENC/NVDEC");
      }
    }
  } else {
    console.log("⚠️  無法解析版本資訊");
  }
} catch (error) {
  console.log("❌ 失敗");
  console.log(`   錯誤: ${error.message}`);
  allChecksPassed = false;
}
console.log();

// 總結
console.log("=".repeat(60));
if (allChecksPassed) {
  console.log("✅ 所有檢查通過！您的系統已準備好使用 GPU 編碼。");
  console.log();
  console.log("下一步：");
  console.log("1. 啟動後端服務: npm run dev");
  console.log("2. 在前端嘗試啟動 GPU 編碼的 RTSP 串流");
  console.log("3. 使用 'nvidia-smi' 監控 GPU 使用率");
} else {
  console.log("❌ 部分檢查未通過，請參考以下建議：");
  console.log();
  console.log("1. 如果未安裝 NVIDIA 驅動：");
  console.log("   - 訪問: https://www.nvidia.com/Download/index.aspx");
  console.log("   - 下載並安裝對應您 GPU 的驅動程式");
  console.log();
  console.log("2. 如果未安裝 CUDA Toolkit：");
  console.log("   - 訪問: https://developer.nvidia.com/cuda-downloads");
  console.log("   - 下載並安裝 CUDA Toolkit");
  console.log();
  console.log("3. 詳細安裝指南：");
  console.log("   - 查看: docs/NVIDIA_CUDA_INSTALLATION_GUIDE.md");
  console.log();
  console.log("注意：如果您的系統沒有 NVIDIA GPU，將無法使用 NVENC 編碼。");
  console.log("      請使用 CPU 編碼（不勾選「啟用 GPU 編碼」選項）。");
}
console.log("=".repeat(60));

// 設置退出碼
process.exit(allChecksPassed ? 0 : 1);
