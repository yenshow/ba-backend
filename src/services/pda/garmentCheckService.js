/**
 * 無塵服掃碼檢核：主檔、PDA 入口綁定、廠別＋衣別洗次上限。
 * 未設定主檔／綁定時禁止假合格（not_configured / unbound_pda）。
 */
const db = require("../../database/db");
const logger = require("../../utils/logger").createLogger("Garment Check");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const pdaScanService = require("./pdaScanService");
const config = require("../../config");
const { timingSafeEqualUtf8 } = require("../../utils/timingSafeEqual");

const RESULTS = {
  PASS: "pass",
  UNKNOWN_GARMENT: "unknown_garment",
  OVERWASH: "overwash",
  UNBOUND_PDA: "unbound_pda",
  NOT_CONFIGURED: "not_configured",
};

const assertDeviceKey = (key) => {
  const expected = config.pda?.agentKey || "";
  if (!expected) {
    throwApiError(
      C.SERVICE_UNAVAILABLE,
      "尚未設定 PDA_AGENT_KEY，無法接受 APK 掃碼上傳",
    );
  }
  if (!timingSafeEqualUtf8(key, expected)) {
    throwApiError(C.AUTH_FAILED, "裝置金鑰錯誤");
  }
};

const parseBarcodeParts = (barcode) => {
  const text = String(barcode || "").trim().toUpperCase();
  if (text.length < 5) {
    return { plantCode: null, garmentType: null };
  }
  return {
    plantCode: text.slice(0, 2),
    garmentType: text.slice(-3),
  };
};

const countGarmentRows = async () => {
  const rows = await db.query(`SELECT COUNT(*)::int AS c FROM garment_master`);
  return rows[0]?.c || 0;
};

const findBinding = async (deviceCode) => {
  const rows = await db.query(
    `SELECT device_code, location_id, entrance_label
     FROM pda_entrance_bindings
     WHERE device_code = ?
     LIMIT 1`,
    [deviceCode],
  );
  return rows[0] || null;
};

const findGarment = async (barcode) => {
  const rows = await db.query(
    `SELECT barcode, employee_name, department, plant_code, garment_type,
            wash_count, last_wash_date
     FROM garment_master
     WHERE barcode = ?
     LIMIT 1`,
    [barcode],
  );
  return rows[0] || null;
};

const findWashLimit = async ({ locationId, plantCode, garmentType }) => {
  const rows = await db.query(
    `SELECT wash_limit
     FROM garment_wash_limits
     WHERE location_id = ? AND plant_code = ? AND garment_type = ?
     LIMIT 1`,
    [locationId, plantCode, garmentType],
  );
  return rows[0]?.wash_limit ?? null;
};

/**
 * APK 掃碼：驗 key → 入庫 → 檢核 → 回傳結果（禁止假合格）
 */
const ingestAndCheck = async ({ deviceCode, barcode, scannedAt, key } = {}) => {
  assertDeviceKey(key);

  const saved = await pdaScanService.ingestScan({
    deviceCode,
    barcode,
    scannedAt,
  });

  const garmentCount = await countGarmentRows();
  if (garmentCount === 0) {
    const payload = {
      result: RESULTS.NOT_CONFIGURED,
      message: "衣服主檔尚未匯入，無法判定合格",
      barcode: saved.barcode,
      employeeName: null,
      washCount: null,
      washLimit: null,
      entranceId: null,
      scanId: saved.id,
      scannedAt: saved.scanned_at,
    };
    logger.warn("掃碼檢核 not_configured", { deviceCode, barcode: saved.barcode });
    return payload;
  }

  const binding = await findBinding(deviceCode);
  if (!binding) {
    const payload = {
      result: RESULTS.UNBOUND_PDA,
      message: `PDA ${deviceCode} 尚未綁定入口`,
      barcode: saved.barcode,
      employeeName: null,
      washCount: null,
      washLimit: null,
      entranceId: null,
      scanId: saved.id,
      scannedAt: saved.scanned_at,
    };
    logger.warn("掃碼檢核 unbound_pda", { deviceCode, barcode: saved.barcode });
    return payload;
  }

  const garment = await findGarment(saved.barcode);
  if (!garment) {
    const payload = {
      result: RESULTS.UNKNOWN_GARMENT,
      message: "查無此衣",
      barcode: saved.barcode,
      employeeName: null,
      washCount: null,
      washLimit: null,
      entranceId: binding.location_id,
      scanId: saved.id,
      scannedAt: saved.scanned_at,
    };
    logger.warn("掃碼檢核 查無此衣 (unknown_garment)", {
      deviceCode,
      barcode: saved.barcode,
      locationId: binding.location_id,
    });
    return payload;
  }

  const plantCode = garment.plant_code || parseBarcodeParts(saved.barcode).plantCode;
  const garmentType =
    garment.garment_type || parseBarcodeParts(saved.barcode).garmentType;
  const washLimit = await findWashLimit({
    locationId: binding.location_id,
    plantCode,
    garmentType,
  });
  const washCount = Number(garment.wash_count) || 0;

  if (washLimit != null && washCount >= Number(washLimit)) {
    const payload = {
      result: RESULTS.OVERWASH,
      message: `超洗（洗次 ${washCount}／上限 ${washLimit}）`,
      barcode: saved.barcode,
      employeeName: garment.employee_name || null,
      washCount,
      washLimit: Number(washLimit),
      entranceId: binding.location_id,
      scanId: saved.id,
      scannedAt: saved.scanned_at,
    };
    logger.warn("掃碼檢核 超洗 (overwash)", {
      deviceCode,
      barcode: saved.barcode,
      washCount,
      washLimit,
    });
    return payload;
  }

  return {
    result: RESULTS.PASS,
    message: "衣服合格",
    barcode: saved.barcode,
    employeeName: garment.employee_name || null,
    washCount,
    washLimit: washLimit == null ? null : Number(washLimit),
    entranceId: binding.location_id,
    scanId: saved.id,
    scannedAt: saved.scanned_at,
  };
};

module.exports = {
  RESULTS,
  assertDeviceKey,
  ingestAndCheck,
};
