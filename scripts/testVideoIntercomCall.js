/**
 * 視訊對講診斷（非外撥）
 *
 * 外撥請用 SIP 直打室內：testVideoIntercomSipInvite.js
 * 監聽請用：listenVideoIntercomMainStation.js --host 192.168.2.27
 *
 * 用法：
 *   node scripts/testVideoIntercomCall.js status
 *   node scripts/testVideoIntercomCall.js idle
 *   node scripts/testVideoIntercomCall.js hangUp
 *   node scripts/testVideoIntercomCall.js probe-indoor
 *
 * 需先：npm run sdk:build
 * 詳見：docs/40-systems/video-intercom-main-station.md
 */

/* eslint-disable no-console */

const { invokeBridge } = require("../src/services/ladderSdk/sdkBridgeClient");

const SCRIPT_CONFIG = {
  host: "192.168.2.27",
  port: 8000,
  username: "admin",
  password: "Aa83124007",
  indoorHost: "192.168.2.78",
  indoorPort: 8000,
  requestTimeoutMs: 15000,
};

const PATHS = {
  status: "/ISAPI/VideoIntercom/callStatus?format=json",
  callSignal: "/ISAPI/VideoIntercom/callSignal?format=json",
  deviceInfo: "/ISAPI/System/deviceInfo",
  deviceId: "/ISAPI/VideoIntercom/deviceId",
  deviceCommunication: "/ISAPI/VideoIntercom/deviceCommunication?format=json",
  relatedDeviceAddress: "/ISAPI/VideoIntercom/relatedDeviceAddress",
  capabilities: "/ISAPI/VideoIntercom/callSignal/capabilities?format=json",
};

const parseCliArgs = () => {
  const args = process.argv.slice(2);
  const action = args.find((a) => !a.startsWith("-")) || "status";
  const config = { ...SCRIPT_CONFIG };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--host" && next) {
      config.host = next;
      i += 1;
    } else if (arg === "--indoor" && next) {
      config.indoorHost = next;
      i += 1;
    } else if (arg === "--password" && next) {
      config.password = next;
      i += 1;
    }
  }
  return { action, config };
};

const printSection = (title) => {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
};

const preview = (text, max = 1500) => {
  const raw = String(text || "").trim();
  if (!raw) return "(empty)";
  return raw.length > max ? `${raw.slice(0, max)}\n... (truncated)` : raw;
};

const isapiRequest = async (device, { method, path, body, timeoutMs }) =>
  invokeBridge(
    {
      action: "isapi.request",
      device,
      payload: {
        method,
        path,
        body: body == null ? undefined : body,
        timeoutMs,
      },
    },
    { timeoutMs: timeoutMs + 5000 },
  );

const extractStatus = (res) => {
  try {
    return JSON.parse(res?.body || "")?.CallStatus?.status || null;
  } catch {
    return null;
  }
};

const runStatusOn = async (device, config, label) => {
  console.log(`\n--- ${label} (${device.host}) ---`);
  const res = await isapiRequest(device, {
    method: "GET",
    path: PATHS.status,
    timeoutMs: config.requestTimeoutMs,
  });
  console.log(res.ok ? "OK" : `FAIL: ${res.error || res.subStatusCode}`);
  console.log(preview(res.body || res.statusBody));
  return res;
};

const putHangUp = async (device, config) => {
  const body = JSON.stringify({ CallSignal: { cmdType: "hangUp" } });
  console.log("\n--- PUT callSignal hangUp ---");
  const res = await isapiRequest(device, {
    method: "PUT",
    path: PATHS.callSignal,
    body,
    timeoutMs: config.requestTimeoutMs,
  });
  console.log(res.ok ? "OK" : `FAIL: ${res.error || res.subStatusCode}`);
  if (res.body) console.log(preview(res.body));
  return res;
};

const forceIdleMain = async (device, config) => {
  printSection("清除主機通話狀態 → idle");
  let statusRes = await runStatusOn(device, config, "清除前");
  let status = extractStatus(statusRes);
  if (status === "idle") {
    console.log("主機已是 idle");
    return true;
  }
  for (let round = 1; round <= 3; round += 1) {
    await putHangUp(device, config);
    statusRes = await runStatusOn(device, config, `掛斷後 #${round}`);
    status = extractStatus(statusRes);
    if (status === "idle") {
      console.log("主機已回到 idle");
      return true;
    }
  }
  console.error(`主機仍非 idle（status=${status}），請到設備本機 UI 掛斷`);
  return false;
};

const runProbeIndoor = async (config) => {
  printSection("探測室內機身分");
  const device = {
    host: config.indoorHost,
    port: config.indoorPort,
    username: config.username,
    password: config.password,
  };
  for (const [name, path] of [
    ["deviceInfo", PATHS.deviceInfo],
    ["deviceId", PATHS.deviceId],
    ["deviceCommunication", PATHS.deviceCommunication],
    ["relatedDeviceAddress", PATHS.relatedDeviceAddress],
    ["callStatus", PATHS.status],
    ["callSignal/capabilities", PATHS.capabilities],
  ]) {
    console.log(`\n--- ${name} ---`);
    try {
      const res = await isapiRequest(device, {
        method: "GET",
        path,
        timeoutMs: config.requestTimeoutMs,
      });
      console.log(res.ok ? "OK" : `FAIL: ${res.error || res.subStatusCode}`);
      console.log(preview(res.body || res.statusBody, 2000));
    } catch (error) {
      console.log(`ERROR: ${error?.message || error}`);
    }
  }
};

const run = async () => {
  const { action, config } = parseCliArgs();
  if (!config.password) {
    console.error("請設定 SCRIPT_CONFIG.password 或 --password");
    process.exit(1);
  }

  const main = {
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
  };
  const indoor = {
    host: config.indoorHost,
    port: config.indoorPort,
    username: config.username,
    password: config.password,
  };

  printSection("視訊對講診斷");
  console.log(`主機：${config.host}／室內：${config.indoorHost}／動作：${action}`);

  switch (action) {
    case "status":
      await runStatusOn(main, config, "主機");
      await runStatusOn(indoor, config, "室內機");
      break;
    case "idle":
    case "force-idle":
      await forceIdleMain(main, config);
      break;
    case "hangUp":
    case "hangup":
      await putHangUp(main, config);
      await runStatusOn(main, config, "掛斷後");
      break;
    case "probe-indoor":
      await runProbeIndoor(config);
      break;
    case "call":
    case "request":
    case "dial":
      console.log(`
ISAPI／SDK 外撥不可行。請改用 SIP 直打室內：
  node scripts/testVideoIntercomSipInvite.js --host ${config.indoorHost} --to <VoIP號碼>
詳見 docs/40-systems/video-intercom-main-station.md
`);
      process.exitCode = 1;
      break;
    default:
      console.error(`未知動作：${action}（可用：status | idle | hangUp | probe-indoor）`);
      process.exit(1);
  }
};

run().catch((error) => {
  console.error(error?.message || error);
  if (error?.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
