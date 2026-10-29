/**
 * 直打室內機 SIP 對講探測：sendrecv，接聽後只送靜音 RTP，統計入站 RTP。
 * 不播 alert-broadcast.pcm；不經管理中心。
 *
 *   npm run test:video-intercom-sip-talk -- --host 192.168.2.78 --to 1001 --password <pwd>
 */
/* eslint-disable no-console */

const { inviteIndoorTalk } = require("../../src/services/accessSecurity/sipInviteService");

const SCRIPT_CONFIG = {
  sipHost: "192.168.2.78",
  sipPort: 5060,
  sipUser: "admin",
  password: "",
  targetUser: "1001",
  displayName: "BA-Talk-Probe",
  answerMs: 90_000,
  talkHoldMs: 20_000,
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
    } else if ((arg === "--password" || arg === "--sip-password") && next) {
      config.password = next;
      i += 1;
    } else if ((arg === "--target" || arg === "--to") && next) {
      config.targetUser = next;
      i += 1;
    } else if ((arg === "--answer" || arg === "--answer-ms") && next) {
      config.answerMs = Number(next) || config.answerMs;
      i += 1;
    } else if ((arg === "--hold-ms") && next) {
      config.talkHoldMs = Number(next) || config.talkHoldMs;
      i += 1;
    }
  }
  return config;
};

const run = async () => {
  const config = parseCliArgs();
  if (!config.password) {
    console.error("請提供 --password");
    process.exit(1);
  }

  console.log("\n直打室內機 SIP 對講探測（sendrecv，靜音 RTP，不播警報）");
  console.log(`目標：${config.sipHost}:${config.sipPort}  To：${config.targetUser}`);
  console.log(`接聽等待：${config.answerMs}ms；接聽後保持：${config.talkHoldMs}ms`);
  console.log("請接聽，並對室內機麥克風說話…\n");

  const result = await inviteIndoorTalk({
    host: config.sipHost,
    sipPort: config.sipPort,
    voipNumber: config.targetUser,
    username: config.sipUser,
    password: config.password,
    answerMs: config.answerMs,
    talkHoldMs: config.talkHoldMs,
    displayName: config.displayName,
    silent: false,
  });

  console.log(JSON.stringify({ invite: result }, null, 2));
  if (!result.played) {
    console.error("\n未進入通話（可能未接聽）。");
    process.exitCode = 1;
    return;
  }
  const pkts = Number(result.inboundRtpPackets) || 0;
  console.log(
    pkts > 0
      ? `\n入站 RTP ${pkts} 包 → 室內機有回傳音訊（協定上可雙向）。`
      : "\n入站 RTP 0 包 → 接聽後仍無回傳（可能仍是單向）。",
  );
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
