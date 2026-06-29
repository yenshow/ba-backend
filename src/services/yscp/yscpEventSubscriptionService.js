/**
 * YSCP Artemis 事件訂閱／取消訂閱
 */
const config = require("../../config");
const logger = require("../../utils/logger");
const yscpArtemisClient = require("./yscpArtemisClient");

const serviceLogger = logger.createLogger("YSCP Event Subscription");

const SUBSCRIBE_RETRY_COUNT = 3;
const SUBSCRIBE_RETRY_DELAY_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const hasArtemisCredentials = (credentials) => {
  const ak = String(credentials?.accessKey ?? config.yscp.accessKey ?? "").trim();
  const sk = String(credentials?.secretKey ?? config.yscp.secretKey ?? "").trim();
  return Boolean(ak && sk);
};

const resolveEventTypes = (eventTypes) =>
  Array.isArray(eventTypes) && eventTypes.length > 0
    ? eventTypes
    : config.yscp.eventTypes;

const postEventService = async (action, body, credentials) => {
  const creds = yscpArtemisClient.resolveCredentials(credentials);
  const path = yscpArtemisClient.artemisPath(creds.apiVersion, action);
  const response = await yscpArtemisClient.post(path, body, {
    credentials: creds,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const hint =
      response.status === 404
        ? "（YSCP_HOST 應為 Artemis 主機，非 BA 後端）"
        : "";
    const bodyText =
      typeof response.data === "string"
        ? response.data.slice(0, 200)
        : JSON.stringify(response.data);
    throw new Error(`HTTP ${response.status}${hint}\n${bodyText}`);
  }

  if (String(response.headers["content-type"] || "").includes("text/html")) {
    throw new Error("Artemis 回傳 HTML，YSCP_HOST 可能不正確。");
  }

  return response.data;
};

const unsubscribeByEventTypes = async (eventTypes, credentials) => {
  const types = resolveEventTypes(eventTypes);
  serviceLogger.info("取消 YSCP 事件訂閱", { eventTypes: types });
  return postEventService(
    "eventUnSubscriptionByEventTypes",
    { eventTypes: types },
    credentials,
  );
};

const subscribeByEventTypes = async ({
  eventTypes,
  eventDest,
  token,
  credentials,
} = {}) => {
  const types = resolveEventTypes(eventTypes);
  const dest = eventDest || config.yscp.eventDest;
  const eventToken = token ?? config.yscp.eventToken;

  serviceLogger.info("訂閱 YSCP 事件", {
    eventTypes: types,
    eventDest: dest,
  });

  return postEventService(
    "eventSubscriptionByEventTypes",
    {
      eventTypes: types,
      eventDest: dest,
      token: eventToken,
    },
    credentials,
  );
};

const unsubscribeBestEffort = async (eventTypes, credentials) => {
  try {
    await unsubscribeByEventTypes(eventTypes, credentials);
  } catch (error) {
    serviceLogger.warn("取消 YSCP 事件訂閱失敗（略過，繼續訂閱）", {
      error: error?.message || String(error),
    });
  }
};

const subscribeWithRetry = async (options) => {
  let lastError;
  for (let attempt = 1; attempt <= SUBSCRIBE_RETRY_COUNT; attempt += 1) {
    try {
      return await subscribeByEventTypes(options);
    } catch (error) {
      lastError = error;
      if (attempt < SUBSCRIBE_RETRY_COUNT) {
        serviceLogger.warn("YSCP 事件訂閱失敗，將重試", {
          attempt,
          maxAttempts: SUBSCRIBE_RETRY_COUNT,
          error: error?.message || String(error),
        });
        await sleep(SUBSCRIBE_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
};

const resubscribe = async (options = {}) => {
  const credentials = options.credentials;

  if (!hasArtemisCredentials(credentials)) {
    serviceLogger.warn("YSCP AK/SK 未設定，略過事件訂閱");
    return { subscribed: false, skipped: true, reason: "missing_credentials" };
  }

  await unsubscribeBestEffort(options.eventTypes, credentials);

  try {
    const data = await subscribeWithRetry({
      eventTypes: options.eventTypes,
      eventDest: options.eventDest,
      token: options.token,
      credentials,
    });
    return { subscribed: true, data };
  } catch (error) {
    serviceLogger.error("YSCP 事件訂閱失敗", {
      error: error?.message || String(error),
    });
    return { subscribed: false, error: error?.message || String(error) };
  }
};

module.exports = {
  unsubscribeByEventTypes,
  subscribeByEventTypes,
  resubscribe,
};
