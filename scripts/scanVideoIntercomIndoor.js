/**
 * 掃描網段，找出 ManageAddress 指向指定管理中心主機的室內機。
 *
 * 主機 ISAPI 不會回傳室內機清單；關聯存在各室內機的 relatedDeviceAddress。
 *
 *   node scripts/scanVideoIntercomIndoor.js
 *   node scripts/scanVideoIntercomIndoor.js --manage 192.168.2.27
 *   node scripts/scanVideoIntercomIndoor.js --manage 192.168.2.27 --from 70 --to 90
 *   node scripts/scanVideoIntercomIndoor.js --hosts 192.168.2.78,192.168.2.79
 *
 * 需先：npm run sdk:build
 * 詳見：docs/40-systems/video-intercom-main-station.md
 */

/* eslint-disable no-console */

const { invokeBridge } = require("../src/services/ladderSdk/sdkBridgeClient");

const SCRIPT_CONFIG = {
  manageHost: "192.168.2.27",
  port: 8000,
  username: "admin",
  password: "",
  from: 1,
  to: 254,
  concurrency: 6,
  requestTimeoutMs: 8000,
  showAllTypes: false,
  verbose: false,
};

const PATHS = {
  deviceInfo: "/ISAPI/System/deviceInfo",
  deviceId: "/ISAPI/VideoIntercom/deviceId",
  relatedDeviceAddress: "/ISAPI/VideoIntercom/relatedDeviceAddress",
  deviceCommunication: "/ISAPI/VideoIntercom/deviceCommunication?format=json",
};

const parseCliArgs = () => {
  const args = process.argv.slice(2);
  const result = { ...SCRIPT_CONFIG, hosts: null };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "--manage" && next) {
      result.manageHost = next;
      i += 1;
    } else if (arg === "--hosts" && next) {
      result.hosts = next.split(",").map((item) => item.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--from" && next) {
      result.from = Number(next);
      i += 1;
    } else if (arg === "--to" && next) {
      result.to = Number(next);
      i += 1;
    } else if (arg === "--port" && next) {
      result.port = Number(next);
      i += 1;
    } else if (arg === "--username" && next) {
      result.username = next;
      i += 1;
    } else if (arg === "--password" && next) {
      result.password = next;
      i += 1;
    } else if (arg === "--concurrency" && next) {
      result.concurrency = Math.max(1, Number(next) || 6);
      i += 1;
    } else if (arg === "--timeout" && next) {
      result.requestTimeoutMs = Math.max(1000, Number(next) || 8000);
      i += 1;
    } else if (arg === "--show-all") {
      result.showAllTypes = true;
    } else if (arg === "--verbose" || arg === "-v") {
      result.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return result;
};

const printHelp = () => {
  console.log(`
用法：
  node scripts/scanVideoIntercomIndoor.js [選項]

選項：
  --manage <ip>       管理中心主機 IP（預設 192.168.2.27）
  --hosts <a,b,c>     只掃指定 IP（逗號分隔）；略過 --from/--to
  --from <n>          掃描末段起始（預設 1）
  --to <n>            掃描末段結束（預設 254）
  --password <pwd>    設備登入密碼
  --username <user>   設備登入帳號（預設 admin）
  --port <n>          SDK 端口（預設 8000）
  --concurrency <n>   並行數（預設 6）
  --timeout <ms>      單次 ISAPI 逾時（預設 8000）
  --show-all          列出網段內所有對講設備類型
  --verbose, -v       顯示每台設備詳細 XML/JSON
  --help, -h          顯示說明
`);
};

const tagValue = (xml, tag) => {
  const match = String(xml || "").match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"));
  return match ? match[1].trim() : null;
};

const parseManageAddress = (body) => {
  const block = String(body || "").match(/<ManageAddress[\s\S]*?<\/ManageAddress>/i);
  return block ? tagValue(block[0], "ipAddress") : null;
};

const formatRoomLabel = (body) => {
  const parts = ["periodNumber", "buildingNumber", "unitNumber", "floorNumber", "roomNumber"]
    .map((tag) => tagValue(body, tag))
    .filter(Boolean);
  return parts.length ? parts.join("-") : "-";
};

const buildHostList = (config) => {
  if (Array.isArray(config.hosts) && config.hosts.length) {
    return [...new Set(config.hosts)];
  }

  const octets = String(config.manageHost).split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isFinite(value))) {
    throw new Error(`無效的 --manage IP：${config.manageHost}`);
  }

  const [a, b, c] = octets;
  const from = Math.max(1, Math.min(254, config.from));
  const to = Math.max(from, Math.min(254, config.to));
  const hosts = [];

  for (let d = from; d <= to; d += 1) {
    hosts.push(`${a}.${b}.${c}.${d}`);
  }

  return hosts;
};

const isapiGet = async (device, path, timeoutMs) => {
  try {
    const res = await invokeBridge(
      {
        action: "isapi.request",
        device,
        payload: { method: "GET", path, timeoutMs },
      },
      { timeoutMs: timeoutMs + 5000 },
    );
    return res?.body || res?.statusBody || "";
  } catch (error) {
    return { error: error?.message || String(error) };
  }
};

const isLinkedToManage = (manageHost, manageAddress, communicationBody) => {
  if (manageAddress === manageHost) return true;
  if (typeof communicationBody !== "string") return false;
  try {
    const list = JSON.parse(communicationBody)?.DeviceCommunication?.ServerAddressList || [];
    return list.some(
      (item) => item?.unitType === "manage" && item?.ipAddress === manageHost,
    );
  } catch {
    return false;
  }
};

