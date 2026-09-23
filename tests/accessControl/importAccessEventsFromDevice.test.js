/**
 * 門禁歷史匯入：編號選擇與 AcsEvent → 平台 payload。不連設備、不寫 DB。
 *
 *   node tests/accessControl/importAccessEventsFromDevice.test.js
 */
const assert = require("node:assert/strict");
const db = require("../../src/database/db");
const { isProcessableEvent } = require("../../src/services/accessControl/isapiSubscribeService");
const {
  parseSelection,
  toPayload,
  extractPictureUrl,
  isImageBuffer,
} = require("../../scripts/importAccessEventsFromDevice");

const face = toPayload({
  major: 5,
  minor: 75,
  time: "2026-09-23T08:34:10+08:00",
  employeeNoString: "B0119",
  name: "曾宜豪",
  serialNo: 2401,
  cardNo: "",
});

assert.equal(face.majorEventType, 5);
assert.equal(face.subEventType, 75);
assert.equal(face.employeeNoString, "B0119");
assert.equal(face.personName, "曾宜豪");
assert.equal(face.serialNo, 2401);
assert.equal(isProcessableEvent(face), true);

const doorLock = toPayload({ major: 5, minor: 21, name: "" });
assert.equal(isProcessableEvent(doorLock), false);

const notAccess = toPayload({ major: 2, minor: 1024 });
assert.equal(isProcessableEvent(notAccess), false);

assert.deepEqual(parseSelection("1,3,5-8", 10), [1, 3, 5, 6, 7, 8]);
assert.deepEqual(parseSelection("8-5", 10), [5, 6, 7, 8]);
assert.deepEqual(parseSelection("all", 3), [1, 2, 3]);
assert.deepEqual(parseSelection("", 3), []);
assert.deepEqual(parseSelection("0,99,2", 3), [2]);
assert.equal(extractPictureUrl({ pictureURL: " /pic/a.jpg " }), "/pic/a.jpg");
assert.equal(extractPictureUrl({}), null);
assert.equal(isImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0])), true);
assert.equal(isImageBuffer(Buffer.from("not-image")), false);

db.close().then(() => {
  console.log("importAccessEventsFromDevice.test.js ok");
});
