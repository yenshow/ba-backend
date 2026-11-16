const logger = require("../../utils/logger").createLogger("hvacScheduleScheduler");
const { reconcileDueEdges } = require("./hvacScheduleService");

const INTERVAL_MS = 60 * 1000;
let timer = null;

const tick = () => {
  void reconcileDueEdges().catch((error) => {
    logger.warn("空調排程 tick 失敗", {
      error: error?.message || String(error),
    });
  });
};

const startHvacScheduleScheduler = () => {
  if (timer) return;
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  tick();
};

const stopHvacScheduleScheduler = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};

module.exports = {
  startHvacScheduleScheduler,
  stopHvacScheduleScheduler,
};
