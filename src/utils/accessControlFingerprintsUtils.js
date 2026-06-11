/**
 * 人員門禁指紋（config.access_control.fingerprints）解析與驗證
 */
const C = require("./apiErrorCodes");
const { throwApiError } = require("./apiErrorMeta");

const MAX_FINGERPRINTS = 5;

const normalizeFingerprintEntry = (entry) => {
  if (entry == null) return null;
  if (typeof entry === "string") {
    const fingerData = entry.trim();
    if (!fingerData) return null;
    return { fingerData, source: "manual" };
  }
  if (typeof entry !== "object") return null;
  const fingerData =
    entry.fingerData != null
      ? String(entry.fingerData).trim()
      : entry.finger_data != null
        ? String(entry.finger_data).trim()
        : "";
  if (!fingerData) return null;
  const sourceRaw = entry.source != null ? String(entry.source).trim() : "";
  const source = sourceRaw === "captured" ? "captured" : "manual";
  return { fingerData, source };
};

/** 從 access_control 解析指紋列表 */
const resolveAccessControlFingerprints = (ac) => {
  if (!ac || typeof ac !== "object") return [];
  const list = Array.isArray(ac.fingerprints) ? ac.fingerprints : [];
  const out = [];
  for (const entry of list) {
    const fingerData =
      entry?.fingerData != null
        ? String(entry.fingerData).trim()
        : entry?.finger_data != null
          ? String(entry.finger_data).trim()
          : "";
    if (!fingerData) continue;
    out.push({
      fingerData,
      source: entry?.source === "captured" ? "captured" : "manual",
    });
  }
  return out;
};

const toStorageFingerprint = (entry, fingerPrintID) => ({
  fingerPrintID,
  fingerType: "normalFP",
  fingerData: entry.fingerData,
  enableCardReader: [1],
  ...(entry.source === "captured" ? { source: "captured" } : {}),
});

/**
 * 正規化並驗證寫入用的指紋陣列
 * @param {Array|undefined} rawFingerprints
 * @returns {Array<{ fingerData: string, source: string }>}
 */
const normalizeAndValidateFingerprintsInput = (rawFingerprints) => {
  const items = Array.isArray(rawFingerprints)
    ? rawFingerprints.map(normalizeFingerprintEntry).filter(Boolean)
    : [];
  if (items.length > MAX_FINGERPRINTS) {
    throwApiError(
      C.PERSONNEL_VALIDATION_FAILED,
      `指紋最多 ${MAX_FINGERPRINTS} 筆`,
    );
  }
  return items;
};

const applyFingerprintsToAccessControl = (accessControl, fingerprints) => {
  const ac = accessControl || {};
  if (!fingerprints || fingerprints.length === 0) {
    delete ac.fingerprints;
    return ac;
  }
  ac.fingerprints = fingerprints.map((entry, idx) =>
    toStorageFingerprint(entry, idx + 1),
  );
  return ac;
};

module.exports = {
  MAX_FINGERPRINTS,
  resolveAccessControlFingerprints,
  normalizeAndValidateFingerprintsInput,
  applyFingerprintsToAccessControl,
  toStorageFingerprint,
};
