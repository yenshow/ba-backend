const express = require("express");
const router = express.Router();
const locationService = require("../services/systems/locationService");
const { authenticate, requirePermission } = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

// 以下路由皆需登入
router.use(authenticate);

// ========== 區域管理路由 ==========

// 取得區域列表
router.get(
  "/zones",
  noCache,
  asyncHandler(async (req, res) => {
    const { locationType } = req.query;
    const filters = locationType ? { locationType } : {};
    const result = await locationService.getZones(filters);
    res.sendSuccess(result);
  }),
);

// 取得單一區域
router.get(
  "/zones/:id",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { locationType } = req.query;
    const result = await locationService.getZoneById(
      parseInt(id),
      locationType || null,
    );
    res.sendSuccess(result);
  }),
);

// 建立區域
router.post(
  "/zones",
  requirePermission("system.area_point_map"),
  asyncHandler(async (req, res) => {
    const result = await locationService.createZone(req.body, req.user.id);
    res.sendSuccess(result, 201);
  }),
);

// 更新區域
router.put(
  "/zones/:id",
  requirePermission("system.area_point_map"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await locationService.updateZone(
      parseInt(id),
      req.body,
      req.user.id,
    );
    res.sendSuccess(result);
  }),
);

// 刪除區域
router.delete(
  "/zones/:id",
  requirePermission("system.area_point_map"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await locationService.deleteZone(parseInt(id));
    res.sendSuccess(result);
  }),
);

// ========== 地點管理路由 ==========

// people_counting（門禁來源）可同步地點 + 入口/出口門禁設備（含名稱）
router.get(
  "/people-counting/syncable-locations",
  noCache,
  asyncHandler(async (_req, res) => {
    const result =
      await locationService.getPeopleCountingSyncableLocationsWithAccessControlDevices();
    res.sendSuccess(result);
  }),
);

// 取得單一地點（含所有系統）
router.get(
  "/:id",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await locationService.getLocationById(parseInt(id));
    res.sendSuccess(result);
  }),
);

// 建立地點
router.post(
  "/",
  requirePermission("system.area_point_map"),
  asyncHandler(async (req, res) => {
    const result = await locationService.createLocation(req.body, req.user.id);
    res.sendSuccess(result, 201);
  }),
);

// 更新地點
router.put(
  "/:id",
  requirePermission("system.area_point_map"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await locationService.updateLocation(
      parseInt(id),
      req.body,
      req.user.id,
    );
    res.sendSuccess(result);
  }),
);

// 刪除地點
router.delete(
  "/:id",
  requirePermission("system.area_point_map"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await locationService.deleteLocation(parseInt(id));
    res.sendSuccess(result);
  }),
);

module.exports = router;
