const { spawnSync } = require("child_process");

function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH && typeof process.env.FFMPEG_PATH === "string") {
    return process.env.FFMPEG_PATH;
  }

  try {
    // eslint-disable-next-line global-require
    const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
    if (ffmpegInstaller && ffmpegInstaller.path) {
      return ffmpegInstaller.path;
    }
  } catch (e) {
    // ignore, fallback to PATH
  }

  return "ffmpeg";
}

const ffmpegBin = resolveFfmpegPath();

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


