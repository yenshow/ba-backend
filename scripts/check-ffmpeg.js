const { spawnSync } = require("child_process");
const path = require("path");
const { resolveFfmpegPath } = require("../src/utils/ffmpegPath");

// 從 scripts 目錄計算專案根目錄
const projectRoot = path.resolve(__dirname, "..");
const ffmpegBin = resolveFfmpegPath(projectRoot);

function run(args) {
  const result = spawnSync(ffmpegBin, args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null,
  };
}

function main() {
  console.log(`[FFmpeg Check] ffmpeg bin = ${ffmpegBin}`);

  const v = run(["-version"]);
  if (v.error) {
    console.error(`[FFmpeg Check] 無法執行 ffmpeg: ${v.error.message}`);
    process.exit(1);
  }
  if (v.status !== 0) {
    console.error(`[FFmpeg Check] ffmpeg -version 失敗 (exit=${v.status})`);
    console.error(v.stderr || v.stdout);
    process.exit(1);
  }
  console.log(v.stdout.split("\n").slice(0, 2).join("\n"));

  const enc = run(["-hide_banner", "-encoders"]);
  const output = `${enc.stdout}\n${enc.stderr}`.toLowerCase();

  const hasNvenc = output.includes("h264_nvenc") || output.includes("hevc_nvenc");
  const hasQsv = output.includes("h264_qsv") || output.includes("hevc_qsv");
  const hasAmf = output.includes("h264_amf") || output.includes("hevc_amf");

  console.log("[FFmpeg Check] GPU encoders:");
  console.log(`- nvenc: ${hasNvenc ? "yes" : "no"}`);
  console.log(`- qsv  : ${hasQsv ? "yes" : "no"}`);
  console.log(`- amf  : ${hasAmf ? "yes" : "no"}`);

  process.exit(0);
}

if (require.main === module) {
  main();
}


