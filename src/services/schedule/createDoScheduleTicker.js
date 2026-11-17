/**
 * DO 排程 ticker：每 15s 對齊，降低整分漏觸發
 */
function createDoScheduleTicker({ loggerName, reconcile }) {
  const logger = require("../../utils/logger").createLogger(loggerName);
  const INTERVAL_MS = 15 * 1000;
  let timer = null;

  const tick = () => {
    void Promise.resolve()
      .then(() => reconcile())
      .catch((error) => {
        logger.warn(`${loggerName} tick 失敗`, {
          error: error?.message || String(error),
        });
      });
  };

  const start = () => {
    if (timer) return;
    timer = setInterval(tick, INTERVAL_MS);
    if (typeof timer.unref === "function") timer.unref();
    tick();
  };

  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  return { start, stop };
}

module.exports = { createDoScheduleTicker };
