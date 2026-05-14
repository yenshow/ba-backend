/* eslint-disable no-console */
/**
 * 1) 人員資料新增 / 刪除腳本（批次）
 *
 * Create（批次新增，可選擇加入某地點門禁名單）：
 * node scripts/personnelBulk.js --action=create --apiBase=http://127.0.0.1:4000/api --username=admin --password=pass --count=500 --concurrency=10 --employeePrefix=C --startNo=1 --pad=4 --locationId=1 --attachToLocation=1
 *
 * Cleanup（讀 state 檔：先還原地點名單(若有) -> 再刪除該批次人員）：
 * node scripts/personnelBulk.js --action=cleanup --stateFile=./.loadtest-state/state_<batchKey>.json --apiBase=http://127.0.0.1:4000/api --username=admin --password=pass --concurrency=10
 *
 * 說明：
 * - login 使用 username/password
 * - create 會產生 state 檔（含 createdIds、batchKey、originalMemberIds(若有)）
 * - attachToLocation=1 時會先抓原本地點名單再 merge（PUT 是取代整份名單）
 */
const path = require("path");
const {
  DEFAULT_API_BASE,
  parseArgs,
  toInt,
  envFlag,
  nowKey,
  createLimiter,
  createClient,
  login,
  defaultStateDir,
  writeJson,
  readJson,
} = require("./_personnelTestLib");

const listAllLocationMemberIds = async (client, locationId) => {
  const ids = [];
  const limit = 200;
  let offset = 0;
  for (;;) {
    const paged = await client.get(
      `/personnel/locations/${encodeURIComponent(locationId)}/members?limit=${limit}&offset=${offset}`,
    );
    const items = Array.isArray(paged?.items) ? paged.items : [];
    for (const p of items) {
      if (p && p.id != null) ids.push(Number(p.id));
    }
    offset += items.length;
    const total = paged?.total != null ? Number(paged.total) : null;
    if (items.length === 0) break;
    if (total != null && Number.isFinite(total) && offset >= total) break;
  }
  return ids.filter((n) => Number.isFinite(n) && n > 0);
};

const replaceLocationMembers = async (client, locationId, memberPersonIds) => {
  return await client.put(`/personnel/locations/${encodeURIComponent(locationId)}/members`, {
    memberPersonIds: Array.isArray(memberPersonIds) ? memberPersonIds : [],
  });
};

// 建立人員的邏輯已內嵌於 main（因需支援 employeePrefix/startNo/pad）。

const deletePersons = async ({ client, personIds, concurrency }) => {
  const limit = createLimiter(concurrency);
  const tasks = (personIds || []).map((id) =>
    limit(async () => {
      await client.delete(`/personnel/persons/${encodeURIComponent(id)}`);
      return true;
    }),
  );
  await Promise.all(tasks);
};

