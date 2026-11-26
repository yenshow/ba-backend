/**
 * 人員授權編排／一人同步：單元測試（mock，不需實機）
 *
 *   node --test tests/personnel/personEntitlementAndScopedSync.test.js
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setImmediate: flush } = require("node:timers/promises");

const store = require("../../src/services/personnel/personSyncJobStore");
const scoped = require("../../src/services/personnel/personScopedSyncJobService");
const locationMember = require("../../src/services/personnel/locationMemberService");
const personnelService = require("../../src/services/personnel/personnelService");
const {
  shouldSkipApiRateLimit,
} = require("../../src/middleware/rateLimitMiddleware");

test("person_sync jobType is accepted by personSyncJobStore", async (t) => {
  const inserted = [];
  t.mock.method(store, "createJob", async (params) => {
    inserted.push(params);
    return {
      jobId: params.jobId,
      jobType: params.jobType,
      status: params.status,
      progress: params.progress || {},
    };
  });
  t.mock.method(store, "updateJob", async () => ({}));
  t.mock.method(store, "replaceWarnings", async () => {});
  t.mock.method(store, "appendItem", async () => {});

  // force early exit in worker via missing person
  t.mock.method(personnelService, "getPersonById", async () => null);

  const { jobId, reused } = await scoped.startPersonSyncJob(42, {
    domains: ["access"],
  });
  assert.equal(reused, false);
  assert.match(String(jobId), /^personsync_/);
  assert.equal(inserted[0].jobType, "person_sync");
  assert.equal(inserted[0].status, "queued");
  assert.equal(inserted[0].progress.personId, 42);
  await flush();
});

test("startPersonSyncJob reuses an in-flight person_sync job", async (t) => {
  const db = require("../../src/database/db");
  t.mock.method(db, "query", async (sql) => {
    if (String(sql).includes("person_sync_jobs") && String(sql).includes("personId")) {
      return [{ job_id: "personsync_existing" }];
    }
    return [];
  });
  const create = t.mock.method(store, "createJob", async () => {
    throw new Error("should not create");
  });
  const out = await scoped.startPersonSyncJob(7, { domains: ["plates"] });
  assert.deepEqual(out, { jobId: "personsync_existing", reused: true });
  assert.equal(create.mock.callCount(), 0);
});

test("patchPersonLocationAccess grants without replacing other members", async (t) => {
  const db = require("../../src/database/db");
  const queries = [];
  t.mock.method(db, "query", async (sql, params = []) => {
    queries.push({ sql: String(sql), params });
    if (sql.includes("FROM active_persons WHERE id")) {
      return [{ id: 9, status: "active" }];
    }
    if (sql.includes("FROM active_locations")) {
      return [{ id: 3 }];
    }
    if (sql.includes("FROM active_location_systems")) {
      return [
        {
          system_type: "people_counting",
          system_config: { entry_device_ids: [11] },
        },
      ];
    }
    if (sql.includes("SELECT location_id FROM person_location_access")) {
      return [{ location_id: 1 }];
    }
    return [];
  });
  t.mock.method(db, "transaction", async (fn) => {
    const txQuery = async (sql, params = []) => {
      queries.push({ sql: String(sql), params, tx: true });
      return [];
    };
    return fn(txQuery);
  });

  const result = await locationMember.patchPersonLocationAccess(9, {
    grantLocationIds: [3],
    revokeLocationIds: [],
  });
  assert.deepEqual(result.granted, [3]);
  assert.deepEqual(result.revoked, []);
  assert.ok(
    queries.some(
      (q) =>
        q.tx &&
        q.sql.includes("INSERT INTO person_location_access") &&
        q.params.includes(9) &&
        q.params.includes(3),
    ),
  );
  assert.equal(
    queries.some((q) => q.sql.includes("DELETE FROM person_location_access WHERE location_id")),
    false,
    "must not wipe whole location roster",
  );
});

test("authenticated person_sync job GET is skipped by API rate limit", () => {
  const AUTH = "Bearer test-token";
  const url = "/api/personnel/persons/12/sync/jobs/personsync_abc";
  assert.equal(
    shouldSkipApiRateLimit({
      method: "GET",
      originalUrl: url,
      url,
      headers: { authorization: AUTH },
    }),
    true,
  );
  assert.equal(
    shouldSkipApiRateLimit({
      method: "POST",
      originalUrl: "/api/personnel/persons/12/sync",
      url: "/api/personnel/persons/12/sync",
      headers: { authorization: AUTH },
    }),
    false,
  );
});
