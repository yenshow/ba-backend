/**
 * 人臉 alarmResult：有候選人／陌生人
 *
 *   node tests/peopleCounting/faceContrastEventParse.test.js
 */
const assert = require("node:assert/strict");
const {
  parseFaceContrastEventPayload,
} = require("../../src/services/peopleCounting/isapiFaceContrastXmlParser");
const {
  parseFcSearchResult,
} = require("../../src/services/peopleCounting/isapiFaceContrastBackfillService");

const withCandidate = JSON.stringify({
  eventType: "alarmResult",
  dateTime: "2026-10-06T13:51:10+08:00",
  ipAddress: "192.168.2.212",
  channelID: 1,
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

const emptyAlarm = JSON.stringify({
  eventType: "alarmResult",
  dateTime: "2026-10-06T13:51:14+08:00",
  alarmResult: [],
});
assert.equal(parseFaceContrastEventPayload(emptyAlarm), null);

const fcXml = `<?xml version="1.0"?>
<FCSearchResult>
  <responseStatusStrg>OK</responseStatusStrg>
  <MatchElement>
    <snapTime>2026-10-06T13:51:14</snapTime>
    <snapPicURL>/ISAPI/pic/1.jpg</snapPicURL>
  </MatchElement>
  <MatchElement>
    <snapTime>2026-10-06T13:51:10</snapTime>
    <FaceMatchInfo>
      <name>Jimmy</name>
      <similarity>87</similarity>
      <customHumanID>E001</customHumanID>
    </FaceMatchInfo>
  </MatchElement>
</FCSearchResult>`;
const fc = parseFcSearchResult(fcXml);
assert.equal(fc.rows.length, 2);
assert.equal(fc.rows[0].matched, false);
assert.equal(fc.rows[1].matched, true);
assert.equal(fc.rows[1].personName, "Jimmy");

console.log("faceContrastEventParse.test.js: OK");
