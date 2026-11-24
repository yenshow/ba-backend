/**
 * ISAPI 共用工具（debounce／NVR 牆鐘）與門禁 AcsEvent payload／serialNo
 *
 *   node tests/isapi/isapiEventBackfillCommon.test.js
 */
const assert = require("node:assert/strict");
const {
  createDebouncedScheduler,
  normalizeNvrWallClockDateTime,
  DEFAULT_DEBOUNCE_MS,
} = require("../../src/services/isapi/isapiEventBackfillCommon");
const {
  toAcsEventPayload,
  parseSerialNo,
} = require("../../src/services/accessControl/isapiAcsEventQuery");

assert.equal(DEFAULT_DEBOUNCE_MS, 1500);
assert.equal(parseSerialNo(521), 521);
assert.equal(parseSerialNo("9"), 9);
assert.equal(parseSerialNo(""), null);
assert.equal(parseSerialNo(null), null);

const acsPayload = toAcsEventPayload({
  major: 5,
  minor: 75,
  employeeNoString: "E1",
  name: "Ada",
  serialNo: 9,
  pictureURL: "/pic/1.jpg",
});
assert.equal(acsPayload.majorEventType, 5);
assert.equal(acsPayload.subEventType, 75);
assert.equal(acsPayload.personName, "Ada");
assert.equal(acsPayload.serialNo, 9);
assert.equal(acsPayload.pictureURL, "/pic/1.jpg");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { schedule, clear } = createDebouncedScheduler(20);
  let runs = 0;
  const run = async () => {
    runs += 1;
  };
  schedule("access:1", run);
  schedule("access:1", run);
  schedule("access:1", run);
  await sleep(80);
  try {
    assert.equal(runs, 1, "debounce 同 key 應只跑一次");
  } finally {
    clear();
  }

  assert.equal(
    normalizeNvrWallClockDateTime("2026-10-19T09:21:47Z"),
    "2026-10-19T09:21:47+08:00",
  );
  assert.equal(
    normalizeNvrWallClockDateTime("2026-10-19T09:21:47"),
    "2026-10-19T09:21:47+08:00",
  );
  assert.equal(
    normalizeNvrWallClockDateTime("2026-10-19T09:21:47+08:00"),
    "2026-10-19T09:21:47+08:00",
  );

  console.log("isapiEventBackfillCommon.test.js: OK");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
