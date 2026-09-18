/**
 * ISAPI 連線校時：停用／缺帳密／cooldown
 *
 *   node tests/isapi/isapiTimeSyncOnConnect.test.js
 */
const assert = require("node:assert/strict");
const {
  CONNECT_SYNC_COOLDOWN_MS,
  shouldAttemptConnectSync,
} = require("../../src/services/isapi/isapiTimeSyncService");

const now = 1_000_000;
const base = {
  enabled: true,
  hasCredentials: true,
  deviceId: 80,
  now,
};

{
  const r = shouldAttemptConnectSync({ ...base, enabled: false });
  assert.equal(r.attempt, false);
  assert.equal(r.reason, "disabled");
}

{
  const r = shouldAttemptConnectSync({ ...base, hasCredentials: false });
  assert.equal(r.attempt, false);
  assert.equal(r.reason, "incomplete");
}

{
  const r = shouldAttemptConnectSync({ ...base, deviceId: null });
  assert.equal(r.attempt, false);
  assert.equal(r.reason, "incomplete");
}

{
  const r = shouldAttemptConnectSync({
    ...base,
    lastAt: now - 60_000,
  });
  assert.equal(r.attempt, false);
  assert.equal(r.reason, "cooldown");
}

{
  const r = shouldAttemptConnectSync({
    ...base,
    lastAt: now - CONNECT_SYNC_COOLDOWN_MS - 1,
  });
  assert.equal(r.attempt, true);
}

{
  const r = shouldAttemptConnectSync(base);
  assert.equal(r.attempt, true);
}

console.log("isapiTimeSyncOnConnect.test.js ok");
