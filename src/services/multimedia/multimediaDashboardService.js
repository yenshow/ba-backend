const settingsService = require("../platform/settingsService");
const db = require("../../database/db");
const modbusBatchService = require("../devices/modbusBatchService");
const deviceLoggingConfig = require("../devices/deviceLoggingConfig");
const environmentReadingsService = require("../environment/environmentReadingsService");
const {
  computeDerivedMetrics,
} = require("../environment/environmentDerivedMetrics");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

const SETTINGS_KEY = "multimedia_dashboard_settings_v1";

const DEFAULT_SETTINGS = Object.freeze({
  backgroundImageUrl: "",
  projectImageUrl: "",
  heroImageUrl: "",
  bannerMarqueeText: "",
  envDeviceIds: [],
  envDisplayParameters: [],
  wallAnnouncementsPerPage: 5,
  wallSchedulesPerPage: 4,
  wallAnnouncementsAutoPageIntervalMs: 10000,
  wallSchedulesAutoPageIntervalMs: 10000,
  announcements: [],
  schedules: [],
});

const safeJsonParse = (raw) => {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const normalizeString = (v, maxLen = 5000) => {
  if (v == null) return "";
  const s = String(v);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
};

const normalizeUrlString = (v) => {
  const s = normalizeString(v, 2000).trim();
  return s;
};

const normalizeDateKey = (v) => {
  const s = normalizeString(v, 20).trim(); // YYYY-MM-DD
  if (!s) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
};

const isValidTimeKey = (v) => {
  if (!v || typeof v !== "string") return false;
  if (!/^\d{2}:\d{2}$/.test(v)) return false;
  const parts = v.split(":").map((x) => Number(x));
  const hh = parts[0];
  const mm = parts[1];
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;
  if (hh < 0 || hh > 23) return false;
  if (mm < 0 || mm > 59) return false;
  return true;
};

const normalizeDeviceIds = (v) => {
  const arr = Array.isArray(v) ? v : [];
  const out = [];
  for (const raw of arr) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    out.push(Math.floor(n));
  }
  // 去重 + 排序（避免 payload 反覆抖動）
  return [...new Set(out)].sort((a, b) => a - b);
};

const clampInt = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
};

const normalizeAnnouncement = (item, index) => {
  const it = item && typeof item === "object" ? item : {};
  const id = normalizeString(it.id, 80).trim() || `a_${Date.now()}_${index}`;
  const title = normalizeString(it.title, 120).trim();
  const pinned = Boolean(it.pinned);
  const enabled = it.enabled === undefined ? true : Boolean(it.enabled);

  const startDate = normalizeDateKey(it.startDate);
  const endDate = normalizeDateKey(it.endDate);

  if (it.startDate && !startDate) {
    throwApiError(C.VALIDATION_CUSTOM, `公告第 ${index + 1} 筆：開始日期格式不正確`);
  }
  if (it.endDate && !endDate) {
    throwApiError(C.VALIDATION_CUSTOM, `公告第 ${index + 1} 筆：結束日期格式不正確`);
  }

  // 若兩者都有且順序顛倒，直接交換，避免看板永遠顯示不到
  if (startDate && endDate && startDate > endDate) {
    return { id, title, pinned, enabled, startDate: endDate, endDate: startDate };
  }

  return { id, title, pinned, enabled, startDate, endDate };
};

const normalizeSchedule = (item, index) => {
  const it = item && typeof item === "object" ? item : {};
  const id = normalizeString(it.id, 80).trim() || `s_${Date.now()}_${index}`;
  const enabled = it.enabled === undefined ? true : Boolean(it.enabled);
  const startTime = normalizeString(it.startTime, 10).trim(); // HH:mm
  const endTime = normalizeString(it.endTime, 10).trim(); // HH:mm
  const title = normalizeString(it.title, 200).trim();

  if (!isValidTimeKey(startTime)) {
    throwApiError(C.VALIDATION_CUSTOM, `排程第 ${index + 1} 筆：開始時間格式不正確`);
  }
  if (!isValidTimeKey(endTime)) {
    throwApiError(C.VALIDATION_CUSTOM, `排程第 ${index + 1} 筆：結束時間格式不正確`);
  }
  if (startTime >= endTime) {
    throwApiError(C.VALIDATION_CUSTOM, `排程第 ${index + 1} 筆：開始時間需早於結束時間`);
  }

  return { id, enabled, startTime, endTime, title };
};

