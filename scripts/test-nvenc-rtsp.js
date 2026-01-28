/**
 * 測試 NVENC RTSP 輸出
 * 用於驗證編碼參數是否正確
 */

const { spawn } = require("child_process");
const { resolveFfmpegPath } = require("../src/utils/ffmpegPath");
const path = require("path");

console.log("測試 NVENC RTSP 輸出...");
console.log("=".repeat(60));

const ffmpegPath = resolveFfmpegPath(__dirname);
const rtspOutput = "rtsp://192.168.2.8:8554/test_stream";

// 構建測試命令（使用與實際代碼相同的參數）
const args = [
  "-f", "lavfi",
  "-i", "testsrc2=size=1280x720:rate=30",
  "-t", "10", // 只測試 10 秒
  "-c:v", "h264_nvenc",
  "-preset", "fast",
  "-rc", "vbr",
  "-b:v", "2M",
  "-maxrate", "2M",
  "-bufsize", "4M",
  "-g", "60",
  "-forced-idr", "1",
  "-pix_fmt", "yuv420p",
  "-color_range", "tv",
  "-profile:v", "main",
  "-flags", "+global_header",
  "-rtsp_transport", "tcp",
  "-f", "rtsp",
  rtspOutput
];

console.log("FFmpeg 命令：");
console.log(`"${ffmpegPath}" ${args.join(" ")}`);
console.log();

const ffmpeg = spawn(ffmpegPath, args, {
  stdio: ["ignore", "pipe", "pipe"],
});

let hasError = false;

ffmpeg.stdout.on("data", (data) => {
  const output = data.toString();
  console.log(output);
});

ffmpeg.stderr.on("data", (data) => {
  const output = data.toString();
  const lines = output.split("\n");
  
  lines.forEach((line) => {
    if (line.trim()) {
      if (line.includes("error") || line.includes("Error") || line.includes("failed")) {
        console.error(`[錯誤] ${line}`);
        hasError = true;
      } else if (line.includes("warning") || line.includes("Warning")) {
        console.warn(`[警告] ${line}`);
      } else {
        console.log(line);
      }
    }
  });
});

ffmpeg.on("exit", (code, signal) => {
  console.log();
  console.log("=".repeat(60));
  if (code === 0) {
    console.log("✅ 測試成功！RTSP 輸出正常");
  } else {
    console.log(`❌ 測試失敗，退出代碼: ${code}, 信號: ${signal}`);
    if (hasError) {
      console.log("請檢查上面的錯誤訊息");
    }
  }
  process.exit(code || 1);
});

ffmpeg.on("error", (error) => {
  console.error("❌ 進程錯誤:", error.message);
  process.exit(1);
});

// 10 秒後自動停止
setTimeout(() => {
  console.log("\n停止測試...");
  ffmpeg.kill("SIGTERM");
}, 12000);
