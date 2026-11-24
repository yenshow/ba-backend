/**
 * alertQueryFragments：list／byId／backup 共用 JOIN，欄位集合依 mode 差異
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  buildAlertSelectQuery,
  ENERGY_STATION_ALERT_SQL,
  DEVICE_SCOPED_ALERT_SOURCES_SQL,
  LOCATION_ALERT_SOURCES_SQL,
} = require("../../src/services/alerts/alertQueryFragments");

const assertSharedJoins = (sql) => {
  assert.match(sql, /LEFT JOIN users iu ON a\.ignored_by = iu\.id/);
  assert.match(sql, /LEFT JOIN devices d/);
  assert.match(sql, /LEFT JOIN location_systems ls/);
  assert.match(sql, /LEFT JOIN locations l/);
  assert.match(sql, /LEFT JOIN zones z/);
  assert.match(sql, /LEFT JOIN devices d_system/);
  assert.ok(sql.includes(ENERGY_STATION_ALERT_SQL));
  assert.ok(sql.includes(DEVICE_SCOPED_ALERT_SOURCES_SQL));
  assert.ok(sql.includes(LOCATION_ALERT_SOURCES_SQL));
  assert.match(sql, /as device_type_code/);
  assert.match(sql, /as source_name/);
  assert.match(sql, /as zone_name/);
  assert.match(sql, /as device_config/);
};

describe("alertQueryFragments.buildAlertSelectQuery", () => {
  it("list 含完整欄位與 device_name", () => {
    const sql = buildAlertSelectQuery("list");
    assertSharedJoins(sql);
    assert.match(sql, /a\.dimension_key/);
    assert.match(sql, /a\.rule_id/);
    assert.match(sql, /a\.ignored_by/);
    assert.match(sql, /as device_name/);
    assert.doesNotMatch(sql, /\ba\.\*/);
  });

  it("byId 使用 a.* 並含 device_name", () => {
    const sql = buildAlertSelectQuery("byId");
    assertSharedJoins(sql);
    assert.match(sql, /\ba\.\*/);
    assert.match(sql, /as device_name/);
  });

  it("backup 省略 dimension_key／rule_id／ignored_by 欄位與 device_name", () => {
    const sql = buildAlertSelectQuery("backup");
    assertSharedJoins(sql);
    assert.doesNotMatch(sql, /a\.dimension_key/);
    assert.doesNotMatch(sql, /a\.rule_id,/);
    assert.doesNotMatch(sql, /a\.ignored_by,/);
    assert.doesNotMatch(sql, /as device_name/);
    assert.match(sql, /a\.ignored_at/);
  });
});
