const express = require("express");
const router = express.Router();
const pdaScanService = require("../services/pda/pdaScanService");
const isupListenService = require("../services/pda/isupListenService");
const garmentCheckService = require("../services/pda/garmentCheckService");
const pdaAgentService = require("../services/pda/pdaAgentService");
const asyncHandler = require("../utils/asyncHandler");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrors");
const logger = require("../utils/logger").createLogger("PDA Scan API");

const resolveAgentDeviceCode = (req) => {
  const requested = String(req.body?.deviceCode || req.query.deviceCode || "").trim();
  const agents = pdaAgentService.listOnline();
  return requested || (agents.length === 1 ? agents[0].deviceCode : "");
};

const requireOnlineAgent = (deviceCode) => {
  if (!deviceCode || !pdaAgentService.isOnline(deviceCode)) {
    throwApiError(
      C.SERVICE_UNAVAILABLE,
      deviceCode ? `PDA App 未連線：${deviceCode}` : "沒有已連線的 PDA App",
    );
  }
};

router.get("/status", (req, res) => {
  const agents = pdaAgentService.listOnline();
  res.sendSuccess({
    ...isupListenService.getStatus(),
    agentOnline: agents.length > 0,
    agents,
  });
});

router.post(
  "/scan",
  asyncHandler(async (req, res) => {
    const deviceCode = req.body?.deviceCode || req.query.deviceCode;
    const result = await garmentCheckService.ingestAndCheck({
      deviceCode,
      barcode: req.body?.barcode || req.query.barcode,
      scannedAt: req.body?.scannedAt || req.query.scannedAt,
      key: req.body?.key || req.query.key || req.headers["x-pda-key"],
    });

    // 查無／超洗：由平台比對後主動下發警報（非 PDA 本機自行長響）
    if (
      result?.result === garmentCheckService.RESULTS.UNKNOWN_GARMENT ||
      result?.result === garmentCheckService.RESULTS.OVERWASH
    ) {
      const code = String(deviceCode || "").trim();
      pdaAgentService
        .beep({
          deviceCode: code,
          durationMs: pdaAgentService.DEFAULT_ALARM_MS,
        })
        .then((ack) => {
          logger.info("掃碼不合格，平台已下發警報", {
            deviceCode: code,
            result: result.result,
            barcode: result.barcode,
            durationMs: ack?.durationMs,
          });
        })
        .catch((error) => {
          logger.warn("掃碼不合格，平台下發警報失敗", {
            deviceCode: code,
            result: result.result,
            barcode: result.barcode,
            error: error?.message || String(error),
          });
        });
    }

    res.sendSuccess(result);
  }),
);

router.post(
  "/beep",
  asyncHandler(async (req, res) => {
    const deviceCode = resolveAgentDeviceCode(req);
    requireOnlineAgent(deviceCode);
    try {
      const durationRaw =
        req.body?.durationMs != null ? req.body.durationMs : req.query.durationMs;
      const result = await pdaAgentService.beep({
        deviceCode,
        durationMs:
          durationRaw != null
            ? Number(durationRaw)
            : pdaAgentService.DEFAULT_ALARM_MS,
      });
      res.sendSuccess(result);
    } catch (error) {
      throwApiError(C.BAD_GATEWAY, error?.message || "PDA App 警報失敗");
    }
  }),
);

router.post(
  "/beep/stop",
  asyncHandler(async (req, res) => {
    const deviceCode = resolveAgentDeviceCode(req);
    requireOnlineAgent(deviceCode);
    try {
      const result = await pdaAgentService.stopBeep({ deviceCode });
      res.sendSuccess(result);
    } catch (error) {
      throwApiError(C.BAD_GATEWAY, error?.message || "PDA App 停止警報失敗");
    }
  }),
);

router.get(
  "/scans",
  asyncHandler(async (req, res) => {
    const rows = await pdaScanService.listRecentScans({
      deviceCode: req.query.deviceCode,
      limit: req.query.limit,
    });
    res.sendSuccess({ scans: rows, total: rows.length });
  }),
);

module.exports = router;
