/**
 * 警報文案 SSOT（alertCopy）golden strings
 *
 *   npm run test:alert-copy
 */
const assert = require("node:assert/strict");
const {
  formatMessage,
  formatZoneDashLocation,
  getThresholdOperatorDisplayLabel,
  summaryOfflineFallback,
  summaryBitTriggerFallback,
  summaryRuleBitStateFallback,
  summaryManualAlarmFallback,
  summaryEnergyContractStage,
  summaryEnergyMeterStale,
  summaryEnergyReadingJump,
  getCanonicalTemplateString,
  MESSAGE_TEMPLATE_KEYS,
  resolveSourceLabel,
} = require("../../src/services/alerts/alertCopy");

const run = () => {
  assert.equal(formatZoneDashLocation("一樓", "大廳"), "一樓 - 大廳");
  assert.equal(formatZoneDashLocation("", "大廳"), "大廳");
  assert.equal(getThresholdOperatorDisplayLabel(">="), "超過");
  assert.equal(getThresholdOperatorDisplayLabel("<="), "低於");

  assert.equal(
    formatMessage(getCanonicalTemplateString(MESSAGE_TEMPLATE_KEYS.DI_V1), {
      location_label: "一樓 - 大廳",
      di_address: "3",
    }),
    "一樓 - 大廳 DI 3 觸發",
  );

  assert.equal(
    summaryOfflineFallback({
      sourceDisplayName: "空調主機",
      errorCount: 5,
    }),
    "空調主機 連續 5 次無法連接",
  );

  assert.equal(
    summaryBitTriggerFallback({
      alertType: "di",
      address: 3,
      locationLabel: "一樓 - 大廳",
    }),
    "一樓 - 大廳：DI 3 觸發",
  );

  assert.equal(
    summaryRuleBitStateFallback({
      source: "drainage",
      bitKey: "di:0",
    }),
    "排水系統：DI 0 觸發",
  );

  assert.equal(
    summaryManualAlarmFallback({ sourceLabel: "照明系統" }),
    "照明系統 手動觸發警報",
  );

  assert.equal(
    summaryEnergyContractStage({
      level: 2,
      demandKw: 450.5,
      contractKw: 500,
      thresholdPct: 90,
    }),
    "契約 2 級：即時功率／需量 450.5 kW 已達契約容量 500.0 kW 的 90%",
  );

  assert.equal(
    summaryEnergyMeterStale({
      deviceName: "B1 電表",
      staleMinutes: 15,
    }),
    "B1 電表：通訊逾時，最近 15 分鐘無讀數",
  );

  assert.equal(
    summaryEnergyReadingJump({
      deviceName: "B1 電表",
      deltaKwh: 12.3,
    }),
    "B1 電表：讀數跳動異常（單次 +12.3 kWh）",
  );

  assert.equal(resolveSourceLabel("energy"), "能源管理");

  console.log("alertCopy tests OK");
};

run();
