const BaseExternalDataService = require("../baseExternalDataService");

/**
 * Platform Person Head Pic 專用處理器（platform.person_head_pic）
 * 依 person_id 取得 standard_head_portrait、thumbnail_head_portrait（URI，需另呼叫解析取得圖片）
 * 支援 person_id 多筆（逗號分隔或陣列）IN 條件，供車輛群組批次取得車主頭像
 */
class PlatformPersonHeadPicHandler extends BaseExternalDataService {
  constructor() {
    super("platform", "person_head_pic", {
      defaultOrderBy: "person_id",
      defaultOrderDirection: "ASC",
      defaultLimit: 200,
      maxLimit: 500,
    });
  }

  getSearchableColumns() {
    return [];
  }

  /**
   * 覆寫：支援 person_id 為多筆（逗號分隔或陣列）時使用 IN 條件
   */
  buildWhereClause(filters, params = []) {
    const filtersCopy = { ...filters };
    const rawPersonId = filtersCopy.person_id;
    delete filtersCopy.person_id;

    const baseWhere = super.buildWhereClause(filtersCopy, params);

    if (rawPersonId === undefined || rawPersonId === null || rawPersonId === "") {
      return baseWhere;
    }

    const ids = Array.isArray(rawPersonId)
      ? rawPersonId.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n))
      : String(rawPersonId)
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n));

    if (ids.length === 0) {
      return baseWhere;
    }

    const placeholders = ids
      .map((_, i) => `$${params.length + 1 + i}`)
      .join(", ");
    ids.forEach((id) => params.push(id));
    const personIdCondition = `person_id IN (${placeholders})`;
    return baseWhere
      ? `${baseWhere} AND ${personIdCondition}`
      : `WHERE ${personIdCondition}`;
  }
}

module.exports = PlatformPersonHeadPicHandler;
