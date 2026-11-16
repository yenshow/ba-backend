const logger = require("../../utils/logger").createLogger(
  "lightingScheduleScheduler",
);
const { reconcileDueEdges } = require("./lightingScheduleService");

const INTERVAL_MS = 60 * 1000;
let timer = null;

const tick = () => {
  void reconcileDueEdges().catch((error) => {
    logger.warn("照明排程 tick 失敗", {
      error: error?.message || String(error),
    });
  });
};

const startLightingScheduleScheduler = () => {
  if (timer) return;
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  tick();
};

const stopLightingScheduleScheduler = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};

module.exports = {
  startLightingScheduleScheduler,
  stopLightingScheduleScheduler,
};
