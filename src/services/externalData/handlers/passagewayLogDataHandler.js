const BaseExternalDataService = require("../baseExternalDataService");
const { applyDefaultTimeFilters } = require("../../../utils/dateRangeUtils");
const externalDb = require("../../../database/externalDb");

/**
 * 出入口過車日誌專用處理器（vehiclebiz.passageway_log_data）
 * 對應欄位：lane_name、trigger_time、owner 車主資訊、license_plate、
 * plate_license_image_url、vehicle_list_id、vehicle_list_name（DB 直接欄位）、vehicle_category（5=黑名單）、allow_result（1=放行 0=未放行）
 * lane_type（1 進 2 出）由 vehiclebiz.lane_info 依 lane_id 查詢帶入
 * organization_id 由 DB 直接欄位透傳（右側群組名稱改由 vehicle_list.person_group_id + platform.person_group 取得，此處不查）
 * 時間：timeRange=today 或 startTime/endTime；未指定時預設今天
 */
class PassagewayLogDataHandler extends BaseExternalDataService {
  constructor() {
    super("vehiclebiz", "passageway_log_data", {
      defaultOrderBy: "trigger_time",
      defaultOrderDirection: "DESC",
      defaultLimit: 50,
      maxLimit: 1000,
    });
  }

  getSearchableColumns() {
    return [
      "lane_name",
      "license_plate",
      "plate_capital",
      "owner_name",
      "vehicle_list_name",
      "passageway_name",
    ];
  }

  applyDefaultFilters(filters) {
    applyDefaultTimeFilters(filters, "trigger_time_start", "trigger_time_end");
  }

