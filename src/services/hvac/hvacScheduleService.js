const { createDoScheduleService } = require("../schedule/createDoScheduleService");

module.exports = createDoScheduleService({
  systemType: "hvac",
  rulesTable: "hvac_schedule_rules",
  locationsTable: "hvac_schedule_rule_locations",
  eventSource: "hvac_schedule",
  label: "空調",
  loggerName: "hvacScheduleService",
});
