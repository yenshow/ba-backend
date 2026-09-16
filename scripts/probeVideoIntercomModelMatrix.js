/**
 * 視訊對講多型號能力矩陣（對照 docs/40-systems/video-intercom-main-station.md）
 *
 *   npm run probe:video-intercom-matrix
 *   node scripts/probeVideoIntercomModelMatrix.js --out uploads/probes/matrix.json
 */
/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");
const { invokeBridge } = require("../src/services/ladderSdk/sdkBridgeClient");

const PASSWORD = "Aa83124007";
const PORT = 8000;
const USERNAME = "admin";

/** 現場設備清單（與設備管理頁一致） */
const DEVICES = [
  {
    role: "indoor",
    label: "室內機01",
    modelHint: "YS-KH6350-WTE1",
    host: "192.168.2.78",
  },
  {
    role: "indoor",
    label: "室內機02",
    modelHint: "YS-9510-WTE1",
    host: "192.168.2.74",
  },
  {
    role: "indoor",
    label: "室內機03",
    modelHint: "YS-8520-WTE1",
    host: "192.168.2.75",
  },
  {
    role: "indoor",
    label: "室內機04",
    modelHint: "YS-KH8380-WTE1",
    host: "192.168.2.79",
  },
  {
    role: "manage",
    label: "管理中心主機",
    modelHint: "YS 9503",
    host: "192.168.2.27",
  },
];

const ISAPI_GETS = [
  { key: "deviceInfo", path: "/ISAPI/System/deviceInfo" },
  { key: "videoIntercomCapabilities", path: "/ISAPI/VideoIntercom/capabilities" },
  { key: "callStatus", path: "/ISAPI/VideoIntercom/callStatus?format=json" },
  { key: "deviceId", path: "/ISAPI/VideoIntercom/deviceId" },
  { key: "relatedDeviceAddress", path: "/ISAPI/VideoIntercom/relatedDeviceAddress" },
  { key: "operationTime", path: "/ISAPI/VideoIntercom/operationTime" },
  {
    key: "callElevatorCapabilities",
    path: "/ISAPI/VideoIntercom/callElevator/capabilities",
  },
  { key: "twoWayAudio", path: "/ISAPI/System/TwoWayAudio/channels/1" },
  { key: "audioIn", path: "/ISAPI/System/Audio/AudioIn/channels/1" },
  { key: "audioOut", path: "/ISAPI/System/Audio/AudioOut/channels/1" },
  {
    key: "eventCardLinkageCapabilities",
    path: "/ISAPI/AccessControl/EventCardLinkage/capabilities",
  },
  {
    key: "noticeDataCapabilities",
    path: "/ISAPI/VideoIntercom/noticeData/capabilities",
  },
];

const parseArgs = () => {
  const args = process.argv.slice(2);
  let out = "";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--out" && args[i + 1]) {
      out = args[i + 1];
      i += 1;
    }
  }
  return { out };
};

const deviceCreds = (host) => ({
  host,
  port: PORT,
  username: USERNAME,
  password: PASSWORD,
});

const summarizeIsapi = (result) => {
  if (!result) {
    return { ok: false, reason: "no_response" };
  }
  if (result.ok) {
    return {
      ok: true,
      preview: String(result.body || "").replace(/\s+/g, " ").slice(0, 220),
    };
  }
  return {
    ok: false,
    reason:
      result.subStatusCode ||
      result.statusString ||
      result.error ||
      String(result.errorCode || "fail"),
  };
};

const extractXml = (body, tag) => {
  const m = String(body || "").match(
    new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i"),
  );
  return m ? m[1].trim() : "";
};

const extractCapFlags = (body) => {
  const flags = {};
  const re = /<(isSupport[A-Za-z0-9]+)>(true|false)<\/\1>/gi;
  let m;
  while ((m = re.exec(String(body || ""))) !== null) {
    flags[m[1]] = m[2].toLowerCase() === "true";
  }
  return flags;
};

const runIsapi = async (device, method, isapiPath, body) => {
  try {
    return await invokeBridge({
      action: "isapi.request",
      device,
      payload: { method, path: isapiPath, body, timeoutMs: 12000 },
    });
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      errorCode: error.details?.errorCode,
      subStatusCode: error.details?.subStatusCode,
    };
  }
};

