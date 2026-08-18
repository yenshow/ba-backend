const { listDeviceModels } = require("../constants/deviceModelCatalog");

/**
 * 僅補入 catalog 中不存在的型號。
 * 現場可能已調整同名型號，因此禁止使用 DO UPDATE 覆寫既有資料。
 * repairDeviceModelCatalogConfig 僅補缺失的 catalog 欄位（如 unitType），不覆寫已有值。
 */
async function syncDeviceModelCatalog(pool) {
  const models = listDeviceModels();
  let insertedCount = 0;

  for (const model of models) {
    const result = await pool.query(
      `
        INSERT INTO device_models (
          name,
          type_code,
          category_code,
          port,
          unit_id,
          description,
          config
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (type_code, name) DO NOTHING
      `,
      [
        model.name,
        model.typeCode,
        model.categoryCode,
        model.port,
        model.unitId,
        model.description,
        JSON.stringify(model.config),
      ],
    );
    insertedCount += result.rowCount;
  }

  return { catalogCount: models.length, insertedCount };
}

const isBlankConfigValue = (value) =>
  value == null || (typeof value === "string" && value.trim() === "");

async function repairDeviceModelCatalogConfig(pool) {
  const models = listDeviceModels();
  let repairedCount = 0;

  for (const catalog of models) {
    const catalogConfig =
      catalog.config && typeof catalog.config === "object" ? catalog.config : {};
    const hasCatalogConfig = Object.keys(catalogConfig).length > 0;
    if (!hasCatalogConfig && catalog.port == null) continue;

    const rows = await pool.query(
      `
        SELECT id, port, config
        FROM device_models
        WHERE type_code = $1 AND name = $2
        LIMIT 1
      `,
      [catalog.typeCode, catalog.name],
    );
    if (!rows.rowCount) continue;

    const row = rows.rows[0];
    const existingConfig =
      row.config && typeof row.config === "object" ? { ...row.config } : {};

    let configChanged = false;
    for (const [key, value] of Object.entries(catalogConfig)) {
      if (isBlankConfigValue(existingConfig[key])) {
        existingConfig[key] = value;
        configChanged = true;
      }
    }

    const needsPort = row.port == null && catalog.port != null;
    if (!configChanged && !needsPort) continue;

    await pool.query(
      `
        UPDATE device_models
        SET
          config = $1::jsonb,
          port = COALESCE(port, $2),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
      `,
      [JSON.stringify(existingConfig), catalog.port, row.id],
    );
    repairedCount += 1;
  }

  return { repairedCount };
}

module.exports = {
  syncDeviceModelCatalog,
  repairDeviceModelCatalogConfig,
};
