/**
 * 合併門禁重複列：同一設備、同一秒、同一人、同一事件子類型，
 * 且沒有兩個不同的 serialNo。保留較小的 id，刪除其餘列與對應營運事件。
 * 保留列沒有圖時，改掛另一列的 picture_path。不加 --apply 只預覽。
 *
 *   cd ba-backend
 *   node scripts/dedupeAccessEvents.js
 *   node scripts/dedupeAccessEvents.js --apply
 */
/* eslint-disable no-console */

const db = require("../src/database/db");

const LIST_SQL = `
WITH base AS (
  SELECT
    id,
    device_id,
    event_time,
    COALESCE(payload->>'personName', '') AS person_name,
    COALESCE(payload->>'subEventType', '') AS sub_type,
    COALESCE(
      NULLIF(payload->>'employeeNoString', ''),
      NULLIF(payload->>'employeeNo', ''),
      NULLIF(payload->>'personName', ''),
      NULLIF(payload->>'cardNo', ''),
      ''
    ) AS who,
    COALESCE(payload->>'serialNo', '') AS serial_no,
    NULLIF(BTRIM(COALESCE(picture_path, '')), '') AS picture_path
  FROM isapi_access_events
),
keys AS (
  SELECT
    device_id,
    date_trunc('second', event_time) AS event_second,
    sub_type,
    who,
    MIN(id) AS keep_id
  FROM base
  GROUP BY device_id, date_trunc('second', event_time), sub_type, who
  HAVING COUNT(*) > 1
     AND COUNT(DISTINCT NULLIF(serial_no, '')) <= 1
)
SELECT
  b.id,
  k.keep_id,
  b.device_id,
  b.event_time,
  b.person_name,
  b.sub_type,
  b.serial_no,
  b.picture_path
FROM base b
JOIN keys k
  ON b.device_id IS NOT DISTINCT FROM k.device_id
 AND date_trunc('second', b.event_time) = k.event_second
 AND b.sub_type = k.sub_type
 AND b.who = k.who
ORDER BY k.keep_id, b.id
`;

const timeLabel = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("sv-SE", { timeZone: "Asia/Taipei" });
};

const main = async () => {
  const rows = await db.query(LIST_SQL);
  const groups = new Map();
  for (const row of rows || []) {
    const keepId = Number(row.keep_id);
    if (!groups.has(keepId)) groups.set(keepId, []);
    groups.get(keepId).push(row);
  }

  if (groups.size === 0) {
    console.log("沒有可合併的重複列。");
    return;
  }

  const apply = process.argv.includes("--apply");
  let dropCount = 0;
  for (const [keepId, members] of groups) {
    const dropIds = members
      .map((row) => Number(row.id))
      .filter((id) => id !== keepId);
    dropCount += dropIds.length;
    const sample = members[0];
    console.log(
      `保留 #${keepId}  刪除 ${dropIds.map((id) => `#${id}`).join("、")}  ` +
        `設備 ${sample.device_id}  ${timeLabel(sample.event_time)}  ${sample.person_name || "—"}`,
    );
  }
  console.log(`共 ${groups.size} 組、將刪除 ${dropCount} 筆。`);
  if (!apply) {
    console.log("以上為預覽。確認後加上 --apply 才會改資料庫。");
    return;
  }

  await db.transaction(async (query) => {
    for (const [keepId, members] of groups) {
      const dropIds = members.map((row) => Number(row.id)).filter((id) => id !== keepId);
      const picture = members.find((row) => row.picture_path)?.picture_path || null;
      const serial = members.find((row) => String(row.serial_no || "").trim() !== "")?.serial_no || "";
      if (picture) {
        await query(
          `UPDATE isapi_access_events
           SET picture_path = ?, file_count = 1
           WHERE id = ?
             AND (picture_path IS NULL OR BTRIM(picture_path) = '')`,
          [picture, keepId],
        );
      }
      if (serial) {
        await query(
          `UPDATE isapi_access_events
           SET payload = jsonb_set(payload, '{serialNo}', to_jsonb(?::text), true)
           WHERE id = ?
             AND COALESCE(payload->>'serialNo', '') = ''`,
          [serial, keepId],
        );
      }
      await query(
        `DELETE FROM operational_events
         WHERE ref_table = 'isapi_access_events'
           AND ref_id = ANY(?::bigint[])`,
        [dropIds],
      );
      await query(`DELETE FROM isapi_access_events WHERE id = ANY(?::bigint[])`, [dropIds]);
    }
  });
  console.log(`已刪除 ${dropCount} 筆重複門禁事件。人流頁重新整理即可。`);
};

main()
  .catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.close();
    } catch (_error) {
      /* 連線池可能尚未建立 */
    }
  });
