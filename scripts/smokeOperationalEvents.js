/**
 * 營運事件基本單元檢查（不需 DB）
 * 用法：node scripts/smokeOperationalEvents.js
 */
const assert = require("assert");
const {
  EVENT_KINDS,
  recordEvent,
} = require("../src/services/operationalEvents/operationalEventService");
const {
  checkDiDoAlerts,
  _resetEdgeStateForTests,
} = require("../src/services/monitoring/diDoMonitor");
const {
  collectConfiguredBitPointsFromSystemConfig,
} = require("../src/services/devices/modbusDiDoConfig");

assert.deepStrictEqual(
  [...EVENT_KINDS].sort(),
  [
    "access",
    "control_write",
    "elevator",
    "linkage_write",
    "state_change",
    "vehicle",
  ].sort(),
);

const bits = collectConfiguredBitPointsFromSystemConfig({
  device_ids: [2],
  modbus_config: { points: [{ type: "DO", address: 9 }] },
  status_points: {
    running: { registerType: "discrete", address: 1 },
    oil: { registerType: "holding", address: 10 },
  },
});
assert.strictEqual(
  bits.length,
  2,
  "應收集 modbus DO + status_points discrete，略過 holding",
);
assert.ok(bits.some((b) => b.bitKey === "do:9" && b.role === "modbus_do"));
assert.ok(bits.some((b) => b.bitKey === "di:1" && b.role === "running"));

(async () => {
  const bad = await recordEvent({
    source: "lighting",
    event_kind: "not_a_kind",
    summary: "should skip",
  });
  assert.strictEqual(bad, null, "無效 event_kind 應回 null 且不拋錯");

  const noAlert = await recordEvent({
    source: "alert_linkage",
    event_kind: "linkage_write",
    summary: "missing alert",
  });
  assert.strictEqual(noAlert, null, "linkage_write 缺 alert_id 應略過");

  assert.strictEqual(typeof checkDiDoAlerts, "function");
  _resetEdgeStateForTests();

  console.log("smokeOperationalEvents: OK");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
