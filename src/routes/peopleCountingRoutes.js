/**
 * 人流統計地點管理路由
 */

const express = require("express");
const router = express.Router();
const peopleCountingService = require("../services/peopleCounting/peopleCountingService");
const {
  authenticate,
  requirePermission,
  requireAdminOrOperator,
} = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { resolveTimeOptions } = require("../services/entryExit/resolveTimeOptions");
const {
  validateIntegers,
  validateNumbers,
} = require("../middleware/validation");

// 以下路由皆需登入
router.use(authenticate, requirePermission("system.people_counting"));

// ========== 地點管理路由 ==========

// 取得人流統計地點列表
router.get(
  "/locations",
  noCache,
  asyncHandler(async (req, res) => {
    const { zoneId } = req.query;
    const options = zoneId ? { zoneId: parseInt(zoneId) } : {};
    const result =
      await peopleCountingService.getPeopleCountingLocations(options);
    res.sendSuccess(result);
  }),
);

// 取得單一地點
router.get(
  "/locations/:id",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await peopleCountingService.getPeopleCountingLocationById(
      parseInt(id),
    );
    res.sendSuccess(result);
  }),
);

// 建立地點
router.post(
  "/locations",
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const result = await peopleCountingService.createPeopleCountingLocation(
      req.body,
      req.user.id,
    );
    res.sendSuccess(result, 201);
  }),
);

// 更新地點
router.put(
  "/locations/:id",
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await peopleCountingService.updatePeopleCountingLocation(
      parseInt(id),
      req.body,
      req.user.id,
    );
    res.sendSuccess(result);
  }),
);

// 刪除地點
router.delete(
  "/locations/:id",
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await peopleCountingService.deletePeopleCountingLocation(
      parseInt(id),
    );
    res.sendSuccess(result);
  }),
);

// ========== 業務邏輯 API ==========

/**
 * 取得所有工地列表（含統計）
 * GET /api/people-counting/sites
 */
router.get(
  "/sites",
  noCache,
  asyncHandler(async (req, res) => {
    const result = await peopleCountingService.getSites();
    res.sendSuccess(result);
  }),
);

/**
 * 取得單一工地詳情
 * GET /api/people-counting/sites/:id
 * 注意：前端主要使用統計數據，此路由返回地點詳情和統計
 */
router.get(
  "/sites/:id",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const siteId = parseInt(id);

    // 並行查詢地點和統計，提高性能
    const [locationResult, stats] = await Promise.all([
      peopleCountingService.getPeopleCountingLocationById(siteId),
      peopleCountingService.getSiteStats(siteId),
    ]);

    res.sendSuccess({
      ...locationResult,
      stats,
    });
  }),
);

/**
 * 取得工地統計
 * GET /api/people-counting/sites/:id/stats
 */
router.get(
  "/sites/:id/stats",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await peopleCountingService.getSiteStats(parseInt(id));
    res.sendSuccess(result);
  }),
);

/**
 * 取得工地進出場記錄（含資料關聯和事件類型判斷）
 * 固定最新 5 筆「事件」（enter/exit 展開後；與門禁／YSCP 主畫面一致）
 * GET /api/people-counting/sites/:id/logs/latest
 */
router.get(
  "/sites/:id/logs/latest",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await peopleCountingService.getSiteLogs(parseInt(id), {
      limit: 5,
      offset: 0,
    });
    res.sendSuccess(result);
  }),
);

/**
 * 取得工地進出場記錄（含資料關聯和事件類型判斷）
 * 注意：此端點支援分頁與時間區間，供「完整報表」等功能使用
 * GET /api/people-counting/sites/:id/logs?limit=50&offset=0&unitId=34&startTime=...&endTime=...
 * limit 語意為「事件數」（enter/exit 展開後）；startTime / endTime 為 ISO 字串，未傳則預設為今日範圍；offset 用於分頁
 */
router.get(
  "/sites/:id/logs",
  noCache,
  validateIntegers("id"),
  validateNumbers("limit", "offset", "unitId"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { limit, offset, unitId, startTime, endTime, timeRange } = req.query;
    const resolved = resolveTimeOptions({
      startTime,
      endTime,
      timeRange,
    });
    const options = {
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
      unitId: unitId ? parseInt(unitId, 10) : undefined,
      startTime: resolved.startTime,
      endTime: resolved.endTime,
    };
    const result = await peopleCountingService.getSiteLogs(
      parseInt(id),
      options,
    );
    res.sendSuccess(result);
  }),
);

/**
 * 取得單位人員列表（含狀態計算和今日統計）
 * GET /api/people-counting/units/:id/personnel?siteId=1
 */
router.get(
  "/units/:id/personnel",
  noCache,
  validateIntegers("id"),
  validateNumbers("siteId"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { siteId } = req.query;

    // 傳遞 siteId 給 service，讓 service 層處理設備 ID 取得邏輯
    const result = await peopleCountingService.getUnitPersonnel(
      parseInt(id),
      siteId ? parseInt(siteId) : null,
    );
    res.sendSuccess(result);
  }),
);

module.exports = router;
