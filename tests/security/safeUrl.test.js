const test = require("node:test");
const assert = require("node:assert/strict");
const { assertSafeOutboundUrl, isPrivateIp } = require("../../src/utils/safeUrl");

test("isPrivateIp detects loopback and RFC1918", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.0.0.1"), true);
  assert.equal(isPrivateIp("192.168.1.1"), true);
  assert.equal(isPrivateIp("169.254.169.254"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
});

test("assertSafeOutboundUrl rejects localhost URL", async () => {
  await assert.rejects(
    () => assertSafeOutboundUrl("http://127.0.0.1/face.jpg"),
    (err) => err && /內部|保留|不允許/.test(String(err.message)),
  );
});

test("assertSafeOutboundUrl rejects metadata IP", async () => {
  await assert.rejects(
    () => assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data"),
    (err) => err && /內部|保留|不允許/.test(String(err.message)),
  );
});

test("assertSafeOutboundUrl rejects non-http schemes", async () => {
  await assert.rejects(
    () => assertSafeOutboundUrl("file:///etc/passwd"),
    (err) => err && /http/.test(String(err.message)),
  );
});

test("assertSafeOutboundUrl rejects disallowed port", async () => {
  await assert.rejects(
    () => assertSafeOutboundUrl("http://example.com:8080/x"),
    (err) => err && /連接埠/.test(String(err.message)),
  );
});

test("assertSafeOutboundUrl accepts public https URL", async () => {
  const parsed = await assertSafeOutboundUrl("https://example.com/photo.jpg");
  assert.equal(parsed.hostname, "example.com");
});
