/**
 * 能源儀表板告警通知（incident + insight 合併）
 */
const db = require("../../database/db");
const alertService = require("../alerts/alertService");
const energySettingsService = require("./energySettingsService");
const energyInsightEvaluator = require("./energyInsightEvaluator");
const energyAlertEvaluator = require("./energyAlertEvaluator");

const DEMO_DEVICE_IDS = [101, 102, 103];

function mapIncident(alert) {
  return {
    id: alert.id,
    kind: "incident",
    message: alert.message,
    severity: alert.severity,
    created_at: alert.created_at,
    updated_at: alert.updated_at,
    source: alert.source,
    source_id: alert.source_id,
    dimension_key: alert.dimension_key,
    alert_type: alert.alert_type,
    source_name: alert.source_name || alert.device_name || null,
  };
}

function sortByTimeDesc(a, b) {
  return (
    new Date(b.updated_at || b.created_at).getTime() -
    new Date(a.updated_at || a.created_at).getTime()
  );
}

async function getDeviceOfflineIncidents(deviceIds) {
  const ids = (deviceIds || [])
    .map((id) => parseInt(id, 10))
    .filter((n) => Number.isFinite(n));
  if (ids.length === 0) return [];

  const rows = await db.query(
    `
    SELECT a.id, a.source, a.source_id, a.alert_type, a.dimension_key,
           a.severity, a.message, a.status, a.created_at, a.updated_at,
           d.name AS device_name
    FROM alerts a
    INNER JOIN devices d ON d.id = a.source_id
    WHERE a.status = 'active'
      AND a.source = 'device'
      AND a.alert_type = 'offline'
      AND a.source_id = ANY($1::int[])
    ORDER BY a.updated_at DESC
    LIMIT 20
    `,
    [ids],
  );

  return (rows || []).map((row) =>
    mapIncident({
      ...row,
      source_name: row.device_name,
    }),
  );
}

/**
 * @param {{ limit?: number }} opts
 */
async function getDashboardNotifications(opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 8, 1), 50);
  const { config } = await energySettingsService.getSettings();
  const includeIds = config.include_device_ids || [];

  const [energyResult, deviceOffline, insights] = await Promise.all([
    alertService.getAlerts({
      source: alertService.ALERT_SOURCES.ENERGY,
      status: "active",
      limit: 30,
      orderBy: "updated_at",
      order: "desc",
    }),
    getDeviceOfflineIncidents(includeIds),
    energyInsightEvaluator.evaluateEnergyInsights(),
  ]);

  const energyIncidents = (energyResult?.alerts || []).map(mapIncident);

  const seenDeviceOffline = new Set();
  const mergedDeviceOffline = deviceOffline.filter((a) => {
    if (seenDeviceOffline.has(a.source_id)) return false;
    seenDeviceOffline.add(a.source_id);
    return !energyIncidents.some(
      (e) =>
        e.source_id === a.source_id &&
        e.dimension_key === energyAlertEvaluator.DIM_METER_STALE,
    );
  });

  const incidents = [...energyIncidents, ...mergedDeviceOffline].sort(
    sortByTimeDesc,
  );
  const insightItems = insights.map((i) => ({ ...i, severity: "insight" }));
  const combined = [...incidents, ...insightItems].sort(sortByTimeDesc);

  return {
    incidents,
    insights: insightItems,
    items: combined.slice(0, limit),
    totalIncidents: incidents.length,
    totalInsights: insightItems.length,
  };
}

