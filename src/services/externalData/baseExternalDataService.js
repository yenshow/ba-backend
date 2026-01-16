const externalDb = require("../../database/externalDb");

/**
 * 通用外部資料服務基類
 * 提供基本的查詢、分頁、篩選功能
 */
class BaseExternalDataService {
  constructor(schema, table, options = {}) {
    this.schema = schema;
    this.table = table;
    this.tableName = `${schema}.${table}`;
    this.options = {
      // 預設允許的欄位（如果未指定，則允許所有欄位）
      allowedColumns: options.allowedColumns || null,
      // 預設的排序欄位
      defaultOrderBy: options.defaultOrderBy || "id",
      // 預設的排序方向
      defaultOrderDirection: options.defaultOrderDirection || "ASC",
      // 預設的分頁大小
      defaultLimit: options.defaultLimit || 50,
      // 最大分頁大小
      maxLimit: options.maxLimit || 1000,
    };
  }

  /**
   * 驗證欄位是否允許查詢
   */
  validateColumns(columns) {
    if (!this.options.allowedColumns) {
      return columns; // 允許所有欄位
    }
    return columns.filter((col) => this.options.allowedColumns.includes(col));
  }

  /**
   * 建立 WHERE 條件
   */
  buildWhereClause(filters, params = []) {
    const conditions = [];
    let paramIndex = params.length + 1;

    for (const [key, value] of Object.entries(filters)) {
      // 跳過分頁、排序和特殊參數
      if (
        [
          "limit",
          "offset",
          "orderBy",
          "orderDirection",
          "columns",
          "search",
          "timeRange",
          "startTime",
          "endTime",
        ].includes(key)
      ) {
        continue;
      }

      // 處理時間範圍查詢（格式：fieldName_start, fieldName_end）
      if (key.endsWith("_start") || key.endsWith("_end")) {
        const fieldName = key.replace(/_start$|_end$/, "");
        const operator = key.endsWith("_start") ? ">=" : "<=";
        if (value !== undefined && value !== null && value !== "") {
          conditions.push(`${fieldName} ${operator} $${paramIndex}`);
          params.push(value);
          paramIndex++;
        }
        continue;
      }

      if (value !== undefined && value !== null && value !== "") {
        conditions.push(`${key} = $${paramIndex}`);
        params.push(value);
        paramIndex++;
      }
    }

    return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  }

  /**
   * 建立搜尋條件（針對文字欄位）
   */
  buildSearchClause(searchTerm, searchColumns, params = []) {
    if (!searchTerm || !searchColumns || searchColumns.length === 0) {
      return "";
    }

    let paramIndex = params.length + 1;
    const searchConditions = searchColumns.map((col) => {
      const condition = `${col}::text ILIKE $${paramIndex}`;
      paramIndex++;
      return condition;
    });
    // 為每個搜尋欄位加入相同的搜尋詞
    searchColumns.forEach(() => {
      params.push(`%${searchTerm}%`);
    });

    return `(${searchConditions.join(" OR ")})`;
  }

  /**
   * 建立完整的 WHERE 和搜尋條件
   */
  buildWhereAndSearchClause(filters, params = []) {
    const whereClause = this.buildWhereClause(filters, params);

    // 處理搜尋
    let searchClause = "";
    if (filters.search) {
      const searchColumns = this.getSearchableColumns();
      if (searchColumns.length > 0) {
        searchClause = this.buildSearchClause(filters.search, searchColumns, params);
        if (searchClause) {
          const whereKeyword = whereClause ? "AND" : "WHERE";
          searchClause = `${whereKeyword} ${searchClause}`;
        }
      }
    }

    return { whereClause, searchClause };
  }

  /**
   * 取得資料列表
   */
  async getList(filters = {}) {
    const {
      limit = this.options.defaultLimit,
      offset = 0,
      orderBy = this.options.defaultOrderBy,
      orderDirection = this.options.defaultOrderDirection,
      columns,
    } = filters;

    // 驗證和處理欄位
    let selectColumns = "*";
    if (columns) {
      const columnList = columns.split(",").map((c) => c.trim());
      const validColumns = this.validateColumns(columnList);
      if (validColumns.length > 0) {
        selectColumns = validColumns.join(", ");
      }
    }

    // 建立查詢參數和條件
    const params = [];
    const { whereClause, searchClause } = this.buildWhereAndSearchClause(filters, params);

    // 驗證排序欄位
    const validOrderBy = this.validateOrderBy(orderBy);
    const validOrderDirection = orderDirection.toUpperCase() === "DESC" ? "DESC" : "ASC";

    // 驗證分頁參數
    const validLimit = Math.min(parseInt(limit) || this.options.defaultLimit, this.options.maxLimit);
    const validOffset = Math.max(parseInt(offset) || 0, 0);

    // 建立 SQL 查詢
    const sql = `
      SELECT ${selectColumns}
      FROM ${this.tableName}
      ${whereClause}
      ${searchClause}
      ORDER BY ${validOrderBy} ${validOrderDirection}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    params.push(validLimit, validOffset);

    try {
      const rows = await externalDb.query(sql, params);
      return {
        success: true,
        data: rows,
        pagination: {
          limit: validLimit,
          offset: validOffset,
          count: rows.length,
        },
      };
    } catch (error) {
      throw new Error(`查詢 ${this.tableName} 失敗: ${error.message}`);
    }
  }

  /**
   * 取得單筆資料
   */
  async getById(id) {
    const sql = `SELECT * FROM ${this.tableName} WHERE id = $1`;
    try {
      const rows = await externalDb.query(sql, [id]);
      if (rows.length === 0) {
        return {
          success: false,
          message: `找不到 ID 為 ${id} 的資料`,
        };
      }
      return {
        success: true,
        data: rows[0],
      };
    } catch (error) {
      throw new Error(`查詢 ${this.tableName} 失敗: ${error.message}`);
    }
  }

  /**
   * 取得資料總數
   */
  async getCount(filters = {}) {
    const params = [];
    const { whereClause, searchClause } = this.buildWhereAndSearchClause(filters, params);

    const sql = `
      SELECT COUNT(*) as count
      FROM ${this.tableName}
      ${whereClause}
      ${searchClause}
    `;

    try {
      const rows = await externalDb.query(sql, params);
      return {
        success: true,
        data: {
          count: parseInt(rows[0].count),
        },
      };
    } catch (error) {
      throw new Error(`查詢 ${this.tableName} 總數失敗: ${error.message}`);
    }
  }

  /**
   * 取得可搜尋的欄位（子類別可覆寫）
   */
  getSearchableColumns() {
    return [];
  }

  /**
   * 驗證排序欄位（子類別可覆寫）
   */
  validateOrderBy(orderBy) {
    return orderBy || this.options.defaultOrderBy;
  }
}

module.exports = BaseExternalDataService;

