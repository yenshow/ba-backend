/**
 * 能源設定（單列 id=1）
 * Incident 門檻：表單 UX 在此；執行期 SSOT 為 alert_rules（PUT 時 upsert）
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const SETTINGS_ID = 1;

const STAGE_DEFAULT_PCT = { 1: 80, 2: 90, 3: 100 };

const DEFAULT_CONFIG = {
  contract_capacity_kw: 0,
  meter_stale_enabled: true,
  meter_stale_minutes: 15,
  reading_jump_enabled: true,
  reading_jump_multiplier: 3,
  reading_jump_min_kwh: 10,
  usage_vs_avg_enabled: true,
  usage_vs_avg_pct: 90,
  usage_vs_avg_days: 30,
  offpeak_low_enabled: true,
  offpeak_low_pct: 70,
  offpeak_baseline_days: 14,
  meter_share_enabled: true,
  meter_share_pct: 40,
  water_usage_vs_avg_enabled: true,
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

function clampPct(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.round(n)));
}

function clampPositiveInt(value, fallback, min = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.round(n));
}

function boolDefault(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  return value !== false;
}

function normalizeStage(raw, level, fallbackPct, fallbackEnabled) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    level,
    enabled: boolDefault(src.enabled, fallbackEnabled),
    threshold_pct: clampPct(
      src.threshold_pct,
      STAGE_DEFAULT_PCT[level] ?? fallbackPct,
    ),
    actions: Array.isArray(src.actions) ? src.actions : [],
  };
}

/** 固定補齊 1～3 級（與 energy alert_rules catalog 對齊） */
function normalizeLoadShedStagesToThree(stages) {
  const byLevel = new Map();
  for (const s of Array.isArray(stages) ? stages : []) {
    const level = parseInt(s?.level, 10);
    if (level >= 1 && level <= 3 && !byLevel.has(level)) {
      byLevel.set(
        level,
        normalizeStage(s, level, STAGE_DEFAULT_PCT[level], true),
      );
    }
  }
  return [1, 2, 3].map((level) =>
    byLevel.has(level)
      ? byLevel.get(level)
      : normalizeStage(null, level, STAGE_DEFAULT_PCT[level], true),
  );
}

/**
 * 寫入／正規化分級；無陣列時由舊 demand_warning_*／demand_alert_* 遷移
 */
function normalizeLoadShedStages(src) {
  if (Array.isArray(src.load_shed_stages)) {
    return normalizeLoadShedStagesToThree(src.load_shed_stages);
  }

  const warnEnabled = boolDefault(src.demand_warning_enabled, true);
  const alertEnabled = boolDefault(src.demand_alert_enabled, true);
  const warnPct = clampPct(src.demand_warning_pct, 90);
  const migrated = [];
  if (warnEnabled) {
    migrated.push(normalizeStage(null, 1, warnPct, true));
  }
  if (alertEnabled) {
    const level = warnEnabled ? 3 : 1;
    migrated.push(normalizeStage(null, level, 100, true));
  }
  return normalizeLoadShedStagesToThree(migrated);
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const include = Array.isArray(src.include_device_ids)
    ? src.include_device_ids
        .map((id) => parseInt(id, 10))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const et =
    src.electricity_tariff && typeof src.electricity_tariff === "object"
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
    meter_stale_enabled: boolDefault(src.meter_stale_enabled),
    meter_stale_minutes: clampPositiveInt(src.meter_stale_minutes, 15),
    reading_jump_enabled: boolDefault(src.reading_jump_enabled),
    reading_jump_multiplier: Number.isFinite(Number(src.reading_jump_multiplier))
      ? Math.max(1.5, Number(src.reading_jump_multiplier))
      : 3,
    reading_jump_min_kwh: Number.isFinite(Number(src.reading_jump_min_kwh))
      ? Math.max(0, Number(src.reading_jump_min_kwh))
      : 10,
    usage_vs_avg_enabled: boolDefault(src.usage_vs_avg_enabled),
    usage_vs_avg_pct: clampPct(src.usage_vs_avg_pct, 90),
    usage_vs_avg_days: clampPositiveInt(src.usage_vs_avg_days, 30, 7),
    offpeak_low_enabled: boolDefault(src.offpeak_low_enabled),
    offpeak_low_pct: clampPct(src.offpeak_low_pct, 70),
    offpeak_baseline_days: clampPositiveInt(src.offpeak_baseline_days, 14, 7),
    meter_share_enabled: boolDefault(src.meter_share_enabled),
    meter_share_pct: clampPct(src.meter_share_pct, 40),
    water_usage_vs_avg_enabled: boolDefault(src.water_usage_vs_avg_enabled),
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
    load_shed_stages: normalizeLoadShedStages(src),
  };
}

function parseConditionConfig(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? raw : {};
}

/**
 * GET：Incident 門檻以 alert_rules 為準覆寫回應（表單／dashboard UX）
 */