function buildMockNotifications(limit = 50) {
  const now = Date.now();
  const ts = (hoursAgo) => new Date(now - hoursAgo * 3600 * 1000).toISOString();
  const incidents = [
    {
      id: 9000,
      kind: "incident",
      message: "契約 3 級：即時功率／需量 20150.0 kW 已達契約容量 20000.0 kW 的 100%",
      severity: "critical",
      created_at: ts(0.15),
      source: "energy",
      source_id: energySettingsService.SETTINGS_ID,
      dimension_key: energyAlertEvaluator.DIM_CONTRACT_STAGE_3,
      alert_type: "threshold",
    },
    {
      id: 9001,
      kind: "incident",
      message: "契約 2 級：即時功率／需量 18420.0 kW 已達契約容量 20000.0 kW 的 90%",
      severity: "error",
      created_at: ts(0.4),
      source: "energy",
      source_id: energySettingsService.SETTINGS_ID,
      dimension_key: energyAlertEvaluator.DIM_CONTRACT_STAGE_2,
      alert_type: "threshold",
    },
    {
      id: 9002,
      kind: "incident",
      message: "B1 電表－空調主機：通訊逾時，最近 15 分鐘無讀數",
      severity: "critical",
      created_at: ts(2),
      source: "energy",
      source_id: 101,
      dimension_key: energyAlertEvaluator.DIM_METER_STALE,
      alert_type: "offline",
    },
    {
      id: 9005,
      kind: "incident",
      message: "1F 電表－照明幹線：設備離線（Modbus 連線失敗）",
      severity: "critical",
      created_at: ts(3),
      source: "device",
      source_id: 102,
      dimension_key: "offline",
      alert_type: "offline",
      source_name: "1F 電表－照明幹線",
    },
    {
      id: 9004,
      kind: "incident",
      message: "電梯幹線電表：讀數跳動異常（單次 +128.5 kWh）",
      severity: "warning",
      created_at: ts(6),
      source: "energy",
      source_id: 103,
      dimension_key: energyAlertEvaluator.DIM_READING_JUMP,
      alert_type: "threshold",
    },
  ];
  const insights = [
    {
      id: "usage_vs_avg_energy",
      kind: "insight",
      message: "本日累計用電已達近 30 日平均值 92%",
      severity: "insight",
      created_at: ts(1),
    },
    {
      id: "usage_vs_avg_water",
      kind: "insight",
      message: "本日累計用水已達近 30 日平均值 88%",
      severity: "insight",
      created_at: ts(5.5),
    },
    {
      id: "meter_share_101",
      kind: "insight",
      message: "B1 電表－空調主機 今日用電佔總量 42.5%（超過 40% 門檻）",
      severity: "insight",
      created_at: ts(7),
    },
    {
      id: "offpeak_low",
      kind: "insight",
      message: "今日離峰用電 820.0 kWh 低於近 14 日離峰均值 70% 以下",
      severity: "insight",
      created_at: ts(8),
    },
  ];
  const combined = [...incidents, ...insights].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  return {
    incidents,
    insights,
    items: combined.slice(0, limit),
    totalIncidents: incidents.length,
    totalInsights: insights.length,
    mock: true,
  };
}

/**
 * 開發用：寫入示範 incident 至 alerts（可於警示紀錄驗證）
 */
async function seedDemoAlerts() {
  const { config } = await energySettingsService.getSettings();
  const meterDeviceId =
    (config.include_device_ids || [])[0] || DEMO_DEVICE_IDS[0];
  const jumpDeviceId =
    (config.include_device_ids || [])[1] || DEMO_DEVICE_IDS[2];

  await alertService.createAlert({
    source: alertService.ALERT_SOURCES.ENERGY,
    source_id: energySettingsService.SETTINGS_ID,
    alert_type: alertService.ALERT_TYPES.THRESHOLD,
    severity: alertService.SEVERITIES.CRITICAL,
    dimension_key: energyAlertEvaluator.DIM_CONTRACT_STAGE_3,
    message:
      "【示範】契約 3 級：即時功率／需量 20150.0 kW 已達契約容量 20000.0 kW 的 100%",
  });

  await alertService.createAlert({
    source: alertService.ALERT_SOURCES.ENERGY,
    source_id: energySettingsService.SETTINGS_ID,
    alert_type: alertService.ALERT_TYPES.THRESHOLD,
    severity: alertService.SEVERITIES.ERROR,
    dimension_key: energyAlertEvaluator.DIM_CONTRACT_STAGE_2,
    message:
      "【示範】契約 2 級：即時功率／需量 18420.0 kW 已達契約容量 20000.0 kW 的 90%",
  });

  await alertService.createAlert({
    source: alertService.ALERT_SOURCES.ENERGY,
    source_id: meterDeviceId,
    alert_type: alertService.ALERT_TYPES.OFFLINE,
    severity: alertService.SEVERITIES.CRITICAL,
    dimension_key: energyAlertEvaluator.DIM_METER_STALE,
    message: "【示範】B1 電表－空調主機：通訊逾時，最近 15 分鐘無讀數",
  });

  await alertService.createAlert({
    source: alertService.ALERT_SOURCES.ENERGY,
    source_id: jumpDeviceId,
    alert_type: alertService.ALERT_TYPES.THRESHOLD,
    severity: alertService.SEVERITIES.WARNING,
    dimension_key: energyAlertEvaluator.DIM_READING_JUMP,
    message: "【示範】電梯幹線電表：讀數跳動異常（單次 +128.5 kWh）",
  });

  return {
    seeded: 4,
    meterDeviceId,
    jumpDeviceId,
    message: "已建立 4 筆能源示範 incident，請至警示紀錄（source=energy）查看",
  };
}

async function clearDemoAlerts() {
  await energyAlertEvaluator.resolveAllContractStageAlerts();

  const { config } = await energySettingsService.getSettings();
  const ids = [...(config.include_device_ids || []), ...DEMO_DEVICE_IDS];
  await energyAlertEvaluator.disableAllDeviceEnergyAlerts([...new Set(ids)]);

  return { cleared: true };
}

module.exports = {
  getDashboardNotifications,
  buildMockNotifications,
  seedDemoAlerts,
  clearDemoAlerts,
};
