const express = require("express");
const router = express.Router();
const handlerFactory = require("../services/externalData/handlerFactory");
const systemMapping = require("../services/externalData/systemMapping");
const { authenticate } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { validateRequired, validateIntegers } = require("../middleware/validation");

// 白名單：允許存取的 schema 和 table
const ALLOWED_TABLES = [
  { schema: "platform", table: "person" },
  { schema: "platform", table: "person_group" },
  { schema: "baseacs", table: "slot_card_records" },
  { schema: "deviceaccess", table: "door" },
  // 未來可以繼續加入其他允許的資料表
];

/**
 * 驗證 schema 和 table 是否在白名單中
 */
function validateTableAccess(schema, table) {
  return ALLOWED_TABLES.some(
    (allowed) => allowed.schema === schema && allowed.table === table
  );
}

/**
 * 驗證中間件：檢查表存取權限和處理器是否存在
 */
function validateTableAndHandler(req, res, next) {
  const { schema, table } = req.params;

  // 驗證存取權限
  if (!validateTableAccess(schema, table)) {
    return res.status(403).json({
      success: false,
      message: `不允許存取 ${schema}.${table}。請確認該資料表是否在白名單中。`,
    });
  }

  // 檢查處理器是否存在
  if (!handlerFactory.hasHandler(schema, table)) {
    return res.status(404).json({
      success: false,
      message: `找不到 ${schema}.${table} 的處理器。`,
    });
  }

  next();
}

/**
 * 取得所有可用的處理器列表（用於除錯或管理）
 * GET /api/external-data/handlers
 * 注意：固定路徑必須放在動態路徑之前
 */
router.get("/handlers", authenticate, asyncHandler(async (req, res) => {
  const handlers = handlerFactory.getAllHandlers();
  res.sendSuccess(handlers);
}));

/**
 * 取得所有系統及其資料表對應關係
 * GET /api/external-data/systems
 */
router.get("/systems", authenticate, asyncHandler(async (req, res) => {
  const mapping = handlerFactory.getSystemTableMapping();
  const systems = Object.keys(mapping).map((systemType) => ({
    systemType,
    tables: mapping[systemType],
    tableCount: mapping[systemType].length,
  }));
  res.sendSuccess({ systems });
}));

/**
 * 取得指定系統使用的資料表列表
 * GET /api/external-data/systems/:systemType/tables
 */
router.get(
  "/systems/:systemType/tables",
  authenticate,
  asyncHandler(async (req, res) => {
    const { systemType } = req.params;
    
    if (!systemMapping.hasSystem(systemType)) {
      return res.sendError(`找不到系統 ${systemType}。可用的系統類型：${systemMapping.getAllSystemTypes().join(", ")}`, 404);
    }
    
    const tables = systemMapping.getTablesBySystem(systemType);
    const handlers = handlerFactory.getHandlersBySystem(systemType);
    
    res.sendSuccess({
      systemType,
      tables,
      handlers: handlers.map(({ schema, table }) => `${schema}.${table}`),
      tableCount: tables.length,
    });
  })
);

/**
 * 取得使用指定資料表的所有系統
 * GET /api/external-data/tables/:schema/:table/systems
 */
router.get(
  "/tables/:schema/:table/systems",
  authenticate,
  validateRequired("schema", "table"),
  asyncHandler(async (req, res) => {
    const { schema, table } = req.params;
    const systems = systemMapping.getSystemsByTable(schema, table);
    
    res.sendSuccess({
      schema,
      table,
      systems,
      systemCount: systems.length,
    });
  })
);

/**
 * 取得資料總數
 * GET /api/external-data/:schema/:table/count
 * 注意：必須放在 /:id 之前，避免路由衝突
 */
router.get(
  "/:schema/:table/count",
  authenticate,
  validateRequired("schema", "table"),
  validateTableAndHandler,
  asyncHandler(async (req, res) => {
    const { schema, table } = req.params;
    const handler = handlerFactory.getHandler(schema, table);
    const result = await handler.getCount(req.query);
    res.sendSuccess(result);
  })
);

/**
 * 取得單筆資料
 * GET /api/external-data/:schema/:table/:id
 */
router.get(
  "/:schema/:table/:id",
  authenticate,
  validateRequired("schema", "table"),
  validateIntegers("id"),
  validateTableAndHandler,
  asyncHandler(async (req, res) => {
    const { schema, table, id } = req.params;
    const handler = handlerFactory.getHandler(schema, table);
    const result = await handler.getById(parseInt(id));

    if (!result.success) {
      return res.sendError(result.message || "資料不存在", 404);
    }

    res.sendSuccess(result);
  })
);

/**
 * 取得刷卡記錄的快照圖片
 * GET /api/external-data/baseacs/slot_card_records/:id/picture
 * 注意：必須放在 /:schema/:table 之前，避免路由衝突
 */
router.get(
  "/baseacs/slot_card_records/:id/picture",
  authenticate,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const handler = handlerFactory.getHandler("baseacs", "slot_card_records");
    const result = await handler.getPictureById(parseInt(req.params.id));
    
    if (!result.success) {
      return res.sendError(result.error || "獲取圖片失敗", result.status || 500);
    }
    
    res.sendSuccess(result.data);
  })
);

/**
 * 批次獲取圖片
 * POST /api/external-data/baseacs/slot_card_records/pictures
 * 注意：必須放在 /picture 之前，避免路由衝突
 */
router.post(
  "/baseacs/slot_card_records/pictures",
  authenticate,
  validateRequired("picUris"),
  asyncHandler(async (req, res) => {
    const { picUris } = req.body;
    
    if (!Array.isArray(picUris) || picUris.length === 0) {
      return res.sendError("picUris 必須為非空陣列", 400);
    }

    const handler = handlerFactory.getHandler("baseacs", "slot_card_records");
    const results = await handler.getBatchPicturesByUri(picUris);
    const successCount = results.filter((r) => r.success).length;
    
    res.sendSuccess({
      results,
      total: picUris.length,
      success: successCount,
      failed: picUris.length - successCount,
    });
  })
);

/**
 * 根據 picUri 獲取圖片
 * POST /api/external-data/baseacs/slot_card_records/picture
 * 注意：必須放在 /:schema/:table 之前，避免路由衝突
 */
router.post(
  "/baseacs/slot_card_records/picture",
  authenticate,
  validateRequired("picUri"),
  asyncHandler(async (req, res) => {
    const handler = handlerFactory.getHandler("baseacs", "slot_card_records");
    const result = await handler.getPictureByUri(req.body.picUri);
    
    if (!result.success) {
      return res.sendError(result.error || "獲取圖片失敗", result.status || 500);
    }
    
    res.sendSuccess(result.data);
  })
);

/**
 * 取得資料列表
 * GET /api/external-data/:schema/:table
 * 注意：必須放在最後，避免與其他路由衝突
 */
router.get(
  "/:schema/:table",
  authenticate,
  validateRequired("schema", "table"),
  validateTableAndHandler,
  asyncHandler(async (req, res) => {
    const { schema, table } = req.params;
    const handler = handlerFactory.getHandler(schema, table);
    const result = await handler.getList(req.query);
    res.sendSuccess(result);
  })
);

module.exports = router;

