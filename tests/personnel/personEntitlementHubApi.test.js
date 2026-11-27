/**
 * 人員授權 Hub／增量授權／一人同步／onboarding API 整合測試
 *
 * 套用授權產品語意：location-access／ladder-card 用 sync:false，再一次 POST .../sync。
 * （本檔 incremental 測試已用 sync:false；person_sync 另測手動 start。）
 *
 *   node tests/personnel/personEntitlementHubApi.test.js
 *
 * 前置：後端已啟動（預設 http://127.0.0.1:4000）
 */
const assert = require("node:assert/strict");

const API_BASE = (process.env.BA_API_BASE || "http://127.0.0.1:4000/api").replace(
  /\/$/,
  "",
);
const USERNAME = process.env.BA_USERNAME || "admin";
const PASSWORD = process.env.BA_PASSWORD || "Aa83124007";
const JOB_POLL_MS = Number(process.env.BA_SYNC_JOB_POLL_MS || 2000);
const JOB_TIMEOUT_MS = Number(process.env.BA_SYNC_JOB_TIMEOUT_MS || 120_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const unwrap = async (res) => {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status}: ${body.message || body.code || JSON.stringify(body)}`,
    );
  }
  if (body && typeof body === "object" && "data" in body) return body.data;
  return body;
};

const authFetch = async (token, path, options = {}) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  return unwrap(res);
};

const login = async () => {
  const lr = await fetch(`${API_BASE}/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const loginBody = await lr.json().catch(() => ({}));
  if (!lr.ok) {
    throw new Error(
      `login HTTP ${lr.status}: ${loginBody.message || JSON.stringify(loginBody)}`,
    );
  }
  const token = loginBody.data?.token ?? loginBody.token;
  assert.ok(token, "login token missing");
  return token;
};

const pollPersonSyncJob = async (token, personId, jobId) => {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < JOB_TIMEOUT_MS) {
    last = await authFetch(
      token,
      `/personnel/persons/${personId}/sync/jobs/${encodeURIComponent(jobId)}?includeIssues=1`,
    );
    if (last?.status === "completed") return last;
    await sleep(JOB_POLL_MS);
  }
  throw new Error(`person_sync timeout: ${jobId} (last=${last?.status})`);
};

async function testEntitlementsShape(token) {
  const page = await authFetch(token, "/personnel/persons?limit=5&offset=0&status=active");
  const person = (page?.items || page?.rows || [])[0];
  if (!person?.id) {
    console.log("⊘ skip entitlements (no active person)");
    return null;
  }
  const data = await authFetch(token, `/personnel/persons/${person.id}/entitlements`);
  assert.equal(data.personId, person.id);
  assert.ok(data.credentials && typeof data.credentials === "object");
  assert.ok(Array.isArray(data.locations));
  assert.ok(Array.isArray(data.elevator));
  assert.ok(Array.isArray(data.activeJobs));
  console.log(
    `✓ entitlements person=${person.employee_no} locations=${data.locations.length} elevator=${data.elevator.length}`,
  );
  return { person, entitlements: data };
}

async function testIncrementalGrantDoesNotWipeRoster(token, person, entitlements) {
  const candidates = (entitlements.locations || []).filter((l) => !l.granted);
  if (candidates.length === 0) {
    console.log("⊘ skip incremental grant (no ungranted candidate location)");
    return;
  }
  const locationId = Number(candidates[0].locationId);
  const before = await authFetch(token, `/personnel/locations/${locationId}/member-ids`);
  const beforeIds = new Set((before?.ids || []).map((x) => Number(x)));

  const patch = await authFetch(token, `/personnel/persons/${person.id}/location-access`, {
    method: "POST",
    body: JSON.stringify({
      grantLocationIds: [locationId],
      revokeLocationIds: [],
      sync: false,
    }),
  });
  assert.ok(patch.granted.includes(locationId));

  const after = await authFetch(token, `/personnel/locations/${locationId}/member-ids`);
  const afterIds = new Set((after?.ids || []).map((x) => Number(x)));
  assert.ok(afterIds.has(Number(person.id)), "person should be granted");
  for (const id of beforeIds) {
    assert.ok(afterIds.has(id), `existing member ${id} must remain`);
  }
  console.log(
    `✓ incremental grant location=${locationId} roster ${beforeIds.size}→${afterIds.size} (no wipe)`,
  );

  // restore
  await authFetch(token, `/personnel/persons/${person.id}/location-access`, {
    method: "POST",
    body: JSON.stringify({
      grantLocationIds: [],
      revokeLocationIds: [locationId],
      sync: false,
    }),
  });
  console.log(`✓ incremental revoke restored location=${locationId}`);
}

async function testPersonSyncJob(token, person) {
  const started = await authFetch(token, `/personnel/persons/${person.id}/sync`, {
    method: "POST",
    body: JSON.stringify({ domains: ["access", "plates"] }),
  });
  assert.ok(started.jobId, "jobId required");
  const job = await pollPersonSyncJob(token, person.id, started.jobId);
  assert.equal(job.status, "completed");
  assert.equal(Number(job.progress?.personId), Number(person.id));
  console.log(
    `✓ person_sync job=${started.jobId} failed=${job.progress?.failed || 0} warnings=${job.result?.warningCount ?? "?"}`,
  );
}

async function testOnboardingResume(token) {
  const suffix = String(Date.now()).slice(-8);
  const employeeNo = `T${suffix}`;
  const created = await authFetch(token, "/personnel/onboarding", {
    method: "POST",
    body: JSON.stringify({
      step: "profile",
      profile: {
        employeeNo,
        fullName: `測試新人${suffix}`,
        status: "active",
      },
    }),
  });
  assert.ok(created.personId);
  assert.ok(created.completedSteps.includes("profile"));

  const continued = await authFetch(token, "/personnel/onboarding", {
    method: "POST",
    body: JSON.stringify({
      step: "credentials",
      personId: created.personId,
      credentials: {},
    }),
  });
  assert.ok(continued.completedSteps.includes("credentials"));
  console.log(`✓ onboarding resume personId=${created.personId} employeeNo=${employeeNo}`);

  // cleanup：停用即可（避免刪除權限／裝置副作用干擾）
  await authFetch(token, `/personnel/persons/${created.personId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "inactive" }),
  });
}

async function main() {
  console.log(`API_BASE=${API_BASE}`);
  const token = await login();
  const ctx = await testEntitlementsShape(token);
  if (ctx) {
    await testIncrementalGrantDoesNotWipeRoster(token, ctx.person, ctx.entitlements);
    await testPersonSyncJob(token, ctx.person);
  }
  await testOnboardingResume(token);
  console.log("All person entitlement hub API tests passed.");
}

main().catch((err) => {
  console.error("FAILED:", err?.message || err);
  process.exit(1);
});
