/**
 * 台電功率因數獎懲（參考用）：基準 80%、每 1 個百分點 ±0.1%、獎勵上限 95%
 */

const DEFAULT_POWER_FACTOR_ADJUSTMENT = {
  enabled: true,
  baseline_pct: 80,
  rate_per_point_pct: 0.1,
  reward_cap_pct: 95,
};

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function clampNum(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function boolDefault(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  return value !== false;
}

function normalizePowerFactorAdjustment(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_POWER_FACTOR_ADJUSTMENT;
  return {
    enabled: boolDefault(src.enabled, d.enabled),
    baseline_pct: clampNum(src.baseline_pct, d.baseline_pct, 1, 100),
    rate_per_point_pct: clampNum(src.rate_per_point_pct, d.rate_per_point_pct, 0, 10),
    reward_cap_pct: clampNum(src.reward_cap_pct, d.reward_cap_pct, 1, 100),
  };
}

/** 表計 0～1 比值或已是百分數 → 百分數；無效回 null */
function normalizePfToPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 1.5) return n * 100;
  return n;
}

/**
 * @returns {{ applied, measuredPct, effectivePct, baselinePct, rewardCapPct, billDeltaPct, adjustmentAmount, finalAmount }}
 * billDeltaPct 負值＝折扣
 */
function calcPowerFactorBillAdjustment(baseAmount, pfPercent, config) {
  const cfg = normalizePowerFactorAdjustment(config);
  const base = Number(baseAmount) || 0;
  const measured =
    pfPercent == null ? null : Number.isFinite(Number(pfPercent)) ? Number(pfPercent) : null;

  if (!cfg.enabled || measured == null) {
    return {
      enabled: cfg.enabled,
      applied: false,
      measuredPct: measured,
      effectivePct: measured,
      baselinePct: cfg.baseline_pct,
      rewardCapPct: cfg.reward_cap_pct,
      billDeltaPct: 0,
      adjustmentAmount: 0,
      finalAmount: round2(base),
    };
  }

  const pfEffective =
    measured >= cfg.baseline_pct
      ? Math.min(measured, cfg.reward_cap_pct)
      : measured;
  const billDeltaPct =
    Math.round((cfg.baseline_pct - pfEffective) * cfg.rate_per_point_pct * 1000) /
    1000;
  const finalAmount = round2(base * (1 + billDeltaPct / 100));
  return {
    enabled: cfg.enabled,
    applied: true,
    measuredPct: measured,
    effectivePct: pfEffective,
    baselinePct: cfg.baseline_pct,
    rewardCapPct: cfg.reward_cap_pct,
    billDeltaPct,
    adjustmentAmount: round2(finalAmount - base),
    finalAmount,
  };
}

module.exports = {
  normalizePowerFactorAdjustment,
  normalizePfToPercent,
  calcPowerFactorBillAdjustment,
};