const normalizeSettings = (payload) => {
  const p = payload && typeof payload === "object" ? payload : {};

  const announcementsRaw = Array.isArray(p.announcements) ? p.announcements : [];
  const schedulesRaw = Array.isArray(p.schedules) ? p.schedules : [];

  return {
    backgroundImageUrl: normalizeUrlString(p.backgroundImageUrl),
    projectImageUrl: normalizeUrlString(p.projectImageUrl),
    heroImageUrl: normalizeUrlString(p.heroImageUrl),
    bannerMarqueeText: normalizeString(p.bannerMarqueeText, 500).trim(),
    envDeviceIds: normalizeDeviceIds(p.envDeviceIds),
    envDisplayParameters: Array.isArray(p.envDisplayParameters)
      ? p.envDisplayParameters.map((x) => normalizeString(x, 40).trim()).filter(Boolean)
      : [],
    wallAnnouncementsPerPage: clampInt(
      p.wallAnnouncementsPerPage,
      1,
      20,
      DEFAULT_SETTINGS.wallAnnouncementsPerPage,
    ),
    wallSchedulesPerPage: clampInt(
      p.wallSchedulesPerPage,
      1,
      20,
      DEFAULT_SETTINGS.wallSchedulesPerPage,
    ),
    wallAnnouncementsAutoPageIntervalMs: clampInt(
      p.wallAnnouncementsAutoPageIntervalMs,
      1000,
      120000,
      DEFAULT_SETTINGS.wallAnnouncementsAutoPageIntervalMs,
    ),
    wallSchedulesAutoPageIntervalMs: clampInt(
      p.wallSchedulesAutoPageIntervalMs,
      1000,
      120000,
      DEFAULT_SETTINGS.wallSchedulesAutoPageIntervalMs,
    ),
    announcements: announcementsRaw.map(normalizeAnnouncement),
    schedules: schedulesRaw.map(normalizeSchedule),
  };
};

