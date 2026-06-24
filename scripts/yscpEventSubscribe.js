/**
 * YSCP Artemis 事件訂閱（獨立腳本，僅依環境變數 / CLI）
 *
 * 外部網域：
 *   set HOSTINFO=https://yscp.example.com
 *   set AK=...
 *   set SK=...
 *   node scripts/yscpEventSubscribe.js subscribe --event-dest https://backend.example.com/api/yscp/event-receiver
 *
 * 本機同機（YSCP + BA 後端同一台）：
 *   node scripts/yscpEventSubscribe.js subscribe --local
 */

/* eslint-disable no-console */

const axios = require("axios");
const crypto = require("crypto");
const https = require("https");

const API_VER = "v1";
const DEFAULT_EVENT_TYPES = [196893, 131622];
const LOCAL = {
  hostinfo: "https://127.0.0.1",
  eventDest: "http://127.0.0.1:4000/api/yscp/event-receiver",
};

const argv = process.argv.slice(2);
const mode = argv[0] || "help";

const getArg = (name) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
};

const hasFlag = (name) => argv.includes(name);

const pick = (...values) => {
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
};

const normalizeHostinfo = (raw) => {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
};

const normalizeEventDest = (raw) => {
  try {
    const url = new URL(raw);
    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
    return url.toString();
  } catch {
    return raw;
  }
};

const parseEventTypes = () => {
  const raw = getArg("--event-types") || process.env.EVENT_TYPES;
  const list = String(raw || "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n));
  return list.length ? list : DEFAULT_EVENT_TYPES;
};

const loadConfig = () => {
  const isLocal = hasFlag("--local");
  const hostinfo = normalizeHostinfo(
    pick(getArg("--hostinfo"), process.env.HOSTINFO, isLocal && LOCAL.hostinfo),
  );
  const accessKey = pick(getArg("--ak"), process.env.AK);
  const secretKey = pick(getArg("--sk"), process.env.SK);
  const apiVer = pick(getArg("--api-ver"), process.env.API_VER, API_VER);

  if (!hostinfo) {
    throw new Error(
      "缺少 HOSTINFO。請設環境變數 HOSTINFO、--hostinfo，或本機使用 --local。",
    );
  }
  if (!accessKey || !secretKey) {
    throw new Error("缺少 AK / SK。請設環境變數 AK、SK 或 --ak、--sk。");
  }

  let eventDest = pick(getArg("--event-dest"), process.env.EVENT_DEST);
  if (!eventDest && isLocal) eventDest = LOCAL.eventDest;

  return {
    hostinfo,
    accessKey,
    secretKey,
    apiVer,
    isLocal,
    eventDest: eventDest ? normalizeEventDest(eventDest) : "",
    token: pick(getArg("--token"), process.env.EVENT_TOKEN, "anything"),
    eventTypes: parseEventTypes(),
  };
};

const artemisPath = (apiVer, action) =>
  `/artemis/api/eventService/${apiVer}/${action}`;

const sign = (sk, path, method = "POST") => {
  const accept = "application/json";
  const contentType = "application/json;charset=UTF-8";
  const plain = `${method}\n${accept}\n${contentType}\n${path}`;
  return crypto.createHmac("sha256", sk).update(plain).digest("base64");
};

const postArtemis = async (cfg, path, body = {}) => {
  const url = `${cfg.hostinfo}${path}`;
  const res = await axios.post(url, body, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json;charset=UTF-8",
      "X-Ca-Key": cfg.accessKey,
      "X-Ca-Signature": sign(cfg.secretKey, path),
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 30000,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    const hint =
      res.status === 404
        ? "（HOSTINFO 應為 YSCP Artemis，非 BA 後端 :4000；本機通常為 https://127.0.0.1）"
        : "";
    const bodyText =
      typeof res.data === "string" ? res.data.slice(0, 200) : JSON.stringify(res.data);
    throw new Error(`HTTP ${res.status}${hint}\n${bodyText}`);
  }
  if (String(res.headers["content-type"] || "").includes("text/html")) {
    throw new Error("Artemis 回傳 HTML，HOSTINFO 可能不正確。");
  }
  return res.data;
};

const logRequest = (label, cfg, path, extra = {}) => {
  console.log(label, { url: `${cfg.hostinfo}${path}`, ...extra });
};

const subscribe = async (cfg) => {
  if (!cfg.eventDest) {
    throw new Error("subscribe 需要 --event-dest、EVENT_DEST，或 --local。");
  }
  const path = artemisPath(cfg.apiVer, "eventSubscriptionByEventTypes");
  logRequest("訂閱", cfg, path, {
    eventTypes: cfg.eventTypes,
    eventDest: cfg.eventDest,
  });
  const data = await postArtemis(cfg, path, {
    eventTypes: cfg.eventTypes,
    eventDest: cfg.eventDest,
    token: cfg.token,
  });
  console.log("\n✅ 訂閱成功\n", JSON.stringify(data, null, 2));
};

const unsubscribe = async (cfg) => {
  const path = artemisPath(cfg.apiVer, "eventUnSubscriptionByEventTypes");
  logRequest("取消訂閱", cfg, path, { eventTypes: cfg.eventTypes });
  const data = await postArtemis(cfg, path, { eventTypes: cfg.eventTypes });
  console.log("\n✅ 取消訂閱成功\n", JSON.stringify(data, null, 2));
};

const status = async (cfg) => {
  const path = artemisPath(cfg.apiVer, "eventSubscriptionView");
  logRequest("查詢訂閱", cfg, path);
  const data = await postArtemis(cfg, path, {});
  console.log("\n✅ 訂閱狀態\n", JSON.stringify(data, null, 2));
};

const showHelp = () => {
  console.log(`YSCP Artemis 事件訂閱

模式:
  subscribe       訂閱事件
  unsubscribe     取消訂閱
  status          查詢訂閱狀態

外部網域:
  set HOSTINFO=https://yscp.example.com
  set AK=... & set SK=...
  node scripts/yscpEventSubscribe.js subscribe --event-dest https://backend.example.com/api/yscp/event-receiver

本機同機:
  node scripts/yscpEventSubscribe.js subscribe --local

環境變數: HOSTINFO, AK, SK, API_VER, EVENT_DEST, EVENT_TYPES, EVENT_TOKEN
參數: --hostinfo --ak --sk --api-ver --event-dest --event-types --token --local`);
};

async function main() {
  if (["help", "--help", "-h"].includes(mode)) {
    showHelp();
    return;
  }

  const cfg = loadConfig();
  console.log("設定", {
    hostinfo: cfg.hostinfo,
    apiVer: cfg.apiVer,
    accessKey: cfg.accessKey,
    local: cfg.isLocal,
  });

  switch (mode) {
    case "subscribe":
      await subscribe(cfg);
      break;
    case "unsubscribe":
      await unsubscribe(cfg);
      break;
    case "status":
      await status(cfg);
      break;
    default:
      console.error(`未知模式: ${mode}`);
      showHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\n❌", err.message || err);
  process.exit(1);
});
