/**
 * ISAPI 事件補齊共用（視窗 clamp／時間區間／debounce）
 *
 *   node tests/isapi/isapiEventBackfillCommon.test.js
 */
const assert = require("node:assert/strict");
const {
  DEFAULT_WINDOW_SEC,
  MIN_WINDOW_SEC,
  MAX_WINDOW_SEC,
  normalizeEventBackfillEnabled,
  normalizeEventBackfillWindowSec,
  parseEventBackfillFields,
  resolveBackfillTimeRange,
  createDebouncedScheduler,
  mergeEventBackfillPrefs,
  isSearchCompleteStatus,
} = require("../../src/services/isapi/isapiEventBackfillCommon");
const {
  parseFcSearchResult,
} = require("../../src/services/peopleCounting/isapiFaceContrastBackfillService");
const {
  toAcsEventPayload,
} = require("../../src/services/accessControl/isapiAcsEventQuery");
const {
  parseVehicleSearchXml,
  resolveVehicleBackfillFromTargets,
} = require("../../src/services/vehicleAccess/isapiVehicleEventBackfillService");

assert.equal(DEFAULT_WINDOW_SEC, 5);
assert.equal(MIN_WINDOW_SEC, 1);
assert.equal(MAX_WINDOW_SEC, 30);

assert.equal(normalizeEventBackfillEnabled(true), true);
assert.equal(normalizeEventBackfillEnabled("true"), true);
assert.equal(normalizeEventBackfillEnabled(1), true);
assert.equal(normalizeEventBackfillEnabled(false), false);
assert.equal(normalizeEventBackfillEnabled(undefined), false);
assert.equal(normalizeEventBackfillEnabled("nope"), false);

assert.equal(normalizeEventBackfillWindowSec(undefined), 5);
assert.equal(normalizeEventBackfillWindowSec(""), 5);
assert.equal(normalizeEventBackfillWindowSec(0), 1);
assert.equal(normalizeEventBackfillWindowSec(-3), 1);
assert.equal(normalizeEventBackfillWindowSec(5.9), 5);
assert.equal(normalizeEventBackfillWindowSec(30), 30);
assert.equal(normalizeEventBackfillWindowSec(31), 30);
assert.equal(normalizeEventBackfillWindowSec("12"), 12);

const parsedSnake = parseEventBackfillFields({
  event_backfill_enabled: "1",
  event_backfill_window_sec: "8",
});
assert.deepEqual(parsedSnake, {
  eventBackfillEnabled: true,
  eventBackfillWindowSec: 8,
});

const parsedCamel = parseEventBackfillFields({
  eventBackfillEnabled: true,
  eventBackfillWindowSec: 99,
});
assert.deepEqual(parsedCamel, {
  eventBackfillEnabled: true,
  eventBackfillWindowSec: 30,
});

const center = new Date("2026-10-06T08:00:10+08:00");
const range = resolveBackfillTimeRange(center, 5);
assert.equal(range.start.toISOString(), "2026-10-06T00:00:05.000Z");
assert.equal(range.end.toISOString(), "2026-10-06T00:00:15.000Z");

const futureCenter = new Date(Date.now() + 60_000);
const clampedEnd = resolveBackfillTimeRange(futureCenter, 5);
assert.ok(clampedEnd.end.getTime() <= Date.now() + 50);

const xml = `<?xml version="1.0"?>
<FCSearchResult>
  <responseStatusStrg>OK</responseStatusStrg>
  <MatchElement>
    <snapTime>2026-10-06T16:48:14</snapTime>
    <snapPicURL>/ISAPI/ContentMgmt/StreamingProxy/channels/101/picture</snapPicURL>
    <FaceMatchInfo>
      <name>Jimmy</name>
      <similarity>91</similarity>
      <PID>42</PID>
      <customHumanID>E002</customHumanID>
      <FDname>BA_FaceLib</FDname>
    </FaceMatchInfo>
  </MatchElement>
</FCSearchResult>`;
const fc = parseFcSearchResult(xml);
assert.equal(fc.status, "OK");
assert.equal(fc.rows.length, 1);
assert.equal(fc.rows[0].personName, "Jimmy");
assert.equal(fc.rows[0].employeeNo, "E002");
assert.equal(fc.rows[0].pid, "42");
assert.equal(fc.rows[0].similarity, 91);
assert.ok(String(fc.rows[0].eventTime).includes("2026-10-06T16:48:14"));

assert.equal(isSearchCompleteStatus("OK"), true);
assert.equal(isSearchCompleteStatus("NO MATCH"), true);
assert.equal(isSearchCompleteStatus("MORE"), false);

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
assert.equal(acsPayload.pictureURL, "/pic/1.jpg");

assert.deepEqual(
  mergeEventBackfillPrefs([
    { event_backfill_enabled: false, event_backfill_window_sec: 5 },
    { eventBackfillEnabled: true, eventBackfillWindowSec: 12 },
    { eventBackfillEnabled: true, eventBackfillWindowSec: 8 },
  ]),
  { enabled: true, windowSec: 12 },
);
assert.deepEqual(mergeEventBackfillPrefs([]), {
  enabled: false,
  windowSec: 5,
});

const vehicleXml = `<?xml version="1.0"?>
<CMSearchResult>
  <responseStatusStrg>OK</responseStatusStrg>
  <MatchElement>
    <licensePlate>ABC-1234</licensePlate>
    <dateTime>2026-10-06T12:00:01</dateTime>
    <listType>allowlist</listType>
  </MatchElement>
</CMSearchResult>`;
const vehicleRows = parseVehicleSearchXml(vehicleXml);
assert.equal(vehicleRows.length, 1);
assert.equal(vehicleRows[0].licensePlate, "ABC-1234");
assert.ok(String(vehicleRows[0].dateTime).includes("2026-10-06T12:00:01"));

assert.deepEqual(
  resolveVehicleBackfillFromTargets([
    { locationId: 1, eventBackfillEnabled: false, eventBackfillWindowSec: 5 },
    { locationId: 2, eventBackfillEnabled: true, eventBackfillWindowSec: 7 },
  ]),
  { enabled: true, windowSec: 7 },
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { schedule, clear } = createDebouncedScheduler(20);
  let runs = 0;
  const run = async () => {
    runs += 1;
  };
  schedule("face:1:9", run);
  schedule("face:1:9", run);
  schedule("face:1:9", run);
  await sleep(80);
  try {
    assert.equal(runs, 1, "debounce 同 key 應只跑一次");
  } finally {
    clear();
  }

  console.log("isapiEventBackfillCommon.test.js: OK");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