const probeHost = async (host, config) => {
  const device = {
    host,
    port: config.port,
    username: config.username,
    password: config.password,
  };

  const deviceIdBody = await isapiGet(device, PATHS.deviceId, config.requestTimeoutMs);
  if (typeof deviceIdBody !== "string") {
    return { host, reachable: false, error: deviceIdBody.error || "deviceId 失敗" };
  }

  const unitType = tagValue(deviceIdBody, "unitType") || "unknown";
  if (unitType !== "indoor" && !config.showAllTypes) {
    return { host, reachable: true, unitType, linkedToTarget: false };
  }

  const requests = [
    isapiGet(device, PATHS.deviceInfo, config.requestTimeoutMs),
    isapiGet(device, PATHS.relatedDeviceAddress, config.requestTimeoutMs),
  ];
  if (unitType === "indoor") {
    requests.push(isapiGet(device, PATHS.deviceCommunication, config.requestTimeoutMs));
  }

  const [deviceInfoBody, relatedBody, communicationBody] = await Promise.all(requests);

  const model =
    typeof deviceInfoBody === "string" ? tagValue(deviceInfoBody, "model") : null;
  const manageAddress =
    typeof relatedBody === "string" ? parseManageAddress(relatedBody) : null;
  const regNumber =
    typeof communicationBody === "string"
      ? (() => {
          try {
            return JSON.parse(communicationBody)?.DeviceCommunication?.regNumber || null;
          } catch {
            return null;
          }
        })()
      : null;

  const linkedToTarget = isLinkedToManage(
    config.manageHost,
    manageAddress,
    communicationBody,
  );

  return {
    host,
    reachable: true,
    unitType,
    model,
    roomLabel: unitType === "indoor" ? formatRoomLabel(deviceIdBody) : "-",
    regNumber,
    manageAddress,
    linkedToTarget,
    raw: config.verbose
      ? { deviceId: deviceIdBody, deviceInfo: deviceInfoBody, relatedDeviceAddress: relatedBody, deviceCommunication: communicationBody }
      : undefined,
  };
};

const runPool = async (items, concurrency, worker) => {
  const results = new Array(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index]);
      }
    }),
  );

  return results;
};

const printSection = (title) => {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
};

const printMatchedTable = (rows) => {
  if (!rows.length) {
    console.log("（無）");
    return;
  }

  const header = [
    "IP".padEnd(16),
    "型號".padEnd(18),
    "房號".padEnd(12),
    "regNumber".padEnd(14),
    "ManageAddress",
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const row of rows) {
    console.log(
      [
        row.host.padEnd(16),
        String(row.model || "-").padEnd(18),
        String(row.roomLabel || "-").padEnd(12),
        String(row.regNumber || "-").padEnd(14),
        row.manageAddress || "-",
      ].join("  "),
    );
  }
};

const run = async () => {
  const config = parseCliArgs();
  if (!config.password) {
    console.error("請設定 SCRIPT_CONFIG.password 或 --password");
    process.exit(1);
  }

  const hosts = buildHostList(config);
  printSection("視訊對講室內機掃描");
  console.log(`管理中心主機：${config.manageHost}`);
  console.log(`掃描目標：${hosts.length} 個 IP（並行 ${config.concurrency}）`);

  const startedAt = Date.now();
  let done = 0;

  const results = await runPool(hosts, config.concurrency, async (host) => {
    const result = await probeHost(host, config);
    done += 1;
    if (done % 10 === 0 || done === hosts.length || result.linkedToTarget) {
      process.stdout.write(`\r進度 ${done}/${hosts.length}`.padEnd(40));
    }
    return result;
  });

  process.stdout.write("\n");

  const reachable = results.filter((item) => item.reachable);
  const matched = reachable.filter((item) => item.unitType === "indoor" && item.linkedToTarget);
  const otherIndoor = reachable.filter(
    (item) => item.unitType === "indoor" && !item.linkedToTarget,
  );
  const otherTypes = reachable.filter((item) => item.unitType !== "indoor");

  printSection(`關聯 ${config.manageHost} 的室內機（${matched.length} 台）`);
  printMatchedTable(matched);

  if (otherIndoor.length) {
    printSection(`其他室內機（ManageAddress ≠ ${config.manageHost}，${otherIndoor.length} 台）`);
    printMatchedTable(otherIndoor);
  }

  if (config.showAllTypes && otherTypes.length) {
    printSection(`網段內其他對講設備（${otherTypes.length} 台）`);
    for (const row of otherTypes) {
      console.log(
        `${row.host.padEnd(16)}  ${String(row.unitType).padEnd(8)}  ${String(row.model || "-").padEnd(18)}  manage=${row.manageAddress || "-"}`,
      );
    }
  }

  if (config.verbose) {
    printSection("詳細回應");
    for (const row of [...matched, ...otherIndoor]) {
      console.log(`\n--- ${row.host} ---`);
      console.log(JSON.stringify(row.raw, null, 2));
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  printSection("摘要");
  console.log(
    `掃描 ${hosts.length} IP，可連線 ${reachable.length}，關聯室內機 ${matched.length}，耗時 ${elapsedSec}s`,
  );

  if (!matched.length) {
    process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error(error?.message || error);
  if (error?.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
