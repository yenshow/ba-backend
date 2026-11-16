const { createDoScheduleService } = require("../schedule/createDoScheduleService");

module.exports = createDoScheduleService({
  systemType: "lighting",
  rulesTable: "lighting_schedule_rules",
  locationsTable: "lighting_schedule_rule_locations",
  eventSource: "lighting_schedule",
  label: "照明",
  loggerName: "lightingScheduleService",
});
