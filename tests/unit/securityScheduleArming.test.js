/**
 * 保全排程窗／佈防延遲單元測試
 *
 *   npm run test:security-schedule-arming
 */
const assert = require("node:assert/strict");
const {
  isTimeInWindow,
  normalizeArmingConfig,
  timeToSeconds,
} = require("../../src/services/security/securityScheduleService");
const delaySvc = require("../../src/services/security/securityArmingDelayService");

const fail = (msg) => {
  throw new Error(msg);
};

const run = async () => {
  // 時間窗：一般日內
  assert.equal(isTimeInWindow("10:00:00", "08:00:00", "18:00:00"), true);
  assert.equal(isTimeInWindow("07:59:59", "08:00:00", "18:00:00"), false);
  assert.equal(isTimeInWindow("18:00:00", "08:00:00", "18:00:00"), false);

  // 跨日
  assert.equal(isTimeInWindow("23:00:00", "22:00:00", "06:00:00"), true);
  assert.equal(isTimeInWindow("05:00:00", "22:00:00", "06:00:00"), true);
  assert.equal(isTimeInWindow("12:00:00", "22:00:00", "06:00:00"), false);

  assert.equal(timeToSeconds("01:30:00"), 5400);

  // 佈防設定正規化
  {
    const a = normalizeArmingConfig({});
    assert.equal(a.armingMode, "immediate");
    assert.equal(a.entryDelaySec, 30);
    assert.equal(a.exitDelaySec, 60);
  }
  {
    const a = normalizeArmingConfig({
      arming_mode: "twenty_four_hour",
      entry_delay_sec: 999,
      exit_delay_sec: -1,
    });
    assert.equal(a.armingMode, "twenty_four_hour");
    assert.equal(a.entryDelaySec, 300);
    assert.equal(a.exitDelaySec, 0);
  }
  {
    const a = normalizeArmingConfig({
      armingMode: "delay",
      entryDelaySec: 15,
      exitDelaySec: 45,
    });
    assert.equal(a.armingMode, "delay");
    assert.equal(a.entryDelaySec, 15);
    assert.equal(a.exitDelaySec, 45);
  }

  // 離開寬限：撤防→佈防才啟動
  delaySvc.resetForTests();
  delaySvc.syncExitGrace(1, true, { armingMode: "delay", exitDelaySec: 60 });
  delaySvc.syncExitGrace(1, false, { armingMode: "delay", exitDelaySec: 60 });
  assert.equal(delaySvc.isInExitGrace(1), true);
  delaySvc.syncExitGrace(1, true, { armingMode: "delay", exitDelaySec: 60 });
  assert.equal(delaySvc.isInExitGrace(1), false);

  // 進入延遲：pending → 取消
  delaySvc.resetForTests();
  let fired = false;
  const pending = delaySvc.startOrContinueEntryDelay({
    systemId: 10,
    alertType: "di",
    dimensionKey: "bit:0",
    entryDelaySec: 5,
    onFire: () => {
      fired = true;
    },
  });
  assert.equal(pending, "pending");
  assert.equal(
    delaySvc.startOrContinueEntryDelay({
      systemId: 10,
      alertType: "di",
      dimensionKey: "bit:0",
      entryDelaySec: 5,
      onFire: () => {},
    }),
    "pending",
  );
  assert.equal(delaySvc.cancelEntryDelay(10, "di", "bit:0"), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired, false);

  // entryDelaySec=0 → 立即
  assert.equal(
    delaySvc.startOrContinueEntryDelay({
      systemId: 11,
      alertType: "di",
      dimensionKey: null,
      entryDelaySec: 0,
      onFire: () => {},
    }),
    "fire_now",
  );

  console.log("securityScheduleArming.test.js: ok");
};

run().catch((err) => {
  fail(err?.stack || String(err));
});
