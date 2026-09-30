/**
 * 門禁設備同步狀態 SSOT（寫入 DB／sync-candidates 顯示）。
 * 持久化僅允許 pending | success | failed；API 可額外回 no_data（無憑證）。
 * 舊值 synced／unchanged 一律視為 success。
 */

const PERSISTED = Object.freeze({
  PENDING: "pending",
  SUCCESS: "success",
  FAILED: "failed",
});

const API = Object.freeze({
  ...PERSISTED,
  NO_DATA: "no_data",
});

const SUCCESS_ALIASES = new Set(["success", "synced", "unchanged"]);

/**
 * @param {unknown} raw
 * @returns {"pending"|"success"|"failed"|null}
 */
function normalizePersistedStatus(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s || s === "null" || s === "undefined") return null;
  if (SUCCESS_ALIASES.has(s)) return PERSISTED.SUCCESS;
  if (s === PERSISTED.FAILED) return PERSISTED.FAILED;
  if (s === PERSISTED.PENDING) return PERSISTED.PENDING;
  return PERSISTED.PENDING;
}

/**
 * @param {unknown} raw
 * @returns {"pending"|"success"|"failed"|"no_data"}
 */
function normalizeApiStepStatus(raw) {
  if (raw == null) return API.NO_DATA;
  const s = String(raw).trim().toLowerCase();
  if (s === API.NO_DATA || s === "") return API.NO_DATA;
  return normalizePersistedStatus(s) || PERSISTED.PENDING;
}

module.exports = {
  PERSISTED,
  API,
  SUCCESS_ALIASES,
  normalizePersistedStatus,
  normalizeApiStepStatus,
};