const runControl = async (device) => {
  try {
    const data = await invokeBridge({
      action: "control.gateway",
      device,
      payload: { gatewayIndex: 1, command: 1 },
    });
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      reason: error.message,
      errorCode: error.details?.errorCode,
    };
  }
};

const runVoice = async (device) => {
  try {
    const data = await invokeBridge(
      {
        action: "voice.probe",
        device,
        payload: { voiceChan: 1, holdMs: 800, clientVolume: 0xffff },
      },
      { timeoutMs: 20_000 },
    );
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      reason: error.message,
      errorCode: error.details?.errorCode,
    };
  }
};

const tryVolumeWrite = async (device, getBody) => {
  const speaker = extractXml(getBody, "speakerVolume") || "7";
  const mic = extractXml(getBody, "microphoneVolume") || speaker;
  const enabled = extractXml(getBody, "enabled") || "false";
  const codecRaw = extractXml(getBody, "audioCompressionType") || "G.711ulaw";
  // 部分機型回 UNKOWN（拼字），原樣 PUT 會 badXmlContent
  const codec =
    !codecRaw || /^unkown$/i.test(codecRaw) || /^unknown$/i.test(codecRaw)
      ? "G.711ulaw"
      : codecRaw;
  const noise = extractXml(getBody, "noisereduce") || "false";
  const input = extractXml(getBody, "audioInputType") || "MicIn";

  // 寫回原值（驗證寫入路徑，不改變現場音量）
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<TwoWayAudioChannel version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
  <id>1</id>
  <enabled>${enabled}</enabled>
  <audioCompressionType>${codec}</audioCompressionType>
  <speakerVolume>${speaker}</speakerVolume>
  <microphoneVolume>${mic}</microphoneVolume>
  <noisereduce>${noise}</noisereduce>
  <audioInputType>${input}</audioInputType>
</TwoWayAudioChannel>`;

  const put = await runIsapi(
    device,
    "PUT",
    "/ISAPI/System/TwoWayAudio/channels/1",
    body,
  );
  return summarizeIsapi(put);
};

const tryCallElevatorPut = async (device) => {
  const put = await runIsapi(
    device,
    "PUT",
    "/ISAPI/VideoIntercom/callElevator",
    `<?xml version="1.0" encoding="UTF-8"?>
<CallElevatorCfg version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
  <floorNumber>1</floorNumber>
</CallElevatorCfg>`,
  );
  return summarizeIsapi(put);
};

const probeOne = async (entry) => {
  const device = deviceCreds(entry.host);
  console.log(`\n>>> ${entry.label} ${entry.host} (${entry.modelHint})`);

  const row = {
    ...entry,
    probedAt: new Date().toISOString(),
    reachable: false,
    model: "",
    firmware: "",
    unitType: "",
    isapi: {},
    capabilityFlags: {},
    features: {},
  };

  for (const item of ISAPI_GETS) {
    const result = await runIsapi(device, "GET", item.path);
    row.isapi[item.key] = summarizeIsapi(result);
    if (item.key === "deviceInfo" && result?.ok) {
      row.reachable = true;
      row.model = extractXml(result.body, "model") || entry.modelHint;
      row.firmware = extractXml(result.body, "firmwareVersion");
    }
    if (item.key === "deviceId" && result?.ok) {
      row.unitType = extractXml(result.body, "unitType");
    }
    if (item.key === "videoIntercomCapabilities" && result?.ok) {
      row.capabilityFlags = extractCapFlags(result.body);
    }
  }

  if (!row.reachable) {
    row.features = {
      identityRead: { status: "unavailable", note: "連線失敗" },
    };
    console.log("  UNREACHABLE");
    return row;
  }

  const twoWayBody = row.isapi.twoWayAudio?.ok
    ? (
        await runIsapi(
          device,
          "GET",
          "/ISAPI/System/TwoWayAudio/channels/1",
        )
      )?.body
    : "";

  const volumeWrite = row.isapi.twoWayAudio?.ok
    ? await tryVolumeWrite(device, twoWayBody)
    : { ok: false, reason: "twoWayAudio_get_failed" };

  const callElevatorPut = row.isapi.callElevatorCapabilities?.ok
    ? await tryCallElevatorPut(device)
    : { ok: false, reason: "no_capabilities" };

  const control = await runControl(device);
  const voice = await runVoice(device);

  row.features = {
    identityRead: {
      status: row.isapi.deviceInfo?.ok ? "supported" : "unsupported",
      note: "設備資訊／型號／韌體",
    },
    intercomCapabilityRead: {
      status: row.isapi.videoIntercomCapabilities?.ok
        ? "supported"
        : "unsupported",
      note: "VideoIntercom capabilities",
    },
    callStatusRead: {
      status: row.isapi.callStatus?.ok ? "supported" : "unsupported",
      note: "通話狀態 idle／ringing…",
    },
    deviceIdRead: {
      status: row.isapi.deviceId?.ok ? "supported" : "unsupported",
      note: `unitType=${row.unitType || "?"}`,
    },
    relatedAddressRead: {
      status: row.isapi.relatedDeviceAddress?.ok ? "supported" : "unsupported",
      note: "Manage／SIP／門口關聯",
    },
    operationTimeRead: {
      status: row.isapi.operationTime?.ok ? "supported" : "unsupported",
      note: "振鈴／監看逾時",
    },
    volumeRead: {
      status: row.isapi.twoWayAudio?.ok ? "supported" : "unsupported",
      note: "對講喇叭／麥克風音量讀取",
    },
    volumeWrite: {
      status: volumeWrite.ok ? "supported" : "unsupported",
      note: volumeWrite.ok
        ? "TwoWayAudio PUT（寫回原值驗證）"
        : volumeWrite.reason,
    },
    audioInRead: {
      status: row.isapi.audioIn?.ok ? "supported" : "unsupported",
      note: "錄音／輸入音量讀取",
    },
    audioOutRead: {
      status: row.isapi.audioOut?.ok ? "supported" : "unsupported",
      note: "輸出／對講音量讀取",
    },
    callElevatorCapability: {
      status: row.isapi.callElevatorCapabilities?.ok
        ? "supported"
        : "unsupported",
      note: "呼梯能力宣告",
    },
    callElevatorCommand: {
      status: callElevatorPut.ok ? "supported" : "unsupported",
      note: callElevatorPut.ok
        ? "PUT callElevator"
        : callElevatorPut.reason || "不可執行",
    },
    remoteGatewayControl: {
      status: control.ok ? "supported" : "unsupported",
      note: control.ok
        ? "ControlGateway Open"
        : `${control.reason || ""} (${control.errorCode ?? ""})`.trim(),
    },
    sdkVoiceTalk: {
      status: voice.ok ? "supported" : "unsupported",
      note: voice.ok
        ? "StartVoiceCom_V30"
        : `${voice.reason || ""} (${voice.errorCode ?? ""})`.trim(),
    },
    eventCardLinkage: {
      status: row.isapi.eventCardLinkageCapabilities?.ok
        ? "supported"
        : "unsupported",
      note: row.isapi.eventCardLinkageCapabilities?.ok
        ? "Event Card Linkage"
        : row.isapi.eventCardLinkageCapabilities?.reason,
    },
    noticeUploadApi: {
      status: row.isapi.noticeDataCapabilities?.ok
        ? "supported"
        : "unsupported",
      note: row.isapi.noticeDataCapabilities?.ok
        ? "noticeData capabilities"
        : row.isapi.noticeDataCapabilities?.reason,
    },
  };

  const marks = Object.entries(row.features)
    .map(([k, v]) => `${v.status === "supported" ? "Y" : "N"}:${k}`)
    .join(" ");
  console.log(`  model=${row.model} fw=${row.firmware} ${marks}`);
  return row;
};

const main = async () => {
  const { out } = parseArgs();
  const results = [];
  for (const entry of DEVICES) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await probeOne(entry));
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    devices: results,
  };

  printSection("摘要");
  for (const row of results) {
    if (!row.reachable) {
      console.log(`${row.label} ${row.host}  UNREACHABLE`);
      continue;
    }
    const ok = Object.entries(row.features)
      .filter(([, v]) => v.status === "supported")
      .map(([k]) => k);
    const bad = Object.entries(row.features)
      .filter(([, v]) => v.status !== "supported")
      .map(([k]) => k);
    console.log(
      `${row.label}  ${row.model}  ${row.host}  OK=${ok.length}  NG=${bad.length}`,
    );
    console.log(`  OK: ${ok.join(", ") || "-"}`);
    console.log(`  NG: ${bad.join(", ") || "-"}`);
  }

  if (out) {
    const abs = path.resolve(out);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`\n已寫入 ${abs}`);
  }
};

const printSection = (title) => {
  console.log(`\n${"=".repeat(64)}\n${title}\n${"=".repeat(64)}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
