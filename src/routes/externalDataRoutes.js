const express = require("express");
const router = express.Router();
const handlerFactory = require("../services/externalData/handlerFactory");
const systemMapping = require("../services/externalData/systemMapping");
const vehicleGroupAggregateService = require("../services/externalData/vehicleGroupAggregateService");
const {
  authenticate,
  requirePermission,
} = require("../middleware/authMiddleware");
const { requireFeature } = require("../middleware/licenseMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const {
  validateRequired,
  validateIntegers,
} = require("../middleware/validation");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrorMeta");
const {
  peopleCounting: yscpPeopleFeature,
  vehicleAccess: yscpVehicleFeature,
} = require("../utils/yscpSystemFeature");

/** 車輛進出系統使用的表：需授權 vehicle_access 才能存取 */
const VEHICLE_TABLES = [
  { schema: "platform", table: "vehicle_list" },
  { schema: "vehiclebiz", table: "passageway_log_data" },
  { schema: "vehiclebiz", table: "lane_info" },
  { schema: "anpr", table: "vehicle_custom_list" },
  { schema: "anpr", table: "vehicle_and_list_relation" },
];

function isVehicleTable(schema, table) {
  return VEHICLE_TABLES.some((t) => t.schema === schema && t.table === table);
}

// 白名單：允許存取的 schema 和 table
const ALLOWED_TABLES = [
  { schema: "platform", table: "person" },
  { schema: "platform", table: "person_group" },
  { schema: "platform", table: "person_head_pic" },
  { schema: "platform", table: "vehicle_list" },
  { schema: "baseacs", table: "slot_card_records" },
  { schema: "deviceaccess", table: "door" },
  { schema: "vehiclebiz", table: "passageway_log_data" },
  { schema: "vehiclebiz", table: "lane_info" },
  { schema: "anpr", table: "vehicle_custom_list" },
  { schema: "anpr", table: "vehicle_and_list_relation" },
];

/**
 * 驗證 schema 和 table 是否在白名單中
 */
function validateTableAccess(schema, table) {
  return ALLOWED_TABLES.some(
    (allowed) => allowed.schema === schema && allowed.table === table,
  );
}

/** 檢查表在白名單且處理器存在；車輛表授權由 requireVehicleAccessIfVehicleTable 處理 */
function validateTableAndHandler(req, res, next) {
  const { schema, table } = req.params;

  // 驗證存取權限
  if (!validateTableAccess(schema, table)) {
    return res.sendFailure(
      {
        code: C.EXTERNAL_DATA_TABLE_FORBIDDEN,
        message: `不允許存取 ${schema}.${table}。請確認該資料表是否在白名單中。`,
        details: { schema, table },
      },
      403,
    );
  }

  // 檢查處理器是否存在
  if (!handlerFactory.hasHandler(schema, table)) {
    return res.sendFailure(
      {
        code: C.EXTERNAL_DATA_HANDLER_NOT_FOUND,
        message: `找不到 ${schema}.${table} 的處理器。`,
        details: { schema, table },
      },
      404,
    );
  }

  next();
}

/** YSCP 資料源關閉時，略過對應外部表（不連 EXTERNAL_DB） */
const createYscpExternalDisabledResponder = (feature, message) => (req, res, next) => {
  const { schema, table, id } = req.params || {};
  if (!schema || !table) return next();
  if (!feature.isBlockedExternalTable(schema, table)) return next();

  if (id !== undefined && id !== null && String(id) !== "") {
    return res.sendFailure(
      { code: C.EXTERNAL_DATA_RECORD_NOT_FOUND, message },
      404,
    );
  }

  const path = String(req.path || "");
  if (path.endsWith("/count")) {
    return res.sendSuccess(feature.emptyExternalCountResult());
  }

  const limit = Math.min(parseInt(req.query?.limit, 10) || 50, 1000);
  const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);
  return res.sendSuccess(feature.emptyExternalListResult(limit, offset));
};

const respondIfPeopleCountingExternalDisabled = createYscpExternalDisabledResponder(
  yscpPeopleFeature,
  "YSCP 人流資料源已關閉，無法查詢外部資料",
);

const respondIfVehicleAccessExternalDisabled = createYscpExternalDisabledResponder(
  yscpVehicleFeature,
  "YSCP 車輛資料源已關閉，無法查詢外部資料",
);

const blockSlotCardRecordsIfDisabled = (req, res, next) => {
  if (!yscpPeopleFeature.isBlockedExternalTable("baseacs", "slot_card_records")) {
    return next();
  }
  return res.sendSuccess(null);
};

/** 車輛相關表需授權 vehicle_access */
function requireVehicleAccessIfVehicleTable(req, res, next) {
  const { schema, table } = req.params || {};
  if (!schema || !table) return next();
  if (!isVehicleTable(schema, table)) return next();
  return requireFeature("vehicle_access")(req, res, (err) => {
    if (err) return next(err);
    return requirePermission("system.vehicle_access")(req, res, next);
  });
}

