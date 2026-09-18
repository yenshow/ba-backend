const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");
const logger = require("../../utils/logger").createLogger("PDA Scan");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const MAX_BARCODE_LENGTH = 4096;
const MAX_DEVICE_CODE_LENGTH = 64;

const toText = (value) => {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  return text.length === 0 ? null : text;
};

const ingestScan = async ({ deviceCode, barcode, scannedAt } = {}) => {
  const code = toText(deviceCode);
  const value = toText(barcode);
  if (!code) {
    throwApiError(C.VALIDATION_REQUIRED, "缺少 deviceCode");
  }
  if (!value) {
    throwApiError(C.VALIDATION_REQUIRED, "缺少 barcode");
  }
  if (code.length > MAX_DEVICE_CODE_LENGTH) {
    throwApiError(C.BAD_REQUEST, "deviceCode 過長");
  }
  if (value.length > MAX_BARCODE_LENGTH) {
    throwApiError(C.BAD_REQUEST, "barcode 過長");
  }

  const at = scannedAt ? new Date(scannedAt) : new Date();
  const rows = await db.query(
    `INSERT INTO pda_scan_events (device_code, barcode, scanned_at)
     VALUES (?, ?, ?)
     RETURNING id, device_code, barcode, scanned_at, created_at`,
    [code, value, Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString()],
  );

  const saved = rows[0];
  try {
    websocketService.emitPdaScan(saved);
  } catch (error) {
    logger.warn("PDA 掃碼 WebSocket 推送失敗", {
      id: saved.id,
      error: error?.message || String(error),
    });
  }
  return saved;
};

const listRecentScans = async ({ deviceCode, limit = 20 } = {}) => {
  const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const code = toText(deviceCode);
  const where = code ? "WHERE device_code = ?" : "";
  const params = code ? [code, take] : [take];
  return db.query(
    `SELECT id, device_code, barcode, scanned_at, created_at
     FROM pda_scan_events
     ${where}
     ORDER BY scanned_at DESC, id DESC
     LIMIT ?`,
    params,
  );
};

module.exports = {
  ingestScan,
  listRecentScans,
};
