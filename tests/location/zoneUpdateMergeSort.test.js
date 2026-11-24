/**
 * Zone update：地點 ID 配對／未知 id 拒絕／同名合併僅無 id；
 * payload 順序決定 sort_order 重寫。
 *
 *   node --test tests/location/zoneUpdateMergeSort.test.js
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const db = require("../../src/database/db");
const systemOps = require("../../src/services/location/locationSystemOps");
const {
  resolveZoneLocationMutation,
  updateZone,
} = require("../../src/services/location/locationZoneOps");

test("resolveZoneLocationMutation: 既有數字 id → update", () => {
  const existing = new Set(["1", "2", "3"]);
  assert.deepEqual(resolveZoneLocationMutation({ id: 2, name: "B" }, existing), {
    action: "update",
    locationId: 2,
    locationIdStr: "2",
  });
});

test("resolveZoneLocationMutation: 未知數字 id → reject（不可同名接走）", () => {
  const existing = new Set(["1", "2", "3"]);
  assert.deepEqual(
    resolveZoneLocationMutation({ id: 99, name: "A" }, existing),
    { action: "reject", locationIdStr: "99" },
  );
});

test("resolveZoneLocationMutation: 無 id → create（可同名合併）", () => {
  const existing = new Set(["1", "2", "3"]);
  assert.deepEqual(resolveZoneLocationMutation({ name: "A" }, existing), {
    action: "create",
  });
});

test("resolveZoneLocationMutation: temp- id → create", () => {
  const existing = new Set(["1"]);
  assert.deepEqual(
    resolveZoneLocationMutation({ id: "temp-1", name: "New" }, existing),
    { action: "create" },
  );
});

test("updateZone: 未知 id 拒絕且不呼叫 create", async (t) => {
  t.mock.method(db, "query", async (sql) => {
    if (String(sql).includes("FROM active_zones")) return [{ id: 10, name: "Z" }];
    return [];
  });
  const create = t.mock.method(systemOps, "createLocationWithSystems", async () => 99);
  const update = t.mock.method(systemOps, "updateLocationWithSystems", async () => {});
  t.mock.method(db, "transaction", async (fn) => {
    const query = async (sql) => {
      if (String(sql).includes("FROM active_locations")) return [{ id: 1 }, { id: 2 }];
      return [];
    };
    return fn(query);
  });

  await assert.rejects(
    () => updateZone(10, { locations: [{ id: 99, name: "A" }] }, 1),
    (err) => {
      assert.match(String(err?.message || err), /地點不存在：99/);
      return true;
    },
  );
  assert.equal(create.mock.callCount(), 0);
  assert.equal(update.mock.callCount(), 0);
});

test("updateZone: 無 id 同名仍走 create（同名合併規則）", async (t) => {
  const createArgs = [];
  t.mock.method(db, "query", async (sql) => {
    if (String(sql).includes("FROM active_zones")) return [{ id: 10, name: "Z" }];
    // getZoneById / loadZoneLocations 最小回傳
    return [];
  });
  t.mock.method(systemOps, "createLocationWithSystems", async (_q, zoneId, location) => {
    createArgs.push({ zoneId, location });
    return 1;
  });
  t.mock.method(systemOps, "updateLocationWithSystems", async () => {});
  t.mock.method(db, "transaction", async (fn) => {
    const query = async (sql) => {
      if (String(sql).includes("SELECT id FROM active_locations")) return [{ id: 1 }];
      return [];
    };
    return fn(query);
  });

  try {
    await updateZone(10, { locations: [{ name: "A" }] }, 1);
  } catch {
    // getZoneById 可能因 mock 不完整失敗；create 必須已執行
  }
  assert.equal(createArgs.length, 1);
  assert.equal(createArgs[0].zoneId, 10);
  assert.equal(createArgs[0].location.name, "A");
  assert.equal(createArgs[0].location.id, undefined);
});

test("updateZone: 依 payload 陣列順序重寫 sort_order（原序 1,2,3）", async (t) => {
  const sortWrites = [];
  t.mock.method(db, "query", async (sql) => {
    if (String(sql).includes("FROM active_zones")) return [{ id: 10, name: "Z" }];
    return [];
  });
  t.mock.method(systemOps, "updateLocationWithSystems", async () => {});
  t.mock.method(systemOps, "createLocationWithSystems", async () => {
    throw new Error("should not create");
  });
  t.mock.method(db, "transaction", async (fn) => {
    const query = async (sql, params) => {
      if (String(sql).includes("SELECT id FROM active_locations WHERE zone_id")) {
        return [{ id: 1 }, { id: 2 }, { id: 3 }];
      }
      if (String(sql).includes("SET sort_order")) {
        sortWrites.push({ sortOrder: params[0], locationId: params[1] });
        return [];
      }
      return [];
    };
    return fn(query);
  });

  try {
    await updateZone(
      10,
      {
        locations: [
          { id: 1, name: "L1" },
          { id: 2, name: "L2" },
          { id: 3, name: "L3" },
        ],
      },
      1,
    );
  } catch {
    // ignore post-tx getZoneById
  }

  assert.deepEqual(
    sortWrites.map((w) => [w.sortOrder, w.locationId]),
    [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
  );
});
