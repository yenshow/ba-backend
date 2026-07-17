const { listDeviceModels } = require("../constants/deviceModelCatalog");

/**
 * 僅補入 catalog 中不存在的型號。
 * 現場可能已調整同名型號，因此禁止使用 DO UPDATE 覆寫既有資料。
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

module.exports = {
  syncDeviceModelCatalog,
};
