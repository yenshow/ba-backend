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
assert.match(deleteXml, /<deleteMode>byPID<\/deleteMode>/);

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

console.log("fdLibDelete.test.js: ok");
