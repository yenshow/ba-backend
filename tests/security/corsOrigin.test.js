/**
 * CORS origin 正規化與 builtin http／https
 *
 *   node tests/security/corsOrigin.test.js
 */
const assert = require("node:assert/strict");
const {
  normalizeOrigin,
  getEffectiveOrigins,
  isOriginAllowed,
  resetBuiltinOriginCache,
} = require("../../src/utils/corsOrigin");

resetBuiltinOriginCache();

assert.equal(normalizeOrigin("http://192.168.1.10:80"), "http://192.168.1.10");
assert.equal(normalizeOrigin("https://192.168.1.10:443"), "https://192.168.1.10");
assert.equal(
  normalizeOrigin("https://192.168.1.10:8443"),
  "https://192.168.1.10:8443",
);

const effective = getEffectiveOrigins(["http://example.test:3000"]);
assert.ok(effective.includes("http://example.test:3000"));
assert.ok(effective.includes("http://127.0.0.1"));
assert.ok(effective.includes("https://127.0.0.1"));
assert.ok(effective.includes("http://localhost"));
assert.ok(effective.includes("https://localhost"));

assert.equal(isOriginAllowed("https://127.0.0.1", []), true);
assert.equal(isOriginAllowed("https://127.0.0.1:443", []), true);
assert.equal(isOriginAllowed("http://example.test:3000", ["http://example.test:3000"]), true);
assert.equal(isOriginAllowed("http://denied.example", ["http://allowed.example"]), false);

console.log("corsOrigin.test.js ok");