  /**
   * 覆寫：支援 lane_id 為多筆（逗號分隔或陣列）時使用 IN 條件
   * 地點設定後依選定的車道 ID 篩選 passageway_log_data
   */
  buildWhereClause(filters, params = []) {
    const filtersCopy = { ...filters };
    const rawLaneId = filtersCopy.lane_id;
    delete filtersCopy.lane_id;

    const baseWhere = super.buildWhereClause(filtersCopy, params);

    if (rawLaneId === undefined || rawLaneId === null || rawLaneId === "") {
      return baseWhere;
    }

    const ids = Array.isArray(rawLaneId)
      ? rawLaneId.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n))
      : String(rawLaneId)
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
    const laneCondition = `lane_id IN (${placeholders})`;
    return baseWhere
      ? `${baseWhere} AND ${laneCondition}`
      : `WHERE ${laneCondition}`;
  }

  /**
   * 將 PostgreSQL 陣列字串 "{1,5}" 轉為數字陣列 [1, 5]
   */
  parseVehicleCategory(raw) {
    if (raw == null) return null;
    if (Array.isArray(raw))
      return raw.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));
    if (typeof raw === "number") return raw;
    if (typeof raw !== "string") return null;
    const s = raw.trim();
    if (!s || s === "{}") return [];
    const match = s.match(/^\{(.*)\}$/);
    if (!match) return null;
    return match[1]
      .split(",")
      .map((part) => parseInt(part.trim(), 10))
      .filter((n) => !isNaN(n));
  }

  /** 單筆轉 API 輸出：plate_license_image_url、vehicle_list、vehicle_category/is_blacklist、allow_result、lane_type、organization_id */
  mapItemToOutput(item) {
    const vehicleListId =
      item.vehicle_list_id != null ? item.vehicle_list_id : -1;
    const vehicleListName = item.vehicle_list_name ?? "";
    const rawCategory =
      item.vehicle_category ?? item.vehicle_categroy ?? item.vehicle_type;
    const parsed = this.parseVehicleCategory(rawCategory);
    let vehicleCategory = rawCategory != null ? rawCategory : 0;
    if (parsed !== null) {
      vehicleCategory = Array.isArray(parsed)
        ? parsed.length === 1
          ? parsed[0]
          : parsed
        : parsed;
    }
    const isBlacklist = Array.isArray(vehicleCategory)
      ? vehicleCategory.includes(5)
      : vehicleCategory === 5;
    const orgId =
      item.organization_id != null && item.organization_id !== ""
        ? Number(item.organization_id)
        : null;
    return {
      ...item,
      plate_license_image_url: item.license_plate_image_url ?? null,
      vehicle_list_id: vehicleListId,
      vehicle_list_name: vehicleListName,
      vehicle_category: vehicleCategory,
      is_blacklist: isBlacklist,
      allow_result: item.allow_result ?? null,
      lane_type: item.lane_type ?? null,
      organization_id: orgId,
    };
  }

  /** 依 lane_id 查 lane_info 取得 lane_type（1 進 2 出） */
  async getLaneTypeMap(laneIds) {
    const ids = [...new Set(laneIds)].filter(
      (id) => id != null && id !== "" && !Number.isNaN(Number(id))
    );
    if (ids.length === 0) return {};
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
    const rows = await externalDb.query(
      `SELECT id, lane_type FROM vehiclebiz.lane_info WHERE id IN (${placeholders})`,
      ids
    );
    const map = {};
    for (const row of rows) {
      map[row.id] = row.lane_type != null ? row.lane_type : null;
    }
    return map;
  }

  async getList(filters = {}) {
    this.applyDefaultFilters(filters);
    const result = await super.getList(filters);
    if (!result.success || !result.data) return result;
    if (result.data.length === 0) return result;
    const laneIds = result.data.map((item) => item.lane_id).filter((id) => id != null);
    const laneTypeMap = await this.getLaneTypeMap(laneIds);
    result.data = result.data.map((item) =>
      this.mapItemToOutput({
        ...item,
        lane_type: item.lane_id != null ? laneTypeMap[item.lane_id] ?? null : null,
      })
    );
    return result;
  }

  async getById(id) {
    const result = await super.getById(id);
    if (result.success && result.data) {
      const item = result.data;
      const laneTypeMap =
        item.lane_id != null ? await this.getLaneTypeMap([item.lane_id]) : {};
      result.data = this.mapItemToOutput({
        ...item,
        lane_type: item.lane_id != null ? laneTypeMap[item.lane_id] ?? null : null,
      });
    }
    return result;
  }

  /** 覆寫：篩選含 lane_type 時 JOIN lane_info 計數（進/出場僅計 allow_result=1） */
  async getCount(filters = {}) {
    this.applyDefaultFilters(filters);
    const laneTypeVal = filters.lane_type;
    const hasLaneType = laneTypeVal != null && String(laneTypeVal).trim() !== "";
    if (!hasLaneType) return await super.getCount(filters);
    const filtersCopy = { ...filters };
    delete filtersCopy.lane_type;
    const params = [];
    const { whereClause, searchClause } = this.buildWhereAndSearchClause(
      filtersCopy,
      params
    );
    const p = "p";
    const li = "li";
    const colRegex = /\b(trigger_time|lane_id|allow_result|lane_name|license_plate|plate_capital|owner_name|vehicle_list_name|passageway_name)\b/g;
    const qualify = (clause) => (clause ? clause.replace(colRegex, `${p}.$1`) : "");
    const wherePart = qualify(whereClause) || "WHERE 1=1";
    const searchQualified = qualify(searchClause);
    const searchPart = searchQualified
      ? " AND " + searchQualified.replace(/^(WHERE|AND)\s+/i, "").trim()
      : "";
    params.push(laneTypeVal);
    const sql = `
      SELECT COUNT(*) as count
      FROM ${this.tableName} ${p}
      JOIN vehiclebiz.lane_info ${li} ON ${p}.lane_id = ${li}.id
      ${wherePart}${searchPart} AND ${li}.lane_type = $${params.length}
    `;
    try {
      const rows = await externalDb.query(sql, params);
      return {
        success: true,
        data: {
          count: parseInt(rows[0].count, 10),
        },
      };
    } catch (error) {
      throw new Error(
        `查詢 ${this.tableName} 總數（依 lane_type）失敗: ${error.message}`
      );
    }
  }
}

module.exports = PassagewayLogDataHandler;
