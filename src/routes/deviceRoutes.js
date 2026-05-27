const express = require("express");
const router = express.Router();
const deviceService = require("../services/devices/deviceService");
const deviceTypeService = require("../services/devices/deviceTypeService");
const deviceModelService = require("../services/devices/deviceModelService");
const deviceStreamService = require("../services/devices/deviceStreamService");
const deviceConnectivityService = require("../services/devices/deviceConnectivityService");
const {
  authenticate,
  requireAdminOrOperator,
  requirePermission,
} = require("../middleware/authMiddleware");
const { requireFeature } = require("../middleware/licenseMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

// 以下路由皆需登入
router.use(authenticate);

// ========== 設備類型 API ==========
// 注意：必須放在 /:id 之前，避免路由衝突

// 取得所有設備類型
router.get(
  "/types",
  noCache,
  asyncHandler(async (req, res) => {
    const result = await deviceTypeService.getAllDeviceTypes();
    res.sendSuccess(result);
  }),
);

// 設備類型固定：只提供列表（GET /types）

// ========== 設備型號 API ==========
// 注意：必須放在 /:id 之前，避免路由衝突

// 取得設備型號列表（支援按類型篩選）
router.get(
  "/models",
  noCache,
  asyncHandler(async (req, res) => {
    const { type_code, category_code } = req.query;
    const result = await deviceModelService.getAllDeviceModels({
      type_code,
      category_code,
    });
    res.sendSuccess(result);
  }),
);

// 取得單一設備型號
router.get(
  "/models/:id",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await deviceModelService.getDeviceModelById(parseInt(id));
    res.sendSuccess(result);
  }),
);

// 建立設備型號（管理員或操作員）
router.post(
  "/models",
  requireAdminOrOperator,
  requirePermission("system.equipment_management"),
  asyncHandler(async (req, res) => {
    const result = await deviceModelService.createDeviceModel(
      req.body,
      req.user.id,
    );
    res.sendSuccess(result, 201);
  }),
);

// 更新設備型號（管理員或操作員）
router.put(
  "/models/:id",
  requireAdminOrOperator,
  requirePermission("system.equipment_management"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await deviceModelService.updateDeviceModel(
      parseInt(id),
      req.body,
      req.user.id,
    );
    res.sendSuccess(result);
  }),
);

// 刪除設備型號（管理員或操作員）
router.delete(
  "/models/:id",
  requireAdminOrOperator,
  requirePermission("system.equipment_management"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await deviceModelService.deleteDeviceModel(parseInt(id));
    res.sendSuccess(result);
  }),
);

// ========== 設備 API ==========

// 取得設備連線狀態快照（不落 DB；供設備管理頁 initial render）
// - 可用 type_code 篩選（回該類型全部設備的狀態）
// - 或用 device_ids=1,2,3 指定清單
router.get(
  "/connectivity",
  noCache,
  asyncHandler(async (req, res) => {
    const { type_code, device_ids, debug } = req.query;
    // 若指定 device_ids：即時檢測一次，避免一直 unknown（特別是剛重啟/剛進頁面）
    let debugResult = null;
    if (device_ids) {
      const ids = String(device_ids)
        .split(",")
        .map((x) => parseInt(String(x).trim(), 10))
        .filter((n) => Number.isFinite(n));
      if (ids.length > 0) {
        const shouldDebug = String(debug || "").trim() === "1";
        const r = await deviceConnectivityService.checkAndBroadcastConnectivityByDeviceIds(ids);
        debugResult = shouldDebug ? r : null;
      }
    }
    const result = await deviceConnectivityService.getConnectivitySnapshot({
      type_code,
      device_ids,
    });
    res.sendSuccess({
      ...result,
      ...(debugResult ? { debug: debugResult } : {}),
    });
  }),
);

// 取得設備列表（支援篩選）
router.get(
  "/",
  noCache,
  asyncHandler(async (req, res) => {
    const { type_code, status, group, limit, offset, orderBy, order } = req.query;
    const result = await deviceService.getDevices({
      type_code,
      status,
      group: group && String(group).trim() ? String(group).trim() : undefined,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
      orderBy,
      order,
    });
    res.sendSuccess(result);
  }),
);

// 取得攝影機群組列表（供篩選下拉，須在 /:id 之前）
router.get(
  "/groups",
  noCache,
  asyncHandler(async (req, res) => {
    const { type_code } = req.query;
    if (type_code !== "camera") {
      return res.sendSuccess({ groups: [] });
    }
    const groups = await deviceService.getCameraGroups();
    res.sendSuccess({ groups });
  }),
);

// ========== 攝影機串流 API（影像監控系統，需授權 surveillance）==========
router.post(
  "/:id/stream/start",
  noCache,
  requireFeature("surveillance"),
  requirePermission("system.video_surveillance"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    const result = await deviceStreamService.startStream(id);
    res.sendSuccess(result);
  }),
);

router.post(
  "/:id/stream/stop",
  noCache,
  requireFeature("surveillance"),
  requirePermission("system.video_surveillance"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    await deviceStreamService.stopStream(id);
    res.sendSuccess({ message: "串流已停止" });
  }),
);

router.get(
  "/:id/stream/status",
  noCache,
  requireFeature("surveillance"),
  requirePermission("system.video_surveillance"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    const result = await deviceStreamService.getStreamStatus(id);
    res.sendSuccess(result);
  }),
);

// 取得單一設備（必須放在最後，避免與 /types 和 /models 衝突）
router.get(
  "/:id",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await deviceService.getDeviceById(parseInt(id));
    res.sendSuccess(result);
  }),
);

// 創建設備（管理員或操作員）
router.post(
  "/",
  requireAdminOrOperator,
  requirePermission("system.equipment_management"),
  asyncHandler(async (req, res) => {
    const result = await deviceService.createDevice(req.body, req.user.id);
    res.sendSuccess(result, 201);
  }),
);

// 更新設備（管理員或操作員）
router.put(
  "/:id",
  requireAdminOrOperator,
  requirePermission("system.equipment_management"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await deviceService.updateDevice(
      parseInt(id),
      req.body,
      req.user.id,
    );
    res.sendSuccess(result);
  }),
);

// 刪除設備（管理員或操作員）
router.delete(
  "/:id",
  requireAdminOrOperator,
  requirePermission("system.equipment_management"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user?.id;
    const result = await deviceService.deleteDevice(parseInt(id), userId);
    res.sendSuccess(result);
  }),
);

module.exports = router;
