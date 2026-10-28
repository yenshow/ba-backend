/**
 * 未接聽廣播探測：振鈴期有 SDP 才送 RTP；可加 Call-Info answer-after=0。
 * 請不要接聽，聽喇叭有無出聲。
 *
 *   node scripts/probe/testVideoIntercomSipEarlyMedia.js --password <pwd>
 */
/* eslint-disable no-console */

const { inviteIndoorEarlyBroadcast } = require("../../src/services/accessSecurity/sipInviteService");
const { invokeBridge } = require("../../src/services/ladderSdk/sdkBridgeClient");

const PASSWORD = "Aa83124007";

const parseCliArgs = () => {
  const args = process.argv.slice(2);
  const config = { password: PASSWORD };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--password" && args[i + 1]) {
      config.password = args[i + 1];
      i += 1;
    }
  }
  return config;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runOne = async ({ label, host, voip, extraHeaders, password }) => {
  console.log(`\n${"=".repeat(72)}\n${label}\n${"=".repeat(72)}`);
  console.log(`請不要接聽 ${host} To=${voip}`);
  if (extraHeaders?.length) console.log(`額外標頭：${extraHeaders.join(" | ")}`);

  const result = await inviteIndoorEarlyBroadcast({
    host,
    voipNumber: voip,
    username: "admin",
    password,
    displayName: "BA-Early-Media",
    earlyCollectMs: 8000,
    playMaxFrames: 400,
    extraHeaders,
    silent: false,
  });
  console.log(JSON.stringify({ invite: result }, null, 2));
  return result;
};

const peekIsapi = async (host, password) => {
  const paths = [
    "/ISAPI/VideoIntercom/incomingCallLinkage",
    "/ISAPI/VideoIntercom/incomingCallLinkage?format=json",
    "/ISAPI/VideoIntercom/operationTime",
  ];
  console.log(`\n--- ISAPI ${host} ---`);
  for (const path of paths) {
    try {
      const res = await invokeBridge({
        action: "isapi.request",
        device: { host, port: 8000, username: "admin", password },
        payload: { method: "GET", path, timeoutMs: 8000 },
      });
      const body = String(res?.body || res?.statusBody || "").slice(0, 500);
      console.log(`OK ${path}\n${body}\n`);
    } catch (error) {
      console.log(`FAIL ${path} ${error.message} ${error.details?.subStatusCode || ""}`);
    }
  }
};

const run = async () => {
  const { password } = parseCliArgs();
  if (!password) {
    console.error("請提供 --password");
    process.exit(1);
  }

  const rows = [];
  rows.push(
    await runOne({
      label: "A. KH6350 標準 INVITE（early media）",
      host: "192.168.2.78",
      voip: "1001",
      password,
    }),
  );
  await sleep(2500);
  rows.push(
    await runOne({
      label: "B. KH6350 Call-Info answer-after=0",
      host: "192.168.2.78",
      voip: "1001",
      extraHeaders: ["Call-Info: <sip:192.168.2.8>;answer-after=0"],
      password,
    }),
  );
  await sleep(2500);
  rows.push(
    await runOne({
      label: "C. 8520 標準 INVITE（先前 183）",
      host: "192.168.2.75",
      voip: "1003",
      password,
    }),
  );

  await peekIsapi("192.168.2.78", password);

  console.log("\n===== 摘要 =====");
  for (const row of rows) {
    console.log(
      `${row.result}  played=${row.played}  codes=${JSON.stringify(row.earlyCodes)}  sdp=${row.remoteSdp?.remotePort || "-"}  auto=${row.earlyAnswered}`,
    );
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
