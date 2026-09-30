const logger = require("../../utils/logger").createLogger("rollCallScheduler");
const { reconcileTodayQueued } = require("./rollCallService");

const INTERVAL_MS = 60 * 1000;
let timer = null;

const tick = () => {
  void reconcileTodayQueued().catch((error) => {
    logger.warn("時段簽到排程失敗", {
      error: error?.message || String(error),
    });
  });
};

const startRollCallScheduler = () => {
  if (timer) return;
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  tick();
};

const stopRollCallScheduler = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};

module.exports = {
  startRollCallScheduler,
  stopRollCallScheduler,
};
