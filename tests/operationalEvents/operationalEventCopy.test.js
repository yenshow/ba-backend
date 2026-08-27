/**
 * 營運事件文案 SSOT（operationalEventCopy）golden strings
 *
 *   npm run test:operational-event-copy
 */
const assert = require("node:assert/strict");
const {
  summaryAccessEvent,
  summaryVehicle,
  summaryLinkageWrite,
  summaryIntercom,
  resolveIntercomEventLabel,
  summaryBarrierControlWrite,
} = require("../../src/services/operationalEvents/operationalEventCopy");

const run = () => {
  // 門禁：有名／僅工號／皆空
  assert.equal(
    summaryAccessEvent({
      personName: "王小明",
      employeeNo: "E001",
      placeLabel: "一樓 - 大廳",
      action: "人臉通過（進場）",
    }),
    "一樓 - 大廳：人臉通過（進場） → 王小明",
  );
  assert.equal(
    summaryAccessEvent({
      personName: null,
      employeeNo: "E001",
      placeLabel: "一樓 - 大廳",
      action: "人臉通過（進場）",
    }),
    "一樓 - 大廳：人臉通過（進場） → E001",
  );
  assert.equal(
    summaryAccessEvent({
      personName: "",
      employeeNo: "",
      placeLabel: "一樓 - 大廳",
      action: "人臉通過（進場）",
    }),
    "一樓 - 大廳：人臉通過（進場）",
  );
  // 卡號不得當句尾（呼叫端不傳 cardNo）
  assert.equal(
    summaryAccessEvent({
      personName: null,
      employeeNo: null,
      placeLabel: null,
      action: "卡片驗證失敗",
    }),
    "卡片驗證失敗",
  );

  // 過車：放行／拒絕
  assert.equal(
    summaryVehicle({
      plate: "ABC-1234",
      laneType: 1,
      placeLabel: "地下停車場",
      allowResult: 1,
    }),
    "地下停車場：過車 → ABC-1234 進場",
  );
  assert.equal(
    summaryVehicle({
      plate: "ABC-1234",
      laneType: 2,
      placeLabel: "地下停車場",
      allowResult: 0,
    }),
    "地下停車場：過車拒絕 → ABC-1234 出場",
  );

  // 連動括號中文 + 地點
  assert.equal(
    summaryLinkageWrite({
      address: 10,
      value: true,
      executionType: "trigger",
      placeLabel: "一樓 - 大廳",
    }),
    "一樓 - 大廳：電源 → 開啟（觸發）",
  );
  assert.equal(
    summaryLinkageWrite({
      address: 10,
      value: false,
      executionType: "auto_off",
      placeLabel: "一樓 - 大廳",
    }),
    "一樓 - 大廳：電源 → 關閉（自動關）",
  );

  // 對講：已知中文／未知英文 → 對講事件
  assert.equal(
    resolveIntercomEventLabel({ eventName: "changedCallStatus" }),
    "通話狀態變更",
  );
  assert.equal(
    resolveIntercomEventLabel({ eventName: "doorbell_ringing" }),
    "門鈴",
  );
  assert.equal(
    resolveIntercomEventLabel({ eventName: "SomeUnknownSdkEvent" }),
    "對講事件",
  );
  assert.equal(
    summaryIntercom({
      placeLabel: "3F-12",
      message: { eventName: "CallRecordsEvent" },
    }),
    "3F-12：通話紀錄",
  );
  assert.equal(
    summaryIntercom({
      placeLabel: "A1-01",
      action: "手動語音廣播",
    }),
    "A1-01：手動語音廣播",
  );

  // 柵欄指令
  assert.equal(
    summaryBarrierControlWrite({
      deviceName: "入口車牌機",
      cmd: "open",
      placeLabel: "地庫入口",
    }),
    "地庫入口：遠端開閘 → 入口車牌機",
  );
  assert.equal(
    summaryBarrierControlWrite({
      deviceName: "入口車牌機",
      cmd: "close",
      success: false,
      errorMessage: "timeout",
      placeLabel: "地庫入口",
    }),
    "地庫入口：遠端關閘失敗 → 入口車牌機（timeout）",
  );

  console.log("operationalEventCopy tests OK");
};

run();
