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

test("assertSafeOutboundUrl rejects disallowed targets", async (t) => {
  const cases = [
    ["http://example.com/face.jpg", /https/],
    ["file:///etc/passwd", /https/],
    ["https://127.0.0.1/face.jpg", /內部|保留|不允許/],
    ["https://169.254.169.254/latest/meta-data", /內部|保留|不允許/],
  ];

  for (const [url, pattern] of cases) {
    await t.test(url, async () => {
      await assert.rejects(
        () => assertSafeOutboundUrl(url),
        (err) => err && pattern.test(String(err.message)),
      );
    });
  }
});

test("assertSafeOutboundUrl accepts public https URL", async () => {
  const parsed = await assertSafeOutboundUrl("https://example.com/face.jpg");
  assert.equal(parsed.hostname, "example.com");
  assert.equal(parsed.protocol, "https:");
});
