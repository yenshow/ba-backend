const settingsService = require("../settingsService");

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

const createBadRequestError = (message) => {
  const err = new Error(message || "參數格式不正確");
  err.statusCode = 400;
  return err;
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
    throw createBadRequestError(`公告第 ${index + 1} 筆：開始日期格式不正確`);
  }
  if (it.endDate && !endDate) {
    throw createBadRequestError(`公告第 ${index + 1} 筆：結束日期格式不正確`);
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
    throw createBadRequestError(`排程第 ${index + 1} 筆：開始時間格式不正確`);
  }
  if (!isValidTimeKey(endTime)) {
    throw createBadRequestError(`排程第 ${index + 1} 筆：結束時間格式不正確`);
  }
  if (startTime >= endTime) {
    throw createBadRequestError(`排程第 ${index + 1} 筆：開始時間需早於結束時間`);
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

module.exports = {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  getDashboardSettings,
  updateDashboardSettings,
};

