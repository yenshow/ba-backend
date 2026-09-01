/**
 * personnelIsapiErrorUtils
 *
 *   npm run test:personnel-isapi-error
 */
const assert = require("node:assert/strict");
const {
  normalizeIsapiErrorMessage,
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

  console.log("personnelIsapiErrorUtils tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
