const { createDoScheduleTicker } = require("../schedule/createDoScheduleTicker");
const { reconcileDueEdges } = require("./hvacScheduleService");

const ticker = createDoScheduleTicker({
  loggerName: "hvacScheduleScheduler",
  reconcile: reconcileDueEdges,
});

module.exports = {
  startHvacScheduleScheduler: ticker.start,
  stopHvacScheduleScheduler: ticker.stop,
};
