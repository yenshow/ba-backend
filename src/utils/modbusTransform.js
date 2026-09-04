/**
 * Modbus 點位轉換公式（與設備型號感測器 transform 同語意）
 * - 正規化：`/ 10` → `value / 10`；純數字 → `value - N`
 * - 讀：套用公式
 * - 舊 scale：無 transform 時視為 `value * scale`
 */

/**
 * @param {string|null|undefined} transform
 * @returns {string|null}
 */
function normalizeTransform(transform) {
  if (transform == null) return null;
  const t = String(transform).trim();
  if (!t) return null;
  if (/^[\+\-\*\/]/.test(t)) {
    return t.startsWith("-") ? `value - ${t.substring(1).trim()}` : `value ${t}`;
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    return `value - ${t}`;
  }
  return t.replace(/value/gi, "value");
}

/**
 * @param {object|null|undefined} def
 * @returns {string|null}
 */
function resolveFormulaFromDef(def) {
  if (!def || typeof def !== "object") return null;
  const fromTransform = normalizeTransform(def.transform);
  if (fromTransform) return fromTransform;
  const scale = def.scale != null ? Number(def.scale) : NaN;
  if (Number.isFinite(scale) && scale !== 0 && scale !== 1) {
    return `value * ${scale}`;
  }
  return null;
}

/**
 * @param {number} rawValue
 * @param {string|null|undefined} formula
 * @returns {number}
 */
function applyFormula(rawValue, formula) {
  const raw = Number(rawValue);
  if (!Number.isFinite(raw)) return rawValue;
  const normalized = normalizeTransform(formula);
  if (!normalized) return raw;
  try {
    const expr = normalized.replace(/value/g, String(raw));
    const result = new Function(`return (${expr})`)();
    const n = Number(result);
    return Number.isFinite(n) ? n : raw;
  } catch (_) {
    return raw;
  }
}

/**
 * @param {number} rawValue
 * @param {object|null|undefined} def
 * @returns {number}
 */
function applyDefTransform(rawValue, def) {
  return applyFormula(rawValue, resolveFormulaFromDef(def));
}

module.exports = {
  resolveFormulaFromDef,
  applyDefTransform,
};
