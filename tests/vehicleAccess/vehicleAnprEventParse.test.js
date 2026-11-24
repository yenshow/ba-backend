/**
 * 車牌 ANPR／Traffic search：deviceEventId（matchNo／UUID／圖 path）
 *
 *   node tests/vehicleAccess/vehicleAnprEventParse.test.js
 */
const assert = require("node:assert/strict");
const {
  parseAnprEventXml,
  parseVehicleSearchResult,
} = require("../../src/services/vehicleAccess/isapiVehicleXmlParser");

const anprWithMatchNo = `<?xml version="1.0" encoding="UTF-8"?>
<EventNotificationAlert version="2.0">
  <eventType>ANPR</eventType>
  <dateTime>2026-03-20T12:00:01+08:00</dateTime>
  <ANPR>
    <licensePlate>ABC-1234</licensePlate>
    <listType>allowList</listType>
    <matchNo>778899</matchNo>
    <platePicUrl>http://cam/ISAPI/Traffic/channels/1/picture/1.jpg</platePicUrl>
  </ANPR>
</EventNotificationAlert>`;

const parsed = parseAnprEventXml(anprWithMatchNo);
assert.ok(parsed);
assert.equal(parsed.licensePlate, "ABC-1234");
assert.equal(parsed.deviceEventId, "778899");
assert.equal(
  parsed.picturePath,
  "/ISAPI/Traffic/channels/1/picture/1.jpg",
);

const anprPicOnly = `<?xml version="1.0" encoding="UTF-8"?>
<EventNotificationAlert>
  <eventType>ANPR</eventType>
  <dateTime>2026-03-20T12:00:02+08:00</dateTime>
  <ANPR>
    <licensePlate>XYZ-9999</licensePlate>
    <listType>unknown</listType>
    <pictureURL>/ISAPI/Traffic/pic/xyz.jpg</pictureURL>
  </ANPR>
</EventNotificationAlert>`;
const picOnly = parseAnprEventXml(anprPicOnly);
assert.ok(picOnly);
assert.equal(picOnly.deviceEventId, "/ISAPI/Traffic/pic/xyz.jpg");

const searchXml = `<?xml version="1.0"?>
<CMSearchResult>
  <responseStatusStrg>OK</responseStatusStrg>
  <MatchElement>
    <dateTime>2026-03-20T12:01:00</dateTime>
    <licensePlate>DEF-5678</licensePlate>
    <listType>white</listType>
    <UUID>u-1-2-3</UUID>
    <vehiclePicUrl>http://cam/ISAPI/Traffic/v/1.jpg</vehiclePicUrl>
  </MatchElement>
  <MatchElement>
    <dateTime>2026-03-20T12:01:05</dateTime>
    <plateNo>GHI-0001</plateNo>
    <platePicURL>/ISAPI/Traffic/p/2.jpg</platePicURL>
  </MatchElement>
</CMSearchResult>`;

const search = parseVehicleSearchResult(searchXml);
assert.equal(search.rows.length, 2);
assert.equal(search.rows[0].deviceEventId, "u-1-2-3");
assert.equal(search.rows[0].licensePlate, "DEF-5678");
assert.equal(search.rows[1].deviceEventId, "/ISAPI/Traffic/p/2.jpg");
assert.equal(search.status, "OK");

assert.equal(parseAnprEventXml("<EventNotificationAlert><eventType>heartbeat</eventType></EventNotificationAlert>"), null);

console.log("vehicleAnprEventParse.test.js: OK");
