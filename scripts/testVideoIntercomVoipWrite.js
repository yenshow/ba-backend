/**
 * 室內機 deviceCommunication 讀取／regNumber 寫入探測
 *
 * regNumber = 11 碼 VIS 組網編號（≠ SIP VoIP 短號；后者在本機 UI 設定）
 *
 *   npm run test:video-intercom-voip-write -- --password <pwd>
 *   npm run test:video-intercom-voip-write -- --reg 10010110001 --apply --password <pwd>
 *   npm run test:video-intercom-voip-write -- --to 1001 --verify-sip --password <pwd>
 *
 * 需先：npm run sdk:build
 * 詳見：docs/40-systems/video-intercom-main-station.md
 */

/* eslint-disable no-console */

const { invokeBridge } = require("../src/services/ladderSdk/sdkBridgeClient");
const {
  inviteIndoorRing,
} = require("../src/services/accessSecurity/sipInviteService");

const REG_NUMBER_LEN = 11;

const PATH_COMM = "/ISAPI/VideoIntercom/deviceCommunication?format=json";
const PATH_COMM_CAPS =
  "/ISAPI/VideoIntercom/deviceCommunication/capabilities?format=json";
const PATH_DEVICE_ID = "/ISAPI/VideoIntercom/deviceId";

const SCRIPT_CONFIG = {
  host: "192.168.2.78",
  port: 8000,
  username: "admin",
  password: "Aa83124007",
  regNumber: "",
  sipTo: "",
  sipPort: 5060,
  timeoutMs: 15000,
  apply: false,
  verifySip: false,
  restoreOnFail: true,
};

const parseCliArgs = () => {
  const args = process.argv.slice(2);
  const config = { ...SCRIPT_CONFIG };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--host" && next) {
      config.host = next;
      i += 1;
    } else if (arg === "--port" && next) {
      config.port = Number(next) || config.port;
      i += 1;
    } else if (arg === "--username" && next) {
      config.username = next;
      i += 1;
    } else if (arg === "--password" && next) {
      config.password = next;
      i += 1;
    } else if (arg === "--reg" && next) {
      config.regNumber = String(next).trim();
      i += 1;
    } else if ((arg === "--to" || arg === "--sip-to") && next) {
      config.sipTo = String(next).trim();
      i += 1;
    } else if (arg === "--sip-port" && next) {
      config.sipPort = Number(next) || config.sipPort;
      i += 1;
    } else if (arg === "--timeout" && next) {
      config.timeoutMs = Math.max(1000, Number(next) || config.timeoutMs);
      i += 1;
    } else if (arg === "--apply") {
      config.apply = true;
    } else if (arg === "--verify-sip") {
      config.verifySip = true;
    } else if (arg === "--no-restore") {
      config.restoreOnFail = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return config;
};

const printHelp = () => {
  console.log(`
用法：
  node scripts/testVideoIntercomVoipWrite.js [選項]

選項：
  --host <ip>       室內機 IP（預設 192.168.2.78）
  --password <pwd>  設備密碼（必填）
  --reg <11碼>      寫入 regNumber（需 --apply；必須 11 碼）
  --to <號碼>       SIP 振鈴驗證目標（需 --verify-sip；通常為 VoIP 短號如 1001）
  --apply           實際 PUT regNumber（預設唯讀）
  --verify-sip      SIP INVITE 振鈴驗證（用 --to，可單獨使用）
  --no-restore      寫入失敗時不還原
  --help            顯示說明
`);
};

const section = (title) =>
  console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);

const preview = (text, max = 2000) => {
  const raw = String(text || "").trim();
  if (!raw) return "(empty)";
  return raw.length > max ? `${raw.slice(0, max)}\n... (truncated)` : raw;
};

const tagValue = (xml, tag) => {
  const match = String(xml || "").match(
    new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"),
  );
  return match ? match[1].trim() : null;
};

const deviceOf = (config) => ({
  host: config.host,
  port: config.port,
  username: config.username,
  password: config.password,
});

const isapi = async (device, method, path, config, body) => {
  const res = await invokeBridge(
    {
      action: "isapi.request",
      device,
      payload: { method, path, body, timeoutMs: config.timeoutMs },
    },
    { timeoutMs: config.timeoutMs + 5000 },
  );
  return {
    ok: Boolean(res?.ok),
    fail: res?.error || res?.subStatusCode || res?.statusString,
    body: res?.body || res?.statusBody || "",
  };
};

const parseRegNumber = (body) => {
  try {
    return JSON.parse(body)?.DeviceCommunication?.regNumber ?? null;
  } catch {
    return null;
  }
};

const patchRegNumber = (snapshotBody, regNumber) => {
  const parsed = JSON.parse(snapshotBody);
  if (!parsed?.DeviceCommunication) {
    throw new Error("無法解析 DeviceCommunication");
  }
  parsed.DeviceCommunication.regNumber = regNumber;
  return JSON.stringify(parsed);
};

