/**
 * faceContrast XML 合併／舊式 schema 判定
 *
 *   node tests/peopleCounting/faceContrastXml.test.js
 */
const assert = require("node:assert/strict");
const {
  supportsLegacyFaceContrastFdLib,
  buildMergedFaceContrastXml,
} = require("../../src/services/peopleCounting/isapiCameraFdLibService");

const deepinCurrent = `<?xml version="1.0" encoding="UTF-8"?>
<FaceContrastList version="2.0" xmlns="http://www.std-cgi.com/ver20/XMLSchema">
<FaceContrast>
<id>1</id>
<enable>false</enable>
<faceContrastType>faceContrast</faceContrastType>
<QuickContrast>
<enabled>false</enabled>
<threshold>70</threshold>
</QuickContrast>
</FaceContrast>
</FaceContrastList>`;

const deepinCaps = `<FaceContrastCap><enable opt="true,false"/><QuickContrast><threshold min="0" max="100"/></QuickContrast></FaceContrastCap>`;

assert.equal(supportsLegacyFaceContrastFdLib(deepinCurrent, deepinCaps), false);

const merged = buildMergedFaceContrastXml(deepinCurrent, {
  enable: true,
  threshold: 50,
});
assert.match(merged, /<enable>true<\/enable>/);
assert.match(merged, /<threshold>50<\/threshold>/);
assert.doesNotMatch(merged, /FDLibList/);

assert.equal(
  supportsLegacyFaceContrastFdLib(
    `<FaceContrastList><FaceContrast><FDLibList/></FaceContrast></FaceContrastList>`,
    "",
  ),
  true,
);

console.log("faceContrastXml.test.js: ok");
