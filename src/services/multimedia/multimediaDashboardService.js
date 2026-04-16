const settingsService = require("../settingsService");

const SETTINGS_KEY = "multimedia_dashboard_settings_v1";

const DEFAULT_SETTINGS = Object.freeze({
  backgroundImageUrl: "",
  projectImageUrl: "",
  heroImageUrl: "",
  bannerMarqueeText: "",
  envDeviceIds: [],
  envDisplayParameters: [],
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

const normalizeAnnouncement = (item, index) => {
  const it = item && typeof item === "object" ? item : {};
  const id = normalizeString(it.id, 80).trim() || `a_${Date.now()}_${index}`;
  const title = normalizeString(it.title, 120).trim();
  const content = normalizeString(it.content, 2000).trim();
  const pinned = Boolean(it.pinned);
  const startAt = it.startAt ? normalizeString(it.startAt, 40).trim() : "";
  const endAt = it.endAt ? normalizeString(it.endAt, 40).trim() : "";
  const sortOrderRaw = Number(it.sortOrder);
  const sortOrder = Number.isFinite(sortOrderRaw) ? Math.floor(sortOrderRaw) : index;

  return { id, title, content, pinned, startAt, endAt, sortOrder };
};

const normalizeSchedule = (item, index) => {
  const it = item && typeof item === "object" ? item : {};
  const id = normalizeString(it.id, 80).trim() || `s_${Date.now()}_${index}`;
  const date = normalizeString(it.date, 20).trim(); // YYYY-MM-DD
  const startTime = normalizeString(it.startTime, 10).trim(); // HH:mm
  const endTime = normalizeString(it.endTime, 10).trim(); // HH:mm
  const title = normalizeString(it.title, 200).trim();
  const sortOrderRaw = Number(it.sortOrder);
  const sortOrder = Number.isFinite(sortOrderRaw) ? Math.floor(sortOrderRaw) : index;

  return { id, date, startTime, endTime, title, sortOrder };
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

