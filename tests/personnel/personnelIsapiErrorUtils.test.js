/**
 * personnelIsapiErrorUtils
 *
 *   npm run test:personnel-isapi-error
 */
const assert = require("node:assert/strict");
const {
  normalizeIsapiErrorMessage,
  isTransientIsapiNetworkError,
  isPermanentFaceModelingError,
} = require("../../src/services/personnel/personnelIsapiErrorUtils");

async function run() {
  const rawIsapi =
    'Bad Request: {"statusCode":6,"statusString":"Invalid Content","subStatusCode":"SubpicAnalysisModelingError","errorCode":1610612791,"errorMsg":"saveFacePic"}';
  const friendly = normalizeIsapiErrorMessage(rawIsapi);
  assert.match(friendly, /人臉模型/);
  assert.match(friendly, /200KB/);

  const unauthorized =
    "Unauthorized: <userCheck><statusValue>401</statusValue></userCheck>";
  assert.match(normalizeIsapiErrorMessage(unauthorized), /401/);

  assert.equal(isTransientIsapiNetworkError(new Error("socket hang up")), true);
  assert.equal(
    isTransientIsapiNetworkError(
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    ),
    true,
  );
  assert.equal(
    isTransientIsapiNetworkError(new Error("timeout of 15000ms exceeded")),
    true,
  );
  assert.equal(isTransientIsapiNetworkError(new Error(friendly)), false);
  assert.equal(isPermanentFaceModelingError(friendly), true);
  assert.equal(isTransientIsapiNetworkError(new Error(unauthorized)), false);

  const deviceBusy =
    'Bad Request: {"statusCode":2,"statusString":"Device Busy","subStatusCode":"deviceBusy","errorCode":536870916,"errorMsg":"employeeNo"}';
  assert.equal(isTransientIsapiNetworkError(new Error(deviceBusy)), true);
  assert.match(normalizeIsapiErrorMessage(deviceBusy), /設備忙碌/);

  console.log("personnelIsapiErrorUtils tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
