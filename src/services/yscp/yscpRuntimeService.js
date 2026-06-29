/**
 * YSCP 外部 DB 連線與 Artemis 事件訂閱生命週期
 */
const config = require("../../config");
const externalDb = require("../../database/externalDb");
const logger = require("../../utils/logger");
const { isDatabaseEnabled } = require("../../utils/yscpSystemFeature");
const yscpEventSubscriptionService = require("./yscpEventSubscriptionService");

const runtimeLogger = logger.createLogger("YSCP Runtime");

let subscriptionActive = false;
let resubscribeInFlight = false;
let runtimeStarted = false;

const handleExternalDbReady = async ({ isReconnect }) => {
  if (resubscribeInFlight) {
    runtimeLogger.debug("YSCP 事件訂閱進行中，略過重複觸發");
    return;
  }

  resubscribeInFlight = true;
  try {
    const result = await yscpEventSubscriptionService.resubscribe();
    subscriptionActive = Boolean(result.subscribed);
    runtimeLogger.info("YSCP 外部 DB 就緒，事件訂閱流程已完成", {
      isReconnect,
      subscribed: result.subscribed,
      skipped: result.skipped,
      reason: result.reason,
    });
  } finally {
    resubscribeInFlight = false;
  }
};

const start = async () => {
  if (!isDatabaseEnabled()) {
    runtimeLogger.info("YSCP Runtime 已關閉（ENABLE_YSCP_DATABASE=false）");
    return;
  }

  if (runtimeStarted) {
    runtimeLogger.debug("YSCP Runtime 已啟動，略過重複 start");
    return;
  }

  runtimeStarted = true;
  runtimeLogger.info("啟動 YSCP Runtime（外部 DB 重試 + 事件訂閱）");

  await externalDb.ensureConnected(config.externalDatabase, {
    onConnected: handleExternalDbReady,
    retryIntervalMs: config.yscp.dbRetryIntervalMs,
  });
};

const stop = async () => {
  if (!runtimeStarted) {
    return;
  }

  externalDb.stopEnsureConnected();
  runtimeStarted = false;

  if (subscriptionActive) {
    try {
      await yscpEventSubscriptionService.unsubscribeByEventTypes();
      runtimeLogger.info("YSCP 事件訂閱已取消");
    } catch (error) {
      runtimeLogger.warn("YSCP 取消訂閱失敗", {
        error: error?.message || String(error),
      });
    }
  }
  subscriptionActive = false;

  await externalDb.close();
};

module.exports = {
  start,
  stop,
};
