const express = require("express");
const router = express.Router();
const locationService = require("../services/location/locationService");
const {
  authenticate,
  requirePermission,
  requireLocationMutation,
  requireLocationTypeModuleAccess,
} = require("../middleware/authMiddleware");
const { disableHttpCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

// 以下路由皆需登入
router.use(authenticate);

// ========== 區域管理路由 ==========

// 取得區域列表（無 locationType＝全區點位圖彙整，需模組權限）
router.get(
  "/zones",
  (req, res, next) => {
    if (req.query.locationType) {
      return requireLocationTypeModuleAccess()(req, res, next);
    }
    return requirePermission("system.area_point_map")(req, res, next);
  },
  disableHttpCache,
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
  disableHttpCache,
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
  requireLocationMutation("create"),
  asyncHandler(async (req, res) => {
    const result = await locationService.createZone(req.body, req.user.id);
    res.sendSuccess(result, 201);
  }),
);

// 更新區域
router.put(
  "/zones/:id",
  requireLocationMutation("update"),
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
  requireLocationMutation("delete"),
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
  disableHttpCache,
  asyncHandler(async (_req, res) => {
    const result =
      await locationService.getPeopleCountingSyncableLocationsWithAccessControlDevices();
    res.sendSuccess(result);
  }),
);

router.get(
  "/vehicle-access/syncable-locations",
  disableHttpCache,
  asyncHandler(async (_req, res) => {
    const result =
      await locationService.getVehicleAccessSyncableLocationsWithIsapiCameras();
    res.sendSuccess(result);
  }),
);

// 取得單一地點（含所有系統）
router.get(
  "/:id",
  disableHttpCache,
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
  requireLocationMutation("create"),
  asyncHandler(async (req, res) => {
    const result = await locationService.createLocation(req.body, req.user.id);
    res.sendSuccess(result, 201);
  }),
);

// 更新地點
router.put(
  "/:id",
  requireLocationMutation("update"),
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
  requireLocationMutation("delete"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await locationService.deleteLocation(parseInt(id));
    res.sendSuccess(result);
  }),
);

module.exports = router;
