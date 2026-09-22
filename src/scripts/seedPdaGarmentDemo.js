/**
 * 開發／驗證用：套用 garment 表並寫入示範資料（需已有 locations）。
 * 用法：node src/scripts/seedPdaGarmentDemo.js
 *
 * 測試主檔：
 * - A0002 Jimmy E54301802 洗次 50 → 超洗（上限 50）
 * - B0001 Jerry F04560663 洗次 25 → 合格（上限 50）
 */
const db = require("../database/db");
const { applySchemaPatches } = require("../database/schemaPatches");
const logger = require("../utils/logger").createLogger("seedPdaGarment");

async function main() {
  await applySchemaPatches(db.pool);

  const locations = await db.query(
    `SELECT id, name FROM locations ORDER BY id ASC LIMIT 5`,
  );
  if (!locations.length) {
    throw new Error("沒有 locations，請先在平台建立至少一個地點");
  }
  const locationId = locations[0].id;
  logger.info("使用 location", { locationId, name: locations[0].name });

  await db.query(
    `INSERT INTO pda_entrance_bindings (device_code, location_id, entrance_label, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (device_code) DO UPDATE SET
       location_id = EXCLUDED.location_id,
       entrance_label = EXCLUDED.entrance_label,
       updated_at = CURRENT_TIMESTAMP`,
    ["PDA202", locationId, "無塵室入口示範"],
  );

  // plant/garment 取條碼前 2 / 後 3，與 garmentCheckService.parseBarcodeParts 一致
  await db.query(
    `INSERT INTO garment_master
       (barcode, employee_name, department, plant_code, garment_type, wash_count, last_wash_date, updated_at)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP),
       (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (barcode) DO UPDATE SET
       employee_name = EXCLUDED.employee_name,
       department = EXCLUDED.department,
       plant_code = EXCLUDED.plant_code,
       garment_type = EXCLUDED.garment_type,
       wash_count = EXCLUDED.wash_count,
       last_wash_date = EXCLUDED.last_wash_date,
       updated_at = CURRENT_TIMESTAMP`,
    [
      "E54301802",
      "Jimmy",
      "A0002",
      "E5",
      "802",
      50,
      "2026-09-01",
      "F04560663",
      "Jerry",
      "B0001",
      "F0",
      "663",
      25,
      "2026-09-01",
    ],
  );

  await db.query(
    `INSERT INTO garment_wash_limits (location_id, plant_code, garment_type, wash_limit)
     VALUES (?, 'E5', '802', 50), (?, 'F0', '663', 50)
     ON CONFLICT (location_id, plant_code, garment_type)
     DO UPDATE SET wash_limit = EXCLUDED.wash_limit`,
    [locationId, locationId],
  );

  logger.info("示範資料就緒", {
    overwash: "E54301802 (Jimmy / A0002 / 洗次50 / 上限50)",
    pass: "F04560663 (Jerry / B0001 / 洗次25 / 上限50)",
    unknown: "ZZNOTEXIST01",
    deviceCode: "PDA202",
  });
  process.exit(0);
}

main().catch((error) => {
  logger.error(error.message || String(error));
  process.exit(1);
});