const main = async () => {
  const args = parseArgs(process.argv);

  const apiBase = String(args.apiBase || process.env.API_BASE || DEFAULT_API_BASE);
  const username = String(args.username || process.env.USERNAME || "").trim();
  const password = String(args.password || process.env.PASSWORD || "").trim();
  const action = String(args.action || process.env.ACTION || "").trim().toLowerCase();
  const concurrency = Math.max(1, toInt(args.concurrency || process.env.CONCURRENCY, 10));

  if (!username || !password) {
    throw new Error("缺少登入資訊：請提供 --username / --password（或 USERNAME / PASSWORD）");
  }
  if (action !== "create" && action !== "cleanup") {
    throw new Error("缺少或不支援的 --action（僅支援 create | cleanup）");
  }

  const { token, user } = await login({ apiBase, username, password });
  const client = createClient({ apiBase, token });

  if (action === "cleanup") {
    const stateFile = String(args.stateFile || process.env.STATE_FILE || "").trim();
    if (!stateFile) throw new Error("cleanup 需要 --stateFile（或 STATE_FILE）");
    const state = await readJson(stateFile);

    const locationId = state?.locationId || null;
    const createdIds = Array.isArray(state?.createdIds) ? state.createdIds.map((x) => Number(x)) : [];
    const originalMemberIds = Array.isArray(state?.originalMemberIds)
      ? state.originalMemberIds.map((x) => Number(x))
      : null;

    console.log(`[CLEANUP] user=${user?.username || username} created=${createdIds.length} locationId=${locationId || "-"}`);

    if (locationId && Array.isArray(originalMemberIds)) {
      console.log("[CLEANUP] restore location members");
      await replaceLocationMembers(client, locationId, originalMemberIds);
    }

    console.log("[CLEANUP] delete persons");
    await deletePersons({ client, personIds: createdIds, concurrency });
    console.log("[CLEANUP] done");
    return;
  }

  const count = Math.max(1, toInt(args.count || process.env.COUNT, 500));
  const batchKey = String(args.batchKey || process.env.BATCH_KEY || `LOADTEST_${nowKey()}`);
  const stateDir = defaultStateDir();
  const stateFile = String(args.stateFile || process.env.STATE_FILE || path.join(stateDir, `state_${batchKey}.json`));

  const employeePrefix = String(args.employeePrefix || process.env.EMPLOYEE_PREFIX || "C").trim() || "C";
  const startNo = Math.max(1, toInt(args.startNo || process.env.START_NO, 1));
  const pad = Math.max(1, toInt(args.pad || process.env.PAD, 4));

  const locationId = toInt(args.locationId || process.env.LOCATION_ID, 0) || null;
  const attachToLocation =
    args.attachToLocation != null ? Boolean(args.attachToLocation) : envFlag("ATTACH_TO_LOCATION", false);

  const state = {
    kind: "personnelBulk",
    apiBase,
    username,
    batchKey,
    count,
    concurrency,
    employeePrefix,
    startNo,
    pad,
    createdAt: new Date().toISOString(),
    locationId: locationId || null,
    attachToLocation: Boolean(attachToLocation && locationId),
    originalMemberIds: null,
    createdIds: [],
  };

  await writeJson(stateFile, state);

  console.log(`[INIT] apiBase=${apiBase}`);
  console.log(`[INIT] user=${user?.username || username} role=${user?.role || "?"}`);
  console.log(`[INIT] batchKey=${batchKey} count=${count} concurrency=${concurrency}`);
  console.log(`[INIT] employeeNo=${employeePrefix}${String(startNo).padStart(pad, "0")}.. (${pad} digits)`);
  console.log(`[INIT] locationId=${locationId || "-"} attachToLocation=${state.attachToLocation ? "1" : "0"}`);
  console.log(`[INIT] stateFile=${stateFile}`);

  // 1) 若要掛到地點：先保存原名單
  if (state.attachToLocation) {
    console.log("[STEP] fetch original location members");
    const originalMemberIds = await listAllLocationMemberIds(client, locationId);
    state.originalMemberIds = originalMemberIds;
    await writeJson(stateFile, state);
    console.log(`[STEP] original members=${originalMemberIds.length}`);
  }

  // 2) 建立人員
  console.log("[STEP] create persons");
  const createdIds = await (async () => {
    const limit = createLimiter(concurrency);
    const tasks = [];
    for (let i = 0; i < count; i += 1) {
      const n = startNo + i;
      const employeeNo = `${employeePrefix}${String(n).padStart(pad, "0")}`;
      const fullName = `壓測人員 ${String(n).padStart(pad, "0")}`;
      tasks.push(
        limit(async () => {
          const person = await client.post("/personnel/persons", { employeeNo, fullName });
          if (!person?.id) throw new Error(`建立人員失敗（employeeNo=${employeeNo}）：缺少 id`);
          return Number(person.id);
        }),
      );
    }
    const ids = await Promise.all(tasks);
    return ids.filter((x) => Number.isFinite(x) && x > 0);
  })();
  state.createdIds = createdIds;
  await writeJson(stateFile, state);
  console.log(`[STEP] created=${createdIds.length}`);

  // 3) 若要掛到地點：merge 後更新名單
  if (state.attachToLocation) {
    console.log("[STEP] attach to location (merge)");
    const merged = Array.from(new Set([...(state.originalMemberIds || []), ...createdIds]));
    await replaceLocationMembers(client, locationId, merged);
    console.log(`[STEP] merged members=${merged.length}`);
  }

  console.log("[DONE] create finished");
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });

