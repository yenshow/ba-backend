/**
 * 攝影機 ISAPI HTTP 埠解析（RTSP port ≠ ISAPI port）
 *
 *   node tests/isapi/resolveIsapiHttpPort.test.js
 */
const assert = require("node:assert/strict");
const {
  resolveIsapiHttpPort,
  createIsapiClient,
  DEFAULT_ISAPI_HTTP_PORT,
} = require("../../src/services/accessControl/isapiClient");

assert.equal(DEFAULT_ISAPI_HTTP_PORT, 80);

assert.equal(
  resolveIsapiHttpPort({
    type: "camera",
    host: "192.168.2.212",
    port: 554,
    rtsp_url: "rtsp://admin:x@192.168.2.212:554/Streaming/Channels/101",
  }),
  80,
);

assert.equal(
  resolveIsapiHttpPort({ type_code: "camera", port: "554" }),
  80,
);

assert.equal(
  resolveIsapiHttpPort({ type: "camera", port: 554, isapi_port: 8080 }),
  8080,
);

assert.equal(
  resolveIsapiHttpPort({ type: "access_control", port: 8000 }),
  8000,
);

assert.equal(resolveIsapiHttpPort({ host: "x" }), 80);

{
  const client = createIsapiClient(
    { host: "192.168.2.212", port: 554, username: "a", password: "b" },
    { typeCode: "camera" },
  );
  assert.equal(client.port, 80);
  assert.equal(client.baseURL, "http://192.168.2.212");
}

console.log("resolveIsapiHttpPort.test.js: ok");
