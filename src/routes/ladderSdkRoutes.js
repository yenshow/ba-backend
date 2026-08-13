/**
 * 梯控 HCNetSDK API
 */
const express = require("express");
const sdkCardService = require("../services/ladderSdk/sdkCardService");
const sdkControlService = require("../services/ladderSdk/sdkControlService");
const sdkArmingService = require("../services/ladderSdk/sdkArmingService");
const sdkEventService = require("../services/ladderSdk/sdkEventService");
const {
  authenticate,
  requirePermission,
  requireAnyPermission,
} = require("../middleware/authMiddleware");
const { requireFeature } = require("../middleware/licenseMiddleware");
const permissionService = require("../access/permissionService");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrors");

const router = express.Router();
router.use(authenticate);

/**
 * GET /api/ladder-sdk/devices/:deviceId/cards
 */
router.get(
  "/devices/:deviceId/cards",
  requirePermission("system.equipment_management"),
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId, 10);
    const result = await sdkCardService.listCards(deviceId);
    res.sendSuccess(result);
  }),
);

/**
 * GET /api/ladder-sdk/devices/:deviceId/cards/:cardNo
 */
router.get(
  "/devices/:deviceId/cards/:cardNo",
  requirePermission("system.equipment_management"),
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId, 10);
    const result = await sdkCardService.getCard(deviceId, req.params.cardNo);
    res.sendSuccess(result);
  }),
);

/**
 * POST /api/ladder-sdk/devices/:deviceId/cards
 */
router.post(
  "/devices/:deviceId/cards",
  requirePermission("system.equipment_management.device.update"),
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId, 10);
    if (!req.body?.cardNo) {
      throwApiError(C.VALIDATION_CUSTOM, "請提供 cardNo");
    }
    if (!Array.isArray(req.body?.floors) || req.body.floors.length === 0) {
      throwApiError(C.VALIDATION_CUSTOM, "請提供 floors 授權樓層陣列");
    }
    const result = await sdkCardService.createCard(deviceId, req.body);
    res.sendSuccess(result);
  }),
);

/**
 * PUT /api/ladder-sdk/devices/:deviceId/cards/:cardNo
 */
router.put(
  "/devices/:deviceId/cards/:cardNo",
  requirePermission("system.equipment_management.device.update"),
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId, 10);
    if (!Array.isArray(req.body?.floors) || req.body.floors.length === 0) {
      throwApiError(C.VALIDATION_CUSTOM, "請提供 floors 授權樓層陣列");
    }
    const result = await sdkCardService.updateCard(
      deviceId,
      req.params.cardNo,
      req.body,
    );
    res.sendSuccess(result);
  }),
);

/**
 * DELETE /api/ladder-sdk/devices/:deviceId/cards/:cardNo
 */
router.delete(
  "/devices/:deviceId/cards/:cardNo",
  requirePermission("system.equipment_management.device.update"),
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId, 10);
    const result = await sdkCardService.deleteCard(deviceId, req.params.cardNo);
    res.sendSuccess(result);
  }),
);

/**
 * POST /api/ladder-sdk/devices/:deviceId/control
 * Body: { gatewayIndex?, gatewayIndexes?, command, locationId?, targetLogicalIndex? }
 */
router.post(
  "/devices/:deviceId/control",
  requireFeature("elevator"),
  requireAnyPermission([
    "system.equipment_management.device.update",
    "system.elevator.device.control",
  ]),
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId, 10);
    if (!req.body?.command) {
      throwApiError(C.LADDER_SDK_INVALID_COMMAND, "請提供 command");
    }
    const codes = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    const allowAnyLadderDevice =
      req.user?.role === "admin" ||
      permissionService.hasPermissionCode(
        codes,
        "system.equipment_management.device.update",
      );
    const result = await sdkControlService.controlGatewayForElevatorRequest(
      deviceId,
      req.body,
      { allowAnyLadderDevice },
    );
    res.sendSuccess(result);
  }),
);

/**
 * GET /api/ladder-sdk/events
 * Query: deviceId?, cardNo?, startTime?, endTime?, limit?, offset?
 */
router.get(
  "/events",
  requirePermission("system.equipment_management"),
  asyncHandler(async (req, res) => {
    const result = await sdkEventService.listEvents({
      deviceId: req.query.deviceId,
      cardNo: req.query.cardNo,
      startTime: req.query.startTime,
      endTime: req.query.endTime,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.sendSuccess(result);
  }),
);

/**
 * GET /api/ladder-sdk/events/latest
 * Query: deviceId?, limit? (default 20)
 */
router.get(
  "/events/latest",
  requirePermission("system.equipment_management"),
  asyncHandler(async (req, res) => {
    const result = await sdkEventService.getLatestEvents({
      deviceId: req.query.deviceId,
      limit: req.query.limit,
    });
    res.sendSuccess(result);
  }),
);

/**
 * GET /api/ladder-sdk/arming/status
 */
router.get(
  "/arming/status",
  requirePermission("system.equipment_management"),
  asyncHandler(async (req, res) => {
    res.sendSuccess(sdkArmingService.getStatus());
  }),
);

/**
 * POST /api/ladder-sdk/arming/refresh
 */
router.post(
  "/arming/refresh",
  requirePermission("system.equipment_management.device.update"),
  asyncHandler(async (req, res) => {
    const result = await sdkArmingService.refresh();
    res.sendSuccess(result);
  }),
);

module.exports = router;
