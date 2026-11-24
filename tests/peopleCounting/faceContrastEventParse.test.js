/**
 * 人臉 alarmResult／FCSearch：候選人／陌生人／deviceEventId
 *
 *   node tests/peopleCounting/faceContrastEventParse.test.js
 */
const assert = require("node:assert/strict");
const {
  parseFaceContrastEventPayload,
} = require("../../src/services/peopleCounting/isapiFaceContrastXmlParser");
const {
  parseFcSearchResult,
} = require("../../src/services/peopleCounting/isapiFaceContrastCatchupService");

const withCandidate = JSON.stringify({
  eventType: "alarmResult",
  dateTime: "2026-10-06T13:51:10+08:00",
  ipAddress: "192.168.2.212",
  channelID: 1,
  facePicID: "987654",
  alarmResult: [
    {
      faces: [
        {
          identify: [
            {
              maxsimilarity: 0.87,
              candidate: [
                {
                  similarity: 0.87,
                  customHumanID: "E001",
                  reserve_field: { name: "Jimmy" },
                  FDLibName: "BA_FaceLib",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

const matched = parseFaceContrastEventPayload(withCandidate);
assert.ok(matched);
assert.equal(matched.matched, true);
assert.equal(matched.personName, "Jimmy");
assert.equal(matched.employeeNo, "E001");
assert.equal(matched.similarity, 87);
assert.equal(matched.deviceEventId, "987654");

const strangerPayload = JSON.stringify({
  eventType: "alarmResult",
  dateTime: "2026-10-06T13:51:14+08:00",
  channelID: 1,
  alarmResult: [{ faces: [{ faceId: 1 }] }],
});
const stranger = parseFaceContrastEventPayload(strangerPayload);
assert.ok(stranger);
assert.equal(stranger.matched, false);
assert.equal(stranger.personName, null);
assert.equal(stranger.similarity, null);
assert.equal(stranger.deviceEventId, null);

const withSnapUrl = JSON.stringify({
  eventType: "alarmResult",
  dateTime: "2026-10-06T13:51:16+08:00",
  channelID: 1,
  snapPicURL: "http://192.168.2.212/ISAPI/Storage/snap/abc.jpg",
  alarmResult: [{ faces: [{ faceId: 1 }] }],
});
const snapUrlParsed = parseFaceContrastEventPayload(withSnapUrl);
assert.ok(snapUrlParsed);
assert.equal(snapUrlParsed.deviceEventId, "/ISAPI/Storage/snap/abc.jpg");

const emptyAlarm = JSON.stringify({
  eventType: "alarmResult",
  dateTime: "2026-10-06T13:51:14+08:00",
  alarmResult: [],
});
assert.equal(parseFaceContrastEventPayload(emptyAlarm), null);

const fcXml = `<?xml version="1.0" encoding="UTF-8"?>
<FCSearchResult>
  <responseStatusStrg>OK</responseStatusStrg>
  <MatchElement>
    <snapTime>2026-03-20T10:00:01</snapTime>
    <facePicID>112233</facePicID>
    <snapPicURL>http://cam/ISAPI/Storage/fc/1.jpg</snapPicURL>
    <FaceMatchInfo>
      <name>Alice</name>
      <similarity>92</similarity>
      <PID>55</PID>
      <customHumanID>A001</customHumanID>
      <FDname>BA_FaceLib</FDname>
    </FaceMatchInfo>
  </MatchElement>
  <MatchElement>
    <snapTime>2026-03-20T10:00:05</snapTime>
    <snapPicURL>/ISAPI/Storage/fc/2.jpg</snapPicURL>
    <FaceMatchInfo>
      <name>Bob</name>
      <similarity>80</similarity>
    </FaceMatchInfo>
  </MatchElement>
</FCSearchResult>`;

const fc = parseFcSearchResult(fcXml);
assert.equal(fc.rows.length, 2);
assert.equal(fc.rows[0].deviceEventId, "112233");
assert.equal(fc.rows[0].personName, "Alice");
assert.equal(fc.rows[1].deviceEventId, "/ISAPI/Storage/fc/2.jpg");
assert.equal(fc.status, "OK");

console.log("faceContrastEventParse.test.js: OK");