const readState = async (device, config) => {
  section("讀取 deviceCommunication");

  const [deviceId, comm, caps] = await Promise.all([
    isapi(device, "GET", PATH_DEVICE_ID, config),
    isapi(device, "GET", PATH_COMM, config),
    isapi(device, "GET", PATH_COMM_CAPS, config),
  ]);

  const unitType = tagValue(deviceId.body, "unitType");
  const regNumber = parseRegNumber(comm.body);
  const regLen = caps.ok
    ? caps.body
        .match(
          /"regNumber"[\s\S]*?"@min"\s*:\s*(\d+)[\s\S]*?"@max"\s*:\s*(\d+)/,
        )
        ?.slice(1)
    : null;

  console.log(
    `deviceId：${deviceId.ok ? "OK" : `FAIL (${deviceId.fail})`}  unitType=${unitType || "-"}`,
  );
  console.log(`deviceCommunication：${comm.ok ? "OK" : `FAIL (${comm.fail})`}`);
  console.log(`regNumber：${regNumber ?? "-"}`);
  if (regLen) {
    console.log(`regNumber 長度限制：${regLen[0]}～${regLen[1]} 碼`);
  }
  console.log("\n--- deviceCommunication ---");
  console.log(preview(comm.body));

  if (unitType && unitType !== "indoor") {
    console.warn(`警告：預期 indoor，實際 ${unitType}`);
  }

  return { unitType, regNumber, commBody: comm.body, commOk: comm.ok };
};

const writeRegNumber = async (device, config, snapshotBody, regNumber) => {
  section(`PUT regNumber → ${regNumber}`);
  const payload = patchRegNumber(snapshotBody, regNumber);
  console.log(preview(payload, 1200));

  const put = await isapi(device, "PUT", PATH_COMM, config, payload);
  console.log(put.ok ? "PUT OK" : `PUT FAIL: ${put.fail || "unknown"}`);
  if (put.body) console.log(preview(put.body, 800));
  if (!put.ok) return false;

  const got = await isapi(device, "GET", PATH_COMM, config);
  const readBack = parseRegNumber(got.body);
  const matched = readBack === regNumber;
  console.log(`讀回：${readBack ?? "(null)"}  ${matched ? "✓" : "✗"}`);
  return matched;
};

const restoreRegNumber = async (device, config, snapshotBody) => {
  section("還原 regNumber");
  const put = await isapi(device, "PUT", PATH_COMM, config, snapshotBody);
  console.log(put.ok ? "還原 OK" : `還原 FAIL: ${put.fail || "unknown"}`);
};

const verifySip = async (config) => {
  section(`SIP 振鈴 To=${config.sipTo}`);
  try {
    const result = await inviteIndoorRing({
      host: config.host,
      voipNumber: config.sipTo,
      sipPort: config.sipPort,
      username: config.username,
      password: config.password,
      holdMs: 2500,
      answerMs: 3000,
      silent: false,
    });
    const ok =
      result?.result === "ringing" ||
      result?.result === "ok" ||
      result?.statusCode === 180 ||
      result?.statusCode === 183;
    console.log(
      `結果：${result?.result || "unknown"}  status=${result?.statusCode ?? "-"}`,
    );
    console.log(ok ? "振鈴成功 ✓" : "振鈴失敗 ✗");
    return ok;
  } catch (error) {
    console.log(`錯誤：${error?.message || error}`);
    return false;
  }
};

const run = async () => {
  const config = parseCliArgs();
  if (!config.password) {
    console.error("請提供 --password");
    process.exit(1);
  }

  const device = deviceOf(config);
  section("室內機 regNumber 探測");
  console.log(
    `${config.host}:${config.port}  ${config.apply ? "寫入模式" : "唯讀"}`,
  );

  const state = await readState(device, config);

  if (config.verifySip) {
    if (!config.sipTo) {
      console.error("--verify-sip 需搭配 --to <SIP VoIP 短號>");
      process.exit(1);
    }
    const sipOk = await verifySip(config);
    if (!sipOk) process.exitCode = 1;
    if (!config.apply) return;
  }

  if (!config.apply) {
    console.log("\n提示：regNumber 為 VIS 組網 11 碼編號，≠ SIP VoIP 短號。");
    console.log(
      "寫入：--reg <11碼> --apply    SIP 驗證：--to 1001 --verify-sip",
    );
    return;
  }

  if (!config.regNumber) {
    console.error("寫入模式請提供 --reg <11碼>");
    process.exit(1);
  }
  if (config.regNumber.length !== REG_NUMBER_LEN) {
    console.error(
      `regNumber 必須 ${REG_NUMBER_LEN} 碼（目前 ${config.regNumber.length} 碼）`,
    );
    process.exit(1);
  }
  if (!state.commOk || !state.commBody) {
    console.error("無法 GET deviceCommunication");
    process.exit(1);
  }

  const ok = await writeRegNumber(
    device,
    config,
    state.commBody,
    config.regNumber,
  );
  if (!ok) {
    if (config.restoreOnFail)
      await restoreRegNumber(device, config, state.commBody);
    process.exitCode = 1;
    return;
  }

  if (config.verifySip && config.sipTo) {
    const sipOk = await verifySip(config);
    if (!sipOk) process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
