/**
 * 能源設定（單列 id=1）
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const SETTINGS_ID = 1;

const DEFAULT_CONFIG = {
  contract_capacity_kw: 0,
  demand_window_minutes: 15,
  demand_alert_enabled: true,
  include_device_ids: [],
  electricity_tariff: {
    currency: "TWD",
    peak: { rate: 0, windows: [] },
    semi_peak: { rate: 0, windows: [] },
    off_peak: { rate: 0, windows: [] },
  },
  water_tariff: { rate: 0 },
  load_shed_stages: [],
};

function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const include = Array.isArray(src.include_device_ids)
    ? src.include_device_ids
        .map((id) => parseInt(id, 10))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const et = src.electricity_tariff && typeof src.electricity_tariff === "object"
    ? src.electricity_tariff
    : {};
  const band = (key) => {
    const b = et[key] && typeof et[key] === "object" ? et[key] : {};
    return {
      rate: Number.isFinite(Number(b.rate)) ? Number(b.rate) : 0,
      windows: Array.isArray(b.windows) ? b.windows : [],
    };
  };
  return {
    contract_capacity_kw: Number.isFinite(Number(src.contract_capacity_kw))
      ? Number(src.contract_capacity_kw)
      : 0,
    demand_window_minutes: Number.isFinite(Number(src.demand_window_minutes))
      ? Math.max(1, Number(src.demand_window_minutes))
      : 15,
    demand_alert_enabled: src.demand_alert_enabled !== false,
    include_device_ids: include,
    electricity_tariff: {
      currency: et.currency || "TWD",
      peak: band("peak"),
      semi_peak: band("semi_peak"),
      off_peak: band("off_peak"),
    },
    water_tariff: {
      rate: Number.isFinite(Number(src.water_tariff?.rate))
        ? Number(src.water_tariff.rate)
        : 0,
    },
    load_shed_stages: Array.isArray(src.load_shed_stages)
      ? src.load_shed_stages
      : [],
  };
}

async function getSettings() {
  const rows = await db.query(
    `SELECT id, config, updated_at FROM energy_settings WHERE id = $1`,
    [SETTINGS_ID],
  );
  if (!rows?.length) {
    await db.query(
      `INSERT INTO energy_settings (id, config) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [SETTINGS_ID, JSON.stringify(DEFAULT_CONFIG)],
    );
    return { id: SETTINGS_ID, config: normalizeConfig(DEFAULT_CONFIG), updatedAt: null };
  }
  const row = rows[0];
  const config =
    typeof row.config === "string" ? JSON.parse(row.config || "{}") : row.config;
  return {
    id: row.id,
    config: normalizeConfig(config),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function updateSettings(payload) {
  if (!payload || typeof payload !== "object") {
    throwApiError(C.VALIDATION_CUSTOM, "settings payload 無效");
  }
  const current = await getSettings();
  const next = normalizeConfig({ ...current.config, ...payload });
  const rows = await db.query(
    `INSERT INTO energy_settings (id, config)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = CURRENT_TIMESTAMP
     RETURNING id, config, updated_at`,
    [SETTINGS_ID, JSON.stringify(next)],
  );
  const row = rows[0];
  return {
    id: row.id,
    config: normalizeConfig(row.config),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

module.exports = {
  SETTINGS_ID,
  getSettings,
  updateSettings,
};
