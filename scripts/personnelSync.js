/* eslint-disable no-console */
/**
 * 2) 設備同步腳本（單一地點）
 *
 * 啟動同步 job + 輪詢完成：
 * node scripts/personnelSync.js --apiBase=http://127.0.0.1:4000/api --username=admin --password=pass --locationId=1 --pollMs=2000
 *
 * 你也可以用 STATE_FILE 帶入 locationId（若沒傳 --locationId）：
 * node scripts/personnelSync.js --stateFile=./.loadtest-state/state_<batchKey>.json --apiBase=... --username=... --password=...
 */
const {
  DEFAULT_API_BASE,
  parseArgs,
  toInt,
  sleep,
  createClient,
  login,
  readJson,
} = require("./_personnelTestLib");

const startSyncLocationJob = async (client, locationId) => {
  const res = await client.post(`/personnel/sync-location/${encodeURIComponent(locationId)}/job`, {});
  if (!res?.jobId) throw new Error("啟動同步 job 失敗：缺少 jobId");
  return String(res.jobId);
};

const waitSyncLocationJob = async (client, jobId, { pollMs = 2000 } = {}) => {
  for (;;) {
    const job = await client.get(`/personnel/sync-location/jobs/${encodeURIComponent(jobId)}`);
    if (job?.status === "completed") return job;

    const p = job?.progress || {};
    if (p && typeof p === "object") {
      const attempted = Number(p.attempted) || 0;
      const completed = Number(p.completed) || 0;
      const total = Number(p.total) || 0;
      const deviceIndex = Number(p.currentDeviceIndex) || 0;
      const deviceTotal = Number(p.deviceTotal) || 0;
      const currentAction = p.currentAction || "";
      const currentStage = p.currentStage || "";
      const currentEmployeeNo = p.currentEmployeeNo || "";
      process.stdout.write(
        `\r[SYNC] ops ${completed}/${total} (attempted=${attempted}) devices ${deviceIndex}/${deviceTotal} ${currentAction} ${currentStage} ${currentEmployeeNo}      `,
      );
    }
    await sleep(pollMs);
  }
};

const main = async () => {
  const args = parseArgs(process.argv);

  const apiBase = String(args.apiBase || process.env.API_BASE || DEFAULT_API_BASE);
  const username = String(args.username || process.env.USERNAME || "").trim();
  const password = String(args.password || process.env.PASSWORD || "").trim();
  const pollMs = Math.max(500, toInt(args.pollMs || process.env.POLL_MS, 2000));

  if (!username || !password) {
    throw new Error("缺少登入資訊：請提供 --username / --password（或 USERNAME / PASSWORD）");
  }

  let locationId = toInt(args.locationId || process.env.LOCATION_ID, 0);
  const stateFile = String(args.stateFile || process.env.STATE_FILE || "").trim();
  if (!locationId && stateFile) {
    const state = await readJson(stateFile);
    if (state?.locationId) locationId = Number(state.locationId);
  }
  if (!locationId) throw new Error("缺少 --locationId（或提供 --stateFile 讓腳本讀取）");

  const { token, user } = await login({ apiBase, username, password });
  const client = createClient({ apiBase, token });

  console.log(`[INIT] apiBase=${apiBase}`);
  console.log(`[INIT] user=${user?.username || username} role=${user?.role || "?"}`);
  console.log(`[INIT] locationId=${locationId} pollMs=${pollMs}`);

  console.log("[STEP] start sync job");
  const jobId = await startSyncLocationJob(client, locationId);
  console.log(`[STEP] jobId=${jobId}`);

  console.log("[STEP] wait job completed");
  const job = await waitSyncLocationJob(client, jobId, { pollMs });
  process.stdout.write("\n");

  const warnings = Array.isArray(job?.result?.warnings) ? job.result.warnings : [];
  const errMsg = job?.error?.message ? String(job.error.message) : null;

  console.log(`[DONE] status=${job.status} warnings=${warnings.length} error=${errMsg || "-"}`);
};

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});

