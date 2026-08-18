/**
 * 直打室內機 SIP：等待接聽後單向播放 G.711 音檔（不經管理中心主機）
 *
 *   npm run test:video-intercom-sip -- --host 192.168.2.78 --to 1001 --password <密碼>
 *   node scripts/testVideoIntercomSipInvite.js --audio assets/access-security/alert-broadcast.pcm
 *
 * 詳見：docs/40-systems/access-security.md（層 2）；探測附錄 video-intercom-main-station.md
 */

/* eslint-disable no-console */

const path = require("path");
const fs = require("fs");
const {
  inviteIndoorBroadcast,
  resolveBroadcastAudioPath,
} = require("../src/services/accessSecurity/sipInviteService");

const SCRIPT_CONFIG = {
  sipHost: "192.168.2.78",
  sipPort: 5060,
  sipUser: "admin",
  password: "",
  targetUser: "1001",
  displayName: "BA-Alert-Broadcast",
  answerMs: 45000,
  audioPath: path.resolve(
    process.cwd(),
    "assets",
    "access-security",
    "alert-broadcast.pcm",
  ),
};

const parseCliArgs = () => {
  const args = process.argv.slice(2);
  const config = { ...SCRIPT_CONFIG };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--host" && next) {
      config.sipHost = next;
      i += 1;
    } else if (arg === "--port" && next) {
      config.sipPort = Number(next) || config.sipPort;
      i += 1;
    } else if ((arg === "--sip-user" || arg === "--user") && next) {
      config.sipUser = next;
      i += 1;
    } else if ((arg === "--password" || arg === "--sip-password") && next) {
      config.password = next;
      i += 1;
    } else if ((arg === "--target" || arg === "--to") && next) {
      config.targetUser = next;
      i += 1;
    } else if ((arg === "--answer" || arg === "--answer-ms") && next) {
      config.answerMs = Number(next) || config.answerMs;
      i += 1;
    } else if (arg === "--audio" && next) {
      config.audioPath = path.resolve(next);
      i += 1;
    }
  }
  return config;
};

const run = async () => {
  const config = parseCliArgs();
  const audioPath = config.audioPath || resolveBroadcastAudioPath();
  if (!fs.existsSync(audioPath)) {
    console.error(`音訊檔不存在：${audioPath}`);
    console.error("請先放入音檔：assets/access-security/alert-broadcast.pcm");
    process.exit(1);
  }
  if (!config.password) {
    console.error("請提供 --password");
    process.exit(1);
  }

  console.log("\n直打室內機 SIP 語音廣播（單向 RTP）");
  console.log(`目標：${config.sipHost}:${config.sipPort}`);
  console.log(`From：${config.sipUser} → To：${config.targetUser}`);
  console.log(`音檔：${audioPath}`);
  console.log(`接聽等待：${config.answerMs}ms\n`);
  console.log("請在室內機上接聽來電…\n");

  const result = await inviteIndoorBroadcast({
    host: config.sipHost,
    sipPort: config.sipPort,
    voipNumber: config.targetUser,
    username: config.sipUser,
    password: config.password,
    answerMs: config.answerMs,
    audioPath,
    displayName: config.displayName,
    silent: false,
  });

  console.log(JSON.stringify({ invite: result }, null, 2));
  if (!result.played) {
    console.error("\n未播放語音（可能未接聽、忙線或 SIP 失敗）。");
    process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
