const { createDoScheduleTicker } = require("../schedule/createDoScheduleTicker");
const { reconcileDueEdges } = require("./lightingScheduleService");

const ticker = createDoScheduleTicker({
  loggerName: "lightingScheduleScheduler",
  reconcile: reconcileDueEdges,
});

module.exports = {
  startLightingScheduleScheduler: ticker.start,
  stopLightingScheduleScheduler: ticker.stop,
};