async function getDashboardSettings() {
  const row = await settingsService.getSettingByKey(SETTINGS_KEY);
  const parsed = safeJsonParse(row?.value);
  const merged = { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
  // 再 normalize 一次，避免舊資料形狀不一致
  return normalizeSettings(merged);
}

async function updateDashboardSettings(payload) {
  const normalized = normalizeSettings(payload);
  await settingsService.upsertSetting(
    SETTINGS_KEY,
    JSON.stringify(normalized),
    "多媒體資訊牆設定（v1）",
  );
  return normalized;
}

const toNormalizedRegisterType = (registerType) => {
  const rt = String(registerType || "holding").toLowerCase();
  if (rt === "input") return "input";
  if (rt === "coil" || rt === "coils") return "coils";
  if (rt === "discrete" || rt === "discrete_input") return "discrete";
  return "holding";
};

const REGISTER_TYPE_TO_BATCH = Object.freeze({
  holding: "holding",
  input: "input",
  coils: "coil",
  discrete: "discrete",
});

async function readDeviceValuesByRegisterType(enabledValues, deviceConfig) {
  const deviceValues = {};
  const registerTypes = ["holding", "input", "coils", "discrete"];

  for (const rt of registerTypes) {
    const group = enabledValues.filter(
      (v) => toNormalizedRegisterType(v.register_type) === rt,
    );
    if (group.length === 0) continue;

    let minAddress = Number(group[0].address);
    let maxAddress = Number(group[0].address) + (Number(group[0].length) || 1);
    for (const vc of group) {
      const addr = Number(vc.address);
      const len = Number(vc.length) || 1;
      if (!Number.isFinite(addr) || addr < 0) continue;
      const endAddr = addr + len;
      minAddress = Math.min(minAddress, addr);
      maxAddress = Math.max(maxAddress, endAddr);
    }
    const readLength = maxAddress - minAddress;
    if (!Number.isFinite(readLength) || readLength <= 0) continue;

    const results = await modbusBatchService.batchRead([
      {
        host: deviceConfig.host,
        port: deviceConfig.port,
        unitId: deviceConfig.unitId,
        registerType: REGISTER_TYPE_TO_BATCH[rt] || "holding",
        address: minAddress,
        length: readLength,
        meta: { registerType: rt, multimedia: true },
      },
    ]);
    const first = results?.[0];
    if (!first || first.ok !== true) {
      throwApiError(C.MULTIMEDIA_MODBUS_READ_FAILED, first?.error || "讀取失敗");
    }
    const modbusData = first.data;

    for (const valueConfig of group) {
      const addr = Number(valueConfig.address);
      const len = Number(valueConfig.length) || 1;
      if (!Number.isFinite(addr) || addr < 0) continue;
      const relativeAddress = addr - minAddress;
      const rawValue =
        Array.isArray(modbusData) &&
        relativeAddress >= 0 &&
        relativeAddress < modbusData.length
          ? len === 1
            ? modbusData[relativeAddress]
            : modbusData.slice(relativeAddress, relativeAddress + len)
          : null;

      if (rawValue !== null && rawValue !== undefined) {
        const convertedValue = deviceLoggingConfig.applyConversion(
          rawValue,
          valueConfig.conversion,
        );
        deviceValues[valueConfig.name] = convertedValue;
      }
    }
  }

  return deviceValues;
}

async function getMultimediaEnvReadingsSnapshot() {
  const settings = await getDashboardSettings();
  const deviceIds = (settings.envDeviceIds || [])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0);

  if (!deviceIds.length) {
    return {
      timestamp: new Date().toISOString(),
      data: {},
      devices: [],
    };
  }

  const rows = await db.query(
    `SELECT id, config as device_config
     FROM devices
     WHERE id = ANY($1::int[])
       AND status = 'active'
       AND type_code = 'sensor'
       AND config->>'protocol' = 'modbus'`,
    [deviceIds],
  );
  const deviceConfigMap = new Map(
    (rows || []).map((d) => [Number(d.id), d.device_config]),
  );

  const timestamp = new Date().toISOString();
  const mergedData = {};
  const devices = [];

  for (const deviceId of deviceIds) {
    const deviceConfigRaw = deviceConfigMap.get(deviceId);
    if (!deviceConfigRaw) {
      devices.push({
        deviceId,
        status: "offline",
        reason: "設備不存在 / 未啟用 / 非 Modbus 感測器",
      });
      continue;
    }

    const deviceConfig =
      typeof deviceConfigRaw === "string"
        ? JSON.parse(deviceConfigRaw || "{}")
        : deviceConfigRaw || {};
    if (!deviceConfig.host || !deviceConfig.port) {
      devices.push({
        deviceId,
        status: "offline",
        reason: "設備配置不完整（host/port）",
      });
      continue;
    }

    const cfg = {
      host: deviceConfig.host,
      port: deviceConfig.port,
      unitId: deviceConfig.unitId || 1,
    };

    try {
      const loggingConfig = await deviceLoggingConfig.getDeviceLoggingConfig(
        deviceId,
      );
      const enabledValues = (loggingConfig?.values || []).filter(
        (v) => v && v.enabled !== false,
      );

      // 沒有 values 也視為 online（配置可能只用於 health check）
      let deviceValues = {};
      if (loggingConfig?.enabled && enabledValues.length > 0) {
        deviceValues = await readDeviceValuesByRegisterType(enabledValues, cfg);
      } else {
        // 最小 health check：讀取 holding register 0（與 environmentMonitor 一致）
        const results = await modbusBatchService.batchRead([
          {
            host: cfg.host,
            port: cfg.port,
            unitId: cfg.unitId,
            registerType: "holding",
            address: 0,
            length: 1,
            meta: { health: true, multimedia: true },
          },
        ]);
        const first = results?.[0];
        if (!first || first.ok !== true) {
          throwApiError(C.MULTIMEDIA_MODBUS_READ_FAILED, first?.error || "設備離線");
        }
      }

      // merge (first non-null wins)
      for (const [k, v] of Object.entries(deviceValues || {})) {
        if (mergedData[k] === undefined || mergedData[k] === null) {
          mergedData[k] = v;
        }
      }

      devices.push({ deviceId, status: "online" });
    } catch (err) {
      devices.push({
        deviceId,
        status: "offline",
        reason: err?.message || "設備離線",
      });
    }
  }

  // rounding + derived metrics
  const rounded = environmentReadingsService.roundDataToOneDecimal(mergedData);
  const derived = { ...rounded, ...computeDerivedMetrics(rounded) };

  return { timestamp, data: derived, devices };
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  getDashboardSettings,
  updateDashboardSettings,
  getMultimediaEnvReadingsSnapshot,
};

