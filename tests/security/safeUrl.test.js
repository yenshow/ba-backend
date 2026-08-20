/**
 * SEC-03 SSRF：assertSafeOutboundUrl / isPrivateIp（不依賴測試框架）
 *
 *   npm run test:security:safe-url
 *
 * 僅測協定、連接埠、userinfo、本機／私網 IP；不打外網 DNS。
 */
const assert = require("node:assert/strict");
const {
  assertSafeOutboundUrl,
  isPrivateIp,
  isExternalHttpUrl,
} = require("../../src/utils/safeUrl");

const expectReject = async (url, match) => {
  await assert.rejects(
    () => assertSafeOutboundUrl(url),
    (err) => {
      assert.equal(err.code, "VALIDATION_CUSTOM");
      if (match) {
        assert.match(String(err.message), match);
      }
      return true;
    },
  );
};

const expectOk = async (url) => {
  const parsed = await assertSafeOutboundUrl(url);
  assert.equal(parsed.protocol, "https:");
};

const run = async () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.0.0.1"), true);
  assert.equal(isPrivateIp("192.168.1.1"), true);
  assert.equal(isPrivateIp("172.16.0.1"), true);
  assert.equal(isPrivateIp("169.254.1.1"), true);
  assert.equal(isPrivateIp("100.64.0.1"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("not-an-ip"), true);

  assert.equal(isExternalHttpUrl("https://example.com/a"), true);
  assert.equal(isExternalHttpUrl("http://example.com/a"), false);
  assert.equal(isExternalHttpUrl(""), false);

  await expectReject("", /不可為空/);
  await expectReject("not a url", /格式不正確/);
  await expectReject("http://example.com/", /僅允許 https/);
  await expectReject("https://user:pass@example.com/", /使用者資訊/);
  await expectReject("https://example.com:8443/", /連接埠/);
  await expectReject("https://localhost/", /主機/);
  await expectReject("https://127.0.0.1/", /內部或保留/);
  await expectReject("https://192.168.1.1/", /內部或保留/);
  await expectReject("https://10.1.2.3/", /內部或保留/);
  await expectOk("https://8.8.8.8/");

  console.log("safeUrl SEC-03 tests passed");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
