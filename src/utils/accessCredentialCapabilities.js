/**
 * 門禁設備型號憑證能力（人臉／卡／指紋）SSOT helper。
 * 缺省／未設定 → 全部支援（相容舊型號）。
 */
const db = require("../database/db");
const { parseConfig } = require("./deviceHelpers");

const DEFAULT_CAPS = Object.freeze({
  face: true,
  card: true,
  fingerprint: true,
});

/**
 * @param {unknown} input
 *   - 型號 config：`{ credentials: { face, card, fingerprint } }`
 *   - 或已解析能力：`{ face, card, fingerprint }`
 * @returns {{ face: boolean, card: boolean, fingerprint: boolean }}
 */
function resolveAccessCredentialCapabilities(input) {
  const cfg = input && typeof input === "object" ? input : null;
  if (!cfg) return { ...DEFAULT_CAPS };

  const nested =
    cfg.credentials && typeof cfg.credentials === "object"
      ? cfg.credentials
      : null;
  // 扁平能力（syncPersonToDevice options）或 nested credentials
  const raw =
    nested ||
    (cfg.face !== undefined ||
    cfg.card !== undefined ||
    cfg.fingerprint !== undefined
      ? cfg
      : null);
  if (!raw) return { ...DEFAULT_CAPS };

  return {
    face: raw.face !== false,
    card: raw.card !== false,
    fingerprint: raw.fingerprint !== false,
  };
}

/**
 * @param {Array<{ face?: boolean, card?: boolean, fingerprint?: boolean }>} capsList
 * @returns {{ face: boolean, card: boolean, fingerprint: boolean }}
 */
function unionAccessCredentialCapabilities(capsList) {
  const list = Array.isArray(capsList) ? capsList : [];
  if (list.length === 0) return { ...DEFAULT_CAPS };
  return {
    face: list.some((c) => c?.face !== false),
    card: list.some((c) => c?.card !== false),
    fingerprint: list.some((c) => c?.fingerprint !== false),
  };
}

/**
 * 批次查詢設備門禁憑證能力（id → capabilities）
 * @param {Array<number|string>} deviceIds
 * @returns {Promise<Map<number, { face: boolean, card: boolean, fingerprint: boolean }>>}
 */
async function getAccessCredentialCapabilitiesByDeviceIds(deviceIds) {
  const ids = [
    ...new Set(
      (deviceIds || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];
  const map = new Map();
  if (ids.length === 0) return map;

  const rows = await db.query(
    `SELECT d.id, dm.config AS model_config
     FROM devices d
     LEFT JOIN device_models dm ON d.model_id = dm.id
     WHERE d.id = ANY(?::int[])`,
    [ids.map((x) => Math.trunc(x))],
  );

  for (const r of rows || []) {
    const id = Number(r?.id);
    if (!Number.isFinite(id)) continue;
    let modelConfig = null;
    try {
      modelConfig = parseConfig(r?.model_config);
    } catch {
      modelConfig = null;
    }
    map.set(id, resolveAccessCredentialCapabilities(modelConfig));
  }

  for (const id of ids) {
    if (!map.has(id)) map.set(id, { ...DEFAULT_CAPS });
  }
  return map;
}

module.exports = {
  resolveAccessCredentialCapabilities,
  unionAccessCredentialCapabilities,
  getAccessCredentialCapabilitiesByDeviceIds,
};
