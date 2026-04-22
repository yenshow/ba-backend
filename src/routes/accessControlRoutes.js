/**
 * 門禁設備 ISAPI 代理 API
 * 需認證，依設備 ID 轉發至對應門禁設備。
 */
const express = require("express");
const multer = require("multer");
const accessControlService = require("../services/accessControl/accessControlService");
const {
  authenticate,
  requireAdminOrOperator,
} = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

const router = express.Router();

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("僅允許 JPEG、PNG 人臉圖片"), false);
    }
  },
});

/**
 * 取得門禁設備上的人員列表
 * POST /api/access-control/devices/:deviceId/user-info
 * Body: { searchResultPosition?, maxResults? }
 */
router.post(
  "/devices/:deviceId/user-info",
  authenticate,
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId);
    const result = await accessControlService.searchUserInfo(
      deviceId,
      req.body || {},
    );
    res.sendSuccess(result);
  }),
);

/**
 * 修改單一人員資料
 * PUT /api/access-control/devices/:deviceId/user-info
 * Body: { UserInfo } 或直接傳 UserInfo 欄位
 */
router.put(
  "/devices/:deviceId/user-info",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId);
    const userInfo = req.body.UserInfo || req.body;
    if (!userInfo || !userInfo.employeeNo) {
      const err = new Error("請提供 UserInfo，且包含 employeeNo");
      err.statusCode = 400;
      throw err;
    }
    await accessControlService.updateUserInfo(deviceId, userInfo);
    res.sendSuccess({ success: true });
  }),
);

/**
 * 刪除單一或多筆人員（依員工編號）
 * DELETE /api/access-control/devices/:deviceId/user-info
 * Body: { employeeNo } 或 { employeeNoList: string[] }
 */
router.delete(
  "/devices/:deviceId/user-info",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId);
    const payload = req.body || {};
    await accessControlService.deleteUserInfo(deviceId, payload);
    res.sendSuccess({ success: true });
  }),
);

/**
 * 上傳單一人臉圖片（修改人臉配對）
 * PUT /api/access-control/devices/:deviceId/user-info/:employeeNo/face
 * multipart: img = 檔案；可選 body 或 form field: faceLibType, FDID, faceType
 */
router.put(
  "/devices/:deviceId/user-info/:employeeNo/face",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("deviceId"),
  uploadMemory.single("img"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId);
    const employeeNo = req.params.employeeNo;
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "請上傳人臉圖片（欄位名：img）" });
    }
    const options = {};
    if (req.body?.faceLibType) options.faceLibType = req.body.faceLibType;
    if (req.body?.FDID) options.FDID = req.body.FDID;
    if (req.body?.faceType) options.faceType = req.body.faceType;
    await accessControlService.updateFace(
      deviceId,
      employeeNo,
      req.file.buffer,
      options,
    );
    res.sendSuccess({ success: true });
  }),
);

/**
 * 呼叫設備截圖（捕獲人臉資料）
 * POST /api/access-control/devices/:deviceId/capture-face
 * Body（可選）: { dataType?, captureInfrared?, readerID? } 覆寫型號預設
 */
router.post(
  "/devices/:deviceId/capture-face",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId);
    const data = await accessControlService.captureFaceData(
      deviceId,
      req.body || {},
    );
    res.sendSuccess(data);
  }),
);

module.exports = router;
