/**
 * 新案場唯讀核對：主機＋室內身分／關聯／通話狀態／對講能力
 *
 *   node scripts/probeVideoIntercom.js
 *   node scripts/probeVideoIntercom.js --host 192.168.2.27 --indoor 192.168.2.78
 *
 * 層 1 listen／層 2 振鈴請用另外兩支腳本。
 * 詳見：docs/40-systems/video-intercom-main-station.md
 */

/* eslint-disable no-console */

const { invokeBridge } = require("../src/services/ladderSdk/sdkBridgeClient");

const SCRIPT_CONFIG = {
  host: "192.168.2.27",
  indoorHost: "192.168.2.78",
  port: 8000,
  username: "admin",
  password: "Aa83124007",
  requestTimeoutMs: 15000,
};

const PATHS = [
  { name: "deviceInfo", path: "/ISAPI/System/deviceInfo" },
  { name: "deviceId", path: "/ISAPI/VideoIntercom/deviceId" },
  { name: "callStatus", path: "/ISAPI/VideoIntercom/callStatus?format=json" },
  { name: "relatedDeviceAddress", path: "/ISAPI/VideoIntercom/relatedDeviceAddress" },
  { name: "VideoIntercom/capabilities", path: "/ISAPI/VideoIntercom/capabilities" },
];

const parseCliArgs = () => {
  const args = process.argv.slice(2);
  const result = { ...SCRIPT_CONFIG };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--host" && next) {
      result.host = next;
      i += 1;
    } else if (arg === "--indoor" && next) {
      result.indoorHost = next;
      i += 1;
    } else if (arg === "--password" && next) {
      result.password = next;
      i += 1;
    }
  }
  return result;
};

const printSection = (title) => {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
};

const preview = (text, max = 1800) => {
  const raw = String(text || "").trim();
  if (!raw) return "(empty)";
  return raw.length > max ? `${raw.slice(0, max)}\n... (truncated)` : raw;
};

const printIsapi = (item) => {
  const fail = item?.error || item?.subStatusCode || item?.errorCode;
  console.log(`\n--- ${item.name} ---`);
  console.log(item.ok ? "OK" : `FAIL: ${fail || "unknown"}`);
  if (item.path) console.log(`path: ${item.path}`);
  const body = item.body || item.statusBody;
  if (body) console.log(preview(body));
};

const probe = (device, timeoutMs) =>
  invokeBridge(
    {
      action: "ability.probe",
      device,
      payload: {
        isapiPaths: PATHS.map((item) => ({
          ...item,
          method: "GET",
          timeoutMs,
        })),
      },
    },
    { timeoutMs: 90_000 },
  );

const run = async () => {
  const config = parseCliArgs();
  if (!config.password) {
    console.error("請設定 SCRIPT_CONFIG.password 或 --password");
    process.exit(1);
  }

  const creds = {
    port: config.port,
    username: config.username,
    password: config.password,
  };

  printSection("對講唯讀核對（主機＋室內）");
  console.log(`主機 ${config.host}／室內 ${config.indoorHost}\n`);

  printSection("主機");
  const host = await probe({ ...creds, host: config.host }, config.requestTimeoutMs);
  for (const item of host?.isapi || []) printIsapi(item);

  printSection("室內");
  try {
    const indoor = await probe(
      { ...creds, host: config.indoorHost },
      config.requestTimeoutMs,
    );
    for (const item of indoor?.isapi || []) printIsapi(item);
    printSection("摘要");
    const rows = [
      ...(host?.isapi || []).map((item) => ({
        where: "主機",
        ...item,
      })),
      ...(indoor?.isapi || []).map((item) => ({
        where: "室內",
        ...item,
      })),
    ];
    rows.forEach((row) => {
      const mark = row.ok ? "OK  " : "FAIL";
      const detail = row.ok ? "" : row.subStatusCode || row.error || row.errorCode || "";
      console.log(`${mark}  [${row.where}] ${row.name}  ${detail}`);
    });
  } catch (error) {
    console.log(`室內探測失敗：${error?.message || error}`);
    process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error(error?.message || error);
  if (error?.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
