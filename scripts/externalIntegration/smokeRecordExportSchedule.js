/**
 * 實際測：轉存 scheduleFreq／資料窗／立刻匯出（不寫入 plan）
 *   cd ba-backend && node scripts/externalIntegration/smokeRecordExportSchedule.js
 */
const path = require("path");
const fs = require("fs");
process.chdir(path.resolve(__dirname, "../.."));

const { DateTime } = require("luxon");
const db = require("../../src/database/db");
const config = require("../../src/config");
const recordExportService = require("../../src/services/externalIntegration/recordExportService");
const {
  resolveExportWindow,
  computeNextExportRunAt,
} = require("../../src/services/externalIntegration/exportSchedule");

const BASE = `http://127.0.0.1:${config.port || 4000}`;
const USER = process.env.BA_USERNAME || "admin";
const PASS = process.env.BA_PASSWORD || "Aa83124007";
const TEST_PREFIX = "BA_SMOKE_SCHED_";
const OUT_DIR = path.resolve("tmp", "record-export-schedule-smoke");

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const api = async (token, method, urlPath, body) => {
  const res = await fetch(`${BASE}/api${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const err = json?.error || json?.message || res.statusText;
    throw new Error(`${method} ${urlPath} → ${res.status}: ${JSON.stringify(err)}`);
  }
  return json.data ?? json;
};

const login = async () => {
  const res = await fetch(`${BASE}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const json = await res.json();
  const token = json?.data?.token || json?.token;
  assert(token, `登入失敗: ${JSON.stringify(json)}`);
  return token;
};

const ensureColumns = async () => {
  const rows = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'record_export_rules'
       AND column_name IN ('schedule_freq','schedule_day')`,
  );
  const names = new Set((rows || []).map((r) => r.column_name));
  assert(names.has("schedule_freq"), "缺少 schedule_freq（請重啟後端跑 schemaPatches）");
  assert(names.has("schedule_day"), "缺少 schedule_day");
  console.log("✓ DB 欄位 schedule_freq / schedule_day 存在");
};

const catalogFields = async (token, eventType) => {
  const data = await api(
    token,
    "GET",
    `/record-export/rules?eventType=${encodeURIComponent(eventType)}`,
  );
  const fields = (data.fields || []).slice(0, 3).map((f) => ({
    fieldKey: f.key,
    headerLabel: f.label || f.key,
    format: f.requiresFormat ? "yyyy-MM-dd HH:mm:ss" : undefined,
  }));
  assert(fields.length > 0, "無可用 catalog 欄位");
  return fields;
};

const upsertViaApi = async (token, payload, ruleId) => {
  if (ruleId) {
    return api(token, "PUT", `/record-export/rules/${ruleId}`, payload);
  }
  return api(token, "POST", `/record-export/rules`, payload);
};

const cleanup = async () => {
  await db.query(`DELETE FROM record_export_rules WHERE name LIKE ?`, [`${TEST_PREFIX}%`]);
};

const main = async () => {
  console.log(`API ${BASE}  user=${USER}`);
  await ensureColumns();

  // --- 純函式：資料窗／nextAt ---
  const fri = DateTime.fromObject(
    { year: 2026, month: 8, day: 28, hour: 10 },
    { zone: "Asia/Taipei" },
  );
  const weekly = resolveExportWindow({
    scheduleFreq: "weekly",
    scheduleDay: 5,
    now: fri.toJSDate(),
  });
  assert(
    weekly.startIso.startsWith("2026-08-21T00:00:00") &&
      weekly.endIso.startsWith("2026-08-28T00:00:00"),
    `週窗不符: ${weekly.startIso} → ${weekly.endIso}`,
  );
  const monthly = resolveExportWindow({
    scheduleFreq: "monthly",
    scheduleDay: 5,
    now: DateTime.fromObject(
      { year: 2026, month: 8, day: 5, hour: 12 },
      { zone: "Asia/Taipei" },
    ).toJSDate(),
  });
  assert(
    monthly.startIso.startsWith("2026-07-05T00:00:00") &&
      monthly.endIso.startsWith("2026-08-05T00:00:00"),
    `月窗不符: ${monthly.startIso} → ${monthly.endIso}`,
  );
  const next = computeNextExportRunAt({
    scheduleFreq: "weekly",
    scheduleDay: 5,
    timeHHmm: "18:00",
    now: DateTime.fromObject(
      { year: 2026, month: 8, day: 26, hour: 10 },
      { zone: "Asia/Taipei" },
    ),
  });
  assert(next.toISO().startsWith("2026-08-28T18:00:00"), `nextAt 不符: ${next.toISO()}`);
  console.log("✓ resolveExportWindow / computeNextExportRunAt");

  await cleanup();
  const token = await login();
  console.log("✓ API 登入");

  const fields = await catalogFields(token, "operational");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const basePayload = {
    eventType: "operational",
    filenamePrefix: "SmokeSched",
    dateFormat: "yyyyMMdd",
    timeFormat: "HHmmss",
    outputFormat: "csv",
    exportTime: "23:50",
    storageType: "local",
    localDir: OUT_DIR,
    filter: {},
    fields,
  };

  // daily
  const dailyRes = await upsertViaApi(token, {
    ...basePayload,
    name: `${TEST_PREFIX}daily`,
    scheduleFreq: "daily",
    scheduleDay: null,
  });
  const dailyId = dailyRes?.id ?? dailyRes?.rule?.id;
  assert(dailyId, `daily 建立失敗: ${JSON.stringify(dailyRes)}`);

  // weekly 五
  const weeklyRes = await upsertViaApi(token, {
    ...basePayload,
    name: `${TEST_PREFIX}weekly`,
    scheduleFreq: "weekly",
    scheduleDay: 5,
    exportTime: "18:00",
  });
  const weeklyId = weeklyRes?.id ?? weeklyRes?.rule?.id;
  assert(weeklyId, `weekly 建立失敗`);

  // monthly 5
  const monthlyRes = await upsertViaApi(token, {
    ...basePayload,
    name: `${TEST_PREFIX}monthly`,
    scheduleFreq: "monthly",
    scheduleDay: 5,
    exportTime: "09:00",
  });
  const monthlyId = monthlyRes?.id ?? monthlyRes?.rule?.id;
  assert(monthlyId, `monthly 建立失敗`);
  console.log(`✓ API 建立規則 daily=${dailyId} weekly=${weeklyId} monthly=${monthlyId}`);

  const listed = await api(token, "GET", "/record-export/rules");
  const smoke = (listed.rules || []).filter((r) => String(r.name).startsWith(TEST_PREFIX));
  assert(smoke.length >= 3, `列表應含 3 筆 smoke，實際 ${smoke.length}`);
  const wRule = smoke.find((r) => r.id === weeklyId);
  assert(wRule?.scheduleFreq === "weekly" && Number(wRule.scheduleDay) === 5, "列表週排程欄位錯誤");
  const mRule = smoke.find((r) => r.id === monthlyId);
  assert(mRule?.scheduleFreq === "monthly" && Number(mRule.scheduleDay) === 5, "列表月排程欄位錯誤");
  console.log("✓ GET /record-export/rules 回傳 scheduleFreq/Day");

  // 立刻轉存（走 resolveExportWindow）
  for (const id of [dailyId, weeklyId, monthlyId]) {
    const result = await recordExportService.runRecordExportRule(id);
    assert(result?.ok, `匯出失敗 id=${id}: ${JSON.stringify(result)}`);
    console.log(`✓ runRecordExportRule id=${id} rows=${result.rowCount} file=${result.filePath}`);
  }

  // 驗證 DB 列
  const dbRows = await db.query(
    `SELECT id, name, schedule_freq, schedule_day, export_time::text AS export_time
     FROM record_export_rules WHERE name LIKE ? ORDER BY id`,
    [`${TEST_PREFIX}%`],
  );
  console.log("DB rows:", dbRows);

  // 對接仍無 schedule 欄位
  const syncCols = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'external_sync_configs' AND column_name LIKE 'schedule%'`,
  );
  assert(!(syncCols || []).length, "對接表不應有 schedule_* 欄位");
  console.log("✓ external_sync_configs 無週／月欄位");

  await cleanup();
  console.log("✓ 已清理測試規則");
  console.log("\n全部通過");
};

main()
  .then(async () => {
    await db.close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\n失敗:", err?.message || err);
    try {
      await cleanup();
      await db.close();
    } catch (_e) {
      /* ignore */
    }
    process.exit(1);
  });