/**
 * 取得所有可用的處理器列表（用於除錯或管理）
 * GET /api/external-data/handlers
 * 注意：固定路徑必須放在動態路徑之前
 */
router.get(
  "/handlers",
  authenticate,
  asyncHandler(async (req, res) => {
    const handlers = handlerFactory.getAllHandlers();
    res.sendSuccess(handlers);
  }),
);

/**
 * 取得所有系統及其資料表對應關係
 * GET /api/external-data/systems
 */
router.get(
  "/systems",
  authenticate,
  asyncHandler(async (req, res) => {
    const mapping = handlerFactory.getSystemTableMapping();
    const systems = Object.keys(mapping).map((systemType) => ({
      systemType,
      tables: mapping[systemType],
      tableCount: mapping[systemType].length,
    }));
    res.sendSuccess({ systems });
  }),
);

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
      throwApiError(
        C.EXTERNAL_DATA_SYSTEM_NOT_FOUND,
        `找不到系統 ${systemType}。可用的系統類型：${systemMapping.getAllSystemTypes().join(", ")}`,
        { statusCode: 404 },
      );
    }

    const tables = systemMapping.getTablesBySystem(systemType);
    const handlers = handlerFactory.getHandlersBySystem(systemType);

    res.sendSuccess({
      systemType,
      tables,
      handlers: handlers.map(({ schema, table }) => `${schema}.${table}`),
      tableCount: tables.length,
    });
  }),
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
  }),
);

/**
 * 車輛進出：取得車輛群組彙總（需授權 vehicle_access）
 * GET /api/external-data/vehicle-access/vehicle-groups
 */
router.get(
  "/vehicle-access/vehicle-groups",
  authenticate,
  requireFeature("vehicle_access"),
  requirePermission("system.vehicle_access"),
  asyncHandler(async (req, res) => {
    if (!yscpVehicleFeature.isEnabled()) {
      return res.sendSuccess(yscpVehicleFeature.emptyVehicleGroups());
    }
    const result = await vehicleGroupAggregateService.getVehicleGroups();
    res.sendSuccess(result);
  }),
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
  respondIfPeopleCountingExternalDisabled,
  respondIfVehicleAccessExternalDisabled,
  requireVehicleAccessIfVehicleTable,
  asyncHandler(async (req, res) => {
    const { schema, table } = req.params;
    const handler = handlerFactory.getHandler(schema, table);
    const result = await handler.getCount(req.query);
    res.sendSuccess(result);
  }),
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
  respondIfPeopleCountingExternalDisabled,
  respondIfVehicleAccessExternalDisabled,
  requireVehicleAccessIfVehicleTable,
  asyncHandler(async (req, res) => {
    const { schema, table, id } = req.params;
    const handler = handlerFactory.getHandler(schema, table);
    const result = await handler.getById(parseInt(id));

    if (!result.success) {
      throwApiError(
        C.EXTERNAL_DATA_RECORD_NOT_FOUND,
        result.message || "資料不存在",
        { statusCode: 404 },
      );
    }

    res.sendSuccess(result);
  }),
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
  blockSlotCardRecordsIfDisabled,
  asyncHandler(async (req, res) => {
    const handler = handlerFactory.getHandler("baseacs", "slot_card_records");
    const result = await handler.getPictureById(parseInt(req.params.id));

    if (!result.success) {
      throwApiError(
        C.EXTERNAL_DATA_PICTURE_FAILED,
        result.error || "獲取圖片失敗",
        {
          statusCode:
            Number.isFinite(result.status) && result.status >= 400
              ? result.status
              : 500,
        },
      );
    }

    res.sendSuccess(result.data);
  }),
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
  blockSlotCardRecordsIfDisabled,
  asyncHandler(async (req, res) => {
    const { picUris } = req.body;

    if (!Array.isArray(picUris) || picUris.length === 0) {
      throwApiError(C.EXTERNAL_DATA_INVALID_PIC_URIS, "picUris 必須為非空陣列");
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
  }),
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
  blockSlotCardRecordsIfDisabled,
  asyncHandler(async (req, res) => {
    const handler = handlerFactory.getHandler("baseacs", "slot_card_records");
    const result = await handler.getPictureByUri(req.body.picUri);

    if (!result.success) {
      throwApiError(
        C.EXTERNAL_DATA_PICTURE_FAILED,
        result.error || "獲取圖片失敗",
        {
          statusCode:
            Number.isFinite(result.status) && result.status >= 400
              ? result.status
              : 500,
        },
      );
    }

    res.sendSuccess(result.data);
  }),
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
  respondIfPeopleCountingExternalDisabled,
  respondIfVehicleAccessExternalDisabled,
  requireVehicleAccessIfVehicleTable,
  asyncHandler(async (req, res) => {
    const { schema, table } = req.params;
    const handler = handlerFactory.getHandler(schema, table);
    const result = await handler.getList(req.query);
    res.sendSuccess(result);
  }),
);

module.exports = router;
