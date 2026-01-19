/**
 * 人流統計地點管理路由
 */

const express = require("express");
const router = express.Router();
const peopleCountingService = require("../services/systems/peopleCountingService");
const { authenticate } = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

// ========== 地點管理路由 ==========

// 取得人流統計地點列表
router.get("/locations", noCache, asyncHandler(async (req, res) => {
  const { zoneId } = req.query;
  const options = zoneId ? { zoneId: parseInt(zoneId) } : {};
  const result = await peopleCountingService.getPeopleCountingLocations(options);
  res.sendSuccess(result);
}));

// 取得單一地點
router.get("/locations/:id", noCache, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await peopleCountingService.getPeopleCountingLocationById(parseInt(id));
  res.sendSuccess(result);
}));

// 建立地點（需要認證）
router.post("/locations", authenticate, asyncHandler(async (req, res) => {
  const result = await peopleCountingService.createPeopleCountingLocation(
    req.body,
    req.user.id
  );
  res.sendSuccess(result, 201);
}));

// 更新地點（需要認證）
router.put("/locations/:id", authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await peopleCountingService.updatePeopleCountingLocation(
    parseInt(id),
    req.body,
    req.user.id
  );
  res.sendSuccess(result);
}));

// 刪除地點（需要認證）
router.delete("/locations/:id", authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await peopleCountingService.deletePeopleCountingLocation(parseInt(id));
  res.sendSuccess(result);
}));

// ========== 業務邏輯 API ==========

/**
 * 取得所有工地列表（含統計）
 * GET /api/people-counting/sites
 */
router.get("/sites", noCache, authenticate, asyncHandler(async (req, res) => {
  const result = await peopleCountingService.getSites();
  res.sendSuccess(result);
}));

/**
 * 取得單一工地詳情
 * GET /api/people-counting/sites/:id
 */
router.get("/sites/:id", noCache, authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const locationResult = await peopleCountingService.getPeopleCountingLocationById(parseInt(id));
  const stats = await peopleCountingService.getSiteStats(parseInt(id));
  res.sendSuccess({
    ...locationResult,
    stats,
  });
}));

/**
 * 取得工地統計
 * GET /api/people-counting/sites/:id/stats
 */
router.get("/sites/:id/stats", noCache, authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await peopleCountingService.getSiteStats(parseInt(id));
  res.sendSuccess(result);
}));

/**
 * 取得工地進出場記錄（含資料關聯和事件類型判斷）
 * GET /api/people-counting/sites/:id/logs?limit=50&unitId=34
 */
router.get("/sites/:id/logs", noCache, authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { limit, unitId } = req.query;
  const options = {
    limit: limit ? parseInt(limit) : 50,
    unitId: unitId ? parseInt(unitId) : undefined,
  };
  const result = await peopleCountingService.getSiteLogs(parseInt(id), options);
  res.sendSuccess(result);
}));

/**
 * 取得單位人員列表（含狀態計算）
 * GET /api/people-counting/units/:id/personnel
 */
router.get("/units/:id/personnel", noCache, authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await peopleCountingService.getUnitPersonnel(parseInt(id));
  res.sendSuccess(result);
}));

module.exports = router;

