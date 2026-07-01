/**
 * YSCP Artemis 事件訂閱維運腳本（獨立版，先取消再訂閱）
 *
 * 直接呼叫 Artemis eventService API，不依賴後端 service / .env。
 *
 * 用法（於 ba-backend 目錄，先修改下方 SCRIPT_CONFIG）：
 *   node scripts/yscpResubscribe.js
 *   npm run yscp:resubscribe
 *
 * 僅取消／僅訂閱：
 *   node scripts/yscpResubscribe.js --unsubscribe-only
 *   node scripts/yscpResubscribe.js --subscribe-only
 */

/* eslint-disable no-console */

const axios = require("axios");
const https = require("https");
const crypto = require("crypto");

// ── 現場參數（直接修改此區）──────────────────────────────────────
const SCRIPT_CONFIG = {
  /** Artemis 主機 IP 或 hostname（不含 https://） */
  host: "192.168.2.2",
  accessKey: "",
  secretKey: "",
  /** BA 後端事件回呼 URL（YSCP 推播目標） */
  eventDest: "http://127.0.0.1:4000/api/yscp/event-receiver",
  eventToken: "anything",
  eventTypes: [130, 131, 131622, 196899, 198914],
  apiVersion: "v1",
  rejectUnauthorized: false,
  requestTimeoutMs: 30000,
};
// ─────────────────────────────────────────────────────────────────

const SUBSCRIBE_RETRY_COUNT = 3;
const SUBSCRIBE_RETRY_DELAY_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeHost = (raw) =>
  String(raw ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .split(":")[0];

const artemisPath = (apiVersion, action) =>
  `/artemis/api/eventService/${apiVersion}/${action}`;

const buildSignature = (secretKey, path, method = "POST") => {
  const accept = "application/json";
  const contentType = "application/json;charset=UTF-8";
  const plain = `${method}\n${accept}\n${contentType}\n${path}`;
  return crypto.createHmac("sha256", secretKey).update(plain).digest("base64");
};

const postArtemis = async (action, body) => {
  const host = `https://${normalizeHost(SCRIPT_CONFIG.host)}`;
  const path = artemisPath(SCRIPT_CONFIG.apiVersion, action);
  const fullUrl = `${host}${path}`;

  const response = await axios.post(fullUrl, body, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json;charset=UTF-8",
      "X-Ca-Key": SCRIPT_CONFIG.accessKey,
      "X-Ca-Signature": buildSignature(SCRIPT_CONFIG.secretKey, path),
    },
    httpsAgent: new https.Agent({
      rejectUnauthorized: SCRIPT_CONFIG.rejectUnauthorized,
    }),
    timeout: SCRIPT_CONFIG.requestTimeoutMs,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const hint =
      response.status === 404
        ? "（host 應為 Artemis 主機，非 BA 後端）"
        : "";
    const bodyText =
      typeof response.data === "string"
        ? response.data.slice(0, 200)
        : JSON.stringify(response.data);
    throw new Error(`HTTP ${response.status}${hint}\n${bodyText}`);
  }

  if (String(response.headers["content-type"] || "").includes("text/html")) {
    throw new Error("Artemis 回傳 HTML，host 可能不正確。");
  }

  return response.data;
};

const unsubscribeByEventTypes = async () => {
  console.log("→ POST eventUnSubscriptionByEventTypes", {
    eventTypes: SCRIPT_CONFIG.eventTypes,
  });
  return postArtemis("eventUnSubscriptionByEventTypes", {
    eventTypes: SCRIPT_CONFIG.eventTypes,
  });
};

const subscribeByEventTypes = async () => {
  console.log("→ POST eventSubscriptionByEventTypes", {
    eventTypes: SCRIPT_CONFIG.eventTypes,
    eventDest: SCRIPT_CONFIG.eventDest,
  });
  return postArtemis("eventSubscriptionByEventTypes", {
    eventTypes: SCRIPT_CONFIG.eventTypes,
    eventDest: SCRIPT_CONFIG.eventDest,
    token: SCRIPT_CONFIG.eventToken,
  });
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  return {
    unsubscribeOnly: args.includes("--unsubscribe-only"),
    subscribeOnly: args.includes("--subscribe-only"),
  };
};

const assertCredentials = () => {
  const ak = String(SCRIPT_CONFIG.accessKey ?? "").trim();
  const sk = String(SCRIPT_CONFIG.secretKey ?? "").trim();
  if (!ak || !sk) {
    throw new Error("請於腳本 SCRIPT_CONFIG 填入 accessKey 與 secretKey。");
  }
};

const printBanner = (mode) => {
  console.log("=".repeat(60));
  console.log("YSCP Artemis 事件訂閱維運（獨立腳本）");
  console.log("=".repeat(60));
  console.log(`模式：${mode}`);
  console.log(`Artemis 主機：https://${normalizeHost(SCRIPT_CONFIG.host)}`);
  console.log(`eventDest：${SCRIPT_CONFIG.eventDest}`);
  console.log(`eventTypes：${JSON.stringify(SCRIPT_CONFIG.eventTypes)}`);
  console.log("=".repeat(60));
  console.log();
};

const printResult = (label, data) => {
  console.log(`✅ ${label}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
};

const unsubscribeBestEffort = async () => {
  try {
    return await unsubscribeByEventTypes();
  } catch (error) {
    console.warn("⚠️ 取消訂閱失敗（略過，繼續訂閱）:", error?.message || String(error));
    return null;
  }
};

const subscribeWithRetry = async () => {
  let lastError;
  for (let attempt = 1; attempt <= SUBSCRIBE_RETRY_COUNT; attempt += 1) {
    try {
      return await subscribeByEventTypes();
    } catch (error) {
      lastError = error;
      if (attempt < SUBSCRIBE_RETRY_COUNT) {
        console.warn(
          `⚠️ 訂閱失敗，${SUBSCRIBE_RETRY_DELAY_MS / 1000}s 後重試 (${attempt}/${SUBSCRIBE_RETRY_COUNT})…`,
        );
        await sleep(SUBSCRIBE_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
};

const main = async () => {
  const cli = parseArgs();

  if (cli.unsubscribeOnly && cli.subscribeOnly) {
    throw new Error("不可同時指定 --unsubscribe-only 與 --subscribe-only");
  }

  assertCredentials();

  if (cli.unsubscribeOnly) {
    printBanner("僅取消訂閱");
    printResult("取消訂閱成功", await unsubscribeByEventTypes());
    return;
  }

  if (cli.subscribeOnly) {
    printBanner("僅訂閱");
    printResult("訂閱成功", await subscribeByEventTypes());
    return;
  }

  printBanner("先取消再訂閱");
  console.log("步驟 1：取消既有訂閱（best-effort，失敗仍繼續）…");
  await unsubscribeBestEffort();

  console.log("步驟 2：訂閱…");
  printResult("先取消再訂閱成功", await subscribeWithRetry());
};

main().catch((err) => {
  console.error();
  console.error("❌ YSCP 訂閱腳本失敗:", err?.message || String(err));
  process.exitCode = 1;
});
