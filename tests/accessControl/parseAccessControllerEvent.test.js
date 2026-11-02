/**
 * 門禁 subscribe JSON：讀卡機 AccessControllerEvent 須保留 cardNo，並與人臉同一套過濾。
 *
 *   node tests/accessControl/parseAccessControllerEvent.test.js
 */
const assert = require("node:assert/strict");
const {
  parseEventJson,
  isProcessableEvent,
} = require("../../src/services/accessControl/isapiSubscribeService");
const {
  resolveVerifyMethodKey,
} = require("../../src/services/peopleCounting/accessControlLogLabels");

const heartbeat = parseEventJson(`{
  "ipAddress": "192.168.2.210",
  "eventType": "heartBeat",
  "eventState": "active",
  "eventDescription": "heartBeat"
}`);
assert.equal(String(heartbeat.eventType).toLowerCase(), "heartbeat");
assert.equal(isProcessableEvent(heartbeat.AccessControllerEvent), false);

const cardJson = `{
  "ipAddress": "192.168.2.210",
  "portNo": 80,
  "protocol": "HTTP",
  "macAddress": "4c:ea:41:30:11:c2",
  "dateTime": "2026-10-30T16:25:20+08:00",
  "eventType": "AccessControllerEvent",
  "eventState": "active",
  "AccessControllerEvent": {
    "majorEventType": 5,
    "subEventType": 1,
    "employeeNoString": "A0002",
    "name": "",
    "cardNo": "0521778153",
    "cardReaderNo": 1,
    "doorNo": 1,
    "serialNo": 521,
    "currentVerifyMode": "card"
  }
}`;
const card = parseEventJson(cardJson);
assert.equal(card.eventType, "AccessControllerEvent");
assert.equal(card.employeeNoString, "A0002");
assert.equal(card.cardNo, "0521778153");
assert.equal(card.AccessControllerEvent.majorEventType, 5);
assert.equal(card.AccessControllerEvent.subEventType, 1);
assert.equal(card.AccessControllerEvent.cardNo, "0521778153");
assert.equal(card.AccessControllerEvent.doorNo, 1);
assert.equal(isProcessableEvent(card.AccessControllerEvent), true);
assert.equal(resolveVerifyMethodKey(card.AccessControllerEvent), "card");

const face = parseEventJson(`{
  "eventType": "AccessControllerEvent",
  "dateTime": "2026-10-30T16:25:20+08:00",
  "AccessControllerEvent": {
    "majorEventType": 5,
    "subEventType": 75,
    "employeeNoString": "B0119",
    "name": "測試"
  }
}`);
assert.equal(isProcessableEvent(face.AccessControllerEvent), true);
assert.equal(resolveVerifyMethodKey(face.AccessControllerEvent), "face");

const lock = parseEventJson(`{
  "eventType": "AccessControllerEvent",
  "AccessControllerEvent": { "majorEventType": 5, "subEventType": 21 }
}`);
assert.equal(isProcessableEvent(lock.AccessControllerEvent), false);

const cardMinor = parseEventJson(`{
  "eventType": "AccessControllerEvent",
  "dateTime": "2026-10-30T17:06:46+08:00",
  "AccessControllerEvent": {
    "major": 5,
    "minor": 1,
    "employeeNoString": "A0002",
    "cardNo": "0521778153"
  }
}`);
assert.equal(cardMinor.AccessControllerEvent.majorEventType, 5);
assert.equal(cardMinor.AccessControllerEvent.subEventType, 1);
assert.equal(cardMinor.cardNo, "0521778153");
assert.equal(isProcessableEvent(cardMinor.AccessControllerEvent), true);
assert.equal(resolveVerifyMethodKey(cardMinor.AccessControllerEvent), "card");

console.log("parseAccessControllerEvent.test.js ok");
