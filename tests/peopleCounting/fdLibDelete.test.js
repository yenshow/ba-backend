/**
 * FDLib 刪除／搜尋 XML
 *
 *   node tests/peopleCounting/fdLibDelete.test.js
 */
const assert = require("node:assert/strict");
const {
  buildFdLibPicturePath,
  buildFdDeleteDataXml,
  buildFdSearchXml,
  collectPidsFromSearchMatches,
} = require("../../src/services/peopleCounting/isapiCameraFdLibService");

assert.equal(
  buildFdLibPicturePath("3", "B0002"),
  "/ISAPI/Intelligent/FDLib/3/picture/B0002",
);
assert.match(buildFdLibPicturePath("1", "a/b"), /picture\/a%2Fb/);

const deleteXml = buildFdDeleteDataXml({
  fdid: "3",
  pid: "12",
  faceLibType: "ordinary",
});
assert.match(deleteXml, /<faceLibType>ordinary<\/faceLibType>/);
assert.match(deleteXml, /<deleteFP>[\s\S]*<FPID>12<\/FPID>[\s\S]*<\/deleteFP>/);
assert.doesNotMatch(deleteXml, /deleteMode|<PID>/);

const deleteNoType = buildFdDeleteDataXml({
  fdid: "3",
  pid: "12",
  includeFaceLibType: false,
});
assert.doesNotMatch(deleteNoType, /faceLibType/);
assert.match(deleteNoType, /<FPID>12<\/FPID>/);

const searchWithType = buildFdSearchXml({
  searchID: "S1",
  fdid: "3",
  employeeNo: "B0002",
  faceLibType: "ordinary",
  includeFaceLibType: true,
});
assert.match(searchWithType, /<searchResultPosition>0<\/searchResultPosition>/);
assert.match(searchWithType, /<faceLibType>ordinary<\/faceLibType>/);
assert.match(searchWithType, /<customHumanID>B0002<\/customHumanID>/);

const searchNoType = buildFdSearchXml({
  searchID: "S1",
  fdid: "3",
  employeeNo: "B0002",
  includeFaceLibType: false,
});
assert.doesNotMatch(searchNoType, /faceLibType/);

assert.deepEqual(
  collectPidsFromSearchMatches([
    { PID: "12", customHumanID: "B0002" },
    { PID: "12" },
    { PID: " 13 " },
    { PID: "" },
    null,
  ]),
  ["12", "13"],
);
assert.deepEqual(collectPidsFromSearchMatches([]), []);

console.log("fdLibDelete.test.js: ok");
