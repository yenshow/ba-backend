/**
 * 車輛進出地點設定（operation_mode、session epoch）
 */
const OPERATION_MODES = ["construction_flow", "parking"];

function normalizeOperationMode(value) {
  return value === "parking" ? "parking" : "construction_flow";
}

/** @returns {number|null} 停車場在場上限（1–99999） */
function normalizeParkingCapacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(Math.trunc(n), 99999);
}

/**
 * @param {object} raw - DB snake_case 或 API camelCase
 */
function parseVehicleAccessConfigFields(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const operationMode = normalizeOperationMode(
    c.operation_mode ?? c.operationMode,
  );
  const statsEpochStartedAt =
    c.stats_epoch_started_at ?? c.statsEpochStartedAt ?? null;
  const statsResetAt = c.stats_reset_at ?? c.statsResetAt ?? null;
  const parkingCapacity = normalizeParkingCapacity(
    c.parking_capacity ?? c.parkingCapacity,
  );
  return {
    operationMode,
    statsEpochStartedAt:
      statsEpochStartedAt != null ? String(statsEpochStartedAt) : null,
    statsResetAt: statsResetAt != null ? String(statsResetAt) : null,
    parkingCapacity,
  };
}

/**
 * Session／主畫面 logs 起算：max(stats_reset_at, stats_epoch_started_at)
 * @param {{ operationMode: string, statsEpochStartedAt?: string|null, statsResetAt?: string|null }} cfg
 * @param {string|Date|null} [locationCreatedAt]
 * @returns {string|null} ISO8601
 */
function getEffectiveSince(cfg, locationCreatedAt) {
  const resetMs = cfg.statsResetAt
    ? new Date(cfg.statsResetAt).getTime()
    : 0;
  let epochMs = cfg.statsEpochStartedAt
    ? new Date(cfg.statsEpochStartedAt).getTime()
    : 0;
  if (
    cfg.operationMode === "parking" &&
    !Number.isFinite(epochMs) &&
    locationCreatedAt
  ) {
    epochMs = new Date(locationCreatedAt).getTime();
  }
  const sinceMs = Math.max(
    Number.isFinite(resetMs) ? resetMs : 0,
    Number.isFinite(epochMs) ? epochMs : 0,
  );
  if (!sinceMs) return null;
  return new Date(sinceMs).toISOString();
}

/**
 * 儲存前合併 epoch（首次設為 parking 寫入 stats_epoch_started_at）
 * @param {object} systemConfig - snake_case（將寫入 DB）
 * @param {object|null} previousConfig - 既有 DB config
 */
function applyVehicleAccessEpochOnSave(systemConfig, previousConfig = null) {
  const prev = parseVehicleAccessConfigFields(previousConfig || {});
  const mode = normalizeOperationMode(systemConfig.operation_mode);
  const next = { ...systemConfig, operation_mode: mode };

  if (prev.statsEpochStartedAt) {
    next.stats_epoch_started_at = prev.statsEpochStartedAt;
  }
  if (prev.statsResetAt) {
    next.stats_reset_at = prev.statsResetAt;
  }

  if (mode === "parking" && !next.stats_epoch_started_at) {
    next.stats_epoch_started_at = new Date().toISOString();
  }

  if (mode !== "parking") {
    delete next.parking_capacity;
  } else {
    const cap = normalizeParkingCapacity(
      next.parking_capacity ?? prev.parkingCapacity,
    );
    if (cap != null) next.parking_capacity = cap;
  }

  return next;
}

function isEventAfterEffectiveSince(eventTimeIso, effectiveSinceIso) {
  if (!effectiveSinceIso) return true;
  const eventMs = new Date(eventTimeIso).getTime();
  const sinceMs = new Date(effectiveSinceIso).getTime();
  if (!Number.isFinite(eventMs) || !Number.isFinite(sinceMs)) return true;
  return eventMs > sinceMs;
}

module.exports = {
  OPERATION_MODES,
  normalizeOperationMode,
  normalizeParkingCapacity,
  parseVehicleAccessConfigFields,
  getEffectiveSince,
  applyVehicleAccessEpochOnSave,
  isEventAfterEffectiveSince,
};
