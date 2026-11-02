/**
 * 平台 validity → ISAPI Valid（跨機種格式）
 *
 *   node tests/accessControl/isapiValidPayload.test.js
 */
const assert = require("node:assert/strict");
const {
  ISAPI_VALID_MAX_END,
  ISAPI_VALID_SAFE_END,
  normalizeIsapiDateTime,
  buildIsapiValidPayloadFromPlatformValidity,
  listIsapiValidPayloadFallbacks,
  isIsapiValidContentError,
} = require("../../src/services/accessControl/accessControlHelpers");

const run = () => {
  assert.equal(
    normalizeIsapiDateTime("2035-12-31T23:59:59+08:00", { asEnd: true }),
    "2035-12-31T23:59:59",
  );
  assert.equal(
    normalizeIsapiDateTime("2035-12-31T23:59:59.000Z", { asEnd: true }),
    "2035-12-31T23:59:59",
  );
  assert.equal(
    normalizeIsapiDateTime("2099-12-31", { asEnd: true }),
    ISAPI_VALID_MAX_END,
  );
  assert.equal(normalizeIsapiDateTime("2035-12-31", { asEnd: false }), "2035-12-31T00:00:00");
  assert.equal(normalizeIsapiDateTime("2035-12-31", { asEnd: true }), "2035-12-31T23:59:59");

  const longTerm = buildIsapiValidPayloadFromPlatformValidity({ longTerm: true });
  assert.equal(longTerm.enable, false);
  assert.match(longTerm.beginTime, /^\d{4}-\d{2}-\d{2}T00:00:00$/);
  assert.equal(longTerm.endTime, ISAPI_VALID_MAX_END);
  assert.equal(longTerm.timeType, undefined);

  const dated = buildIsapiValidPayloadFromPlatformValidity({
    longTerm: false,
    beginTime: "2026-01-01",
    endTime: "2026-12-31",
  });
  assert.equal(dated.enable, true);
  assert.equal(dated.beginTime, "2026-01-01T00:00:00");
  assert.equal(dated.endTime, "2026-12-31T23:59:59");

  const variants = listIsapiValidPayloadFallbacks(longTerm);
  assert.equal(variants[0].enable, false);
  assert.equal(variants[0].endTime, ISAPI_VALID_MAX_END);
  assert.equal(variants[0].timeType, undefined);
  assert.ok(variants.some((item) => item.timeType === "local"));
  assert.ok(variants.some((item) => item.enable === true && item.endTime === ISAPI_VALID_SAFE_END));
  assert.ok(variants.some((item) => item.enable === false && item.beginTime == null));

  const endTimeErr =
    'Bad Request: {"statusCode":6,"statusString":"Invalid Content","subStatusCode":"badJsonContent","errorCode":1610612759,"errorMsg":"-endTime"}';
  assert.equal(isIsapiValidContentError(new Error(endTimeErr)), true);
  assert.equal(
    isIsapiValidContentError(
      new Error(
        'Bad Request: {"subStatusCode":"SubpicAnalysisModelingError","errorMsg":"saveFacePic"}',
      ),
    ),
    false,
  );
  assert.equal(isIsapiValidContentError(new Error("socket hang up")), false);
};

run();
console.log("isapiValidPayload.test.js ok");