async function mergeIncidentThresholdsFromAlertRules(config) {
  const alertRuleService = require("../alerts/alertRuleService");
  const rules = await alertRuleService.getAllRulesForSource("energy", false);
  if (!rules.length) {
    return {
      ...config,
      load_shed_stages: normalizeLoadShedStagesToThree(config.load_shed_stages),
    };
  }

  const byDim = new Map(rules.map((r) => [String(r.dimension_key || ""), r]));

  const stages = [1, 2, 3].map((level) => {
    const rule = byDim.get(`contract_stage_${level}`);
    if (!rule) {
      return normalizeStage(null, level, STAGE_DEFAULT_PCT[level], false);
    }
    const cfg = parseConditionConfig(rule.condition_config);
    return normalizeStage(
      {
        enabled: rule.enabled !== false,
        threshold_pct: cfg.threshold_pct,
      },
      level,
      STAGE_DEFAULT_PCT[level],
      rule.enabled !== false,
    );
  });

  const stale = byDim.get("meter_stale");
  const jump = byDim.get("reading_jump");
  const staleCfg = parseConditionConfig(stale?.condition_config);
  const jumpCfg = parseConditionConfig(jump?.condition_config);

  return {
    ...config,
    load_shed_stages: stages,
    meter_stale_enabled: stale
      ? stale.enabled !== false
      : config.meter_stale_enabled,
    meter_stale_minutes: stale
      ? clampPositiveInt(staleCfg.stale_minutes, config.meter_stale_minutes || 15)
      : config.meter_stale_minutes,
    reading_jump_enabled: jump
      ? jump.enabled !== false
      : config.reading_jump_enabled,
    reading_jump_multiplier: jump
      ? Number.isFinite(Number(jumpCfg.multiplier))
        ? Math.max(1.5, Number(jumpCfg.multiplier))
        : config.reading_jump_multiplier
      : config.reading_jump_multiplier,
    reading_jump_min_kwh: jump
      ? Number.isFinite(Number(jumpCfg.min_kwh))
        ? Math.max(0, Number(jumpCfg.min_kwh))
        : config.reading_jump_min_kwh
      : config.reading_jump_min_kwh,
  };
}

/**
 * PUT：將表單 Incident 門檻 upsert 到 alert_rules（執行期 SSOT）
 */
async function upsertEnergyIncidentAlertRules(config) {
  const alertRuleService = require("../alerts/alertRuleService");
  const {
    listEnergyAlertRules,
  } = require("../../constants/energyAlertRuleCatalog");
  const catalog = listEnergyAlertRules();
  const existing = await alertRuleService.getAllRulesForSource("energy", false);
  const byDim = new Map(
    (existing || []).map((r) => [String(r.dimension_key || ""), r]),
  );
  const stageByLevel = new Map(
    (config.load_shed_stages || []).map((s) => [Number(s.level), s]),
  );

  // config 已由 normalizeConfig 正規化；此處只映射至 alert_rules
  for (const template of catalog) {
    let enabled = template.enabled !== false;
    let conditionConfig = { ...(template.condition_config || {}) };

    if (template.condition_type === "energy_contract_stage") {
      const level = Number(template.condition_config?.level);
      const stage = stageByLevel.get(level);
      enabled = stage ? stage.enabled !== false : false;
      conditionConfig = {
        level,
        threshold_pct:
          stage?.threshold_pct ?? STAGE_DEFAULT_PCT[level] ?? 80,
      };
    } else if (template.condition_type === "energy_meter_stale") {
      enabled = config.meter_stale_enabled !== false;
      conditionConfig = { stale_minutes: config.meter_stale_minutes };
    } else if (template.condition_type === "energy_reading_jump") {
      enabled = config.reading_jump_enabled !== false;
      conditionConfig = {
        multiplier: config.reading_jump_multiplier,
        min_kwh: config.reading_jump_min_kwh,
      };
    }

    const existingRule = byDim.get(template.dimension_key);
    if (existingRule) {
      await alertRuleService.updateAlertRule(existingRule.id, {
        enabled,
        condition_type: template.condition_type,
        condition_config: conditionConfig,
      });
    } else {
      await alertRuleService.createAlertRule({
        source: template.source,
        alert_type: template.alert_type,
        severity: template.severity,
        name: template.name,
        dimension_key: template.dimension_key,
        condition_type: template.condition_type,
        condition_config: conditionConfig,
        message_template_key: template.message_template_key,
        enabled,
      });
    }
  }
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
    const base = normalizeConfig(DEFAULT_CONFIG);
    return {
      id: SETTINGS_ID,
      config: await mergeIncidentThresholdsFromAlertRules(base),
      updatedAt: null,
    };
  }
  const row = rows[0];
  const config =
    typeof row.config === "string" ? JSON.parse(row.config || "{}") : row.config;
  return {
    id: row.id,
    config: await mergeIncidentThresholdsFromAlertRules(normalizeConfig(config)),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function updateSettings(payload) {
  if (!payload || typeof payload !== "object") {
    throwApiError(C.VALIDATION_CUSTOM, "settings payload 無效");
  }
  const current = await getSettings();
  const prevIds = current.config.include_device_ids || [];
  const next = normalizeConfig({ ...current.config, ...payload });
  const nextIds = next.include_device_ids || [];
  const removedIds = prevIds.filter((id) => !nextIds.includes(id));
  const rows = await db.query(
    `INSERT INTO energy_settings (id, config)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = CURRENT_TIMESTAMP
     RETURNING id, config, updated_at`,
    [SETTINGS_ID, JSON.stringify(next)],
  );
  const row = rows[0];

  await upsertEnergyIncidentAlertRules(next);

  if (removedIds.length > 0) {
    const energyAlertEvaluator = require("./energyAlertEvaluator");
    await energyAlertEvaluator.disableAllDeviceEnergyAlerts(removedIds);
  }

  return {
    id: row.id,
    config: await mergeIncidentThresholdsFromAlertRules(next),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

module.exports = {
  SETTINGS_ID,
  getSettings,
  updateSettings,
};
