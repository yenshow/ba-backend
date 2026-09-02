/**
 * 執行期可寫入資料路徑 SSOT。
 * 一律在 {ba-backend} 下（uploads、postgres/data、mediamtx.generated.yml）。
 * 備份預設在 {安裝根目錄}/backups（正式安裝建議 D:\YSOP\ 或 D:\YSOS\）。
 */
const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");

const getProjectDir = () => path.resolve(__dirname, "..", "..");

/** 安裝根目錄（例：D:\YSOS\；開發時為 repo 根） */
const getInstallRoot = () => path.dirname(getProjectDir());

const getUploadsRoot = () => path.join(getProjectDir(), "uploads");

const getUploadsDir = (...segments) => path.join(getUploadsRoot(), ...segments);

const getPostgresDataDir = () =>
  path.join(getProjectDir(), "postgres", "data");

const getPostgresLogDir = () => path.join(getProjectDir(), "postgres", "logs");

const getMediamtxDir = () => path.join(getProjectDir(), "mediamtx");

const getMediamtxGeneratedConfigPath = () =>
  path.join(getMediamtxDir(), "mediamtx.generated.yml");

/** 備份根目錄（例：D:\YSOS\backups） */
const getBackupRootDir = () => path.join(getInstallRoot(), "backups");

/** 與營運日／警報日界線一致（runtimeConfigService FIXED_ALERT_ROLLOVER_TZ） */
const UPLOAD_FILENAME_TZ = "Asia/Taipei";

const ISO_HAS_OFFSET = /[zZ]|[+-]\d{2}:?\d{2}$/;

/** 將事件時間轉為營運時區（Asia/Taipei）的 Luxon DateTime */
const parseEventTimeForUploadFilename = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return DateTime.fromJSDate(value, { zone: "utc" }).setZone(UPLOAD_FILENAME_TZ);
  }

  const raw = String(value ?? "").trim();
  if (!raw) return DateTime.now().setZone(UPLOAD_FILENAME_TZ);

  if (ISO_HAS_OFFSET.test(raw)) {
    const dt = DateTime.fromISO(raw, { setZone: true });
    if (dt.isValid) return dt.setZone(UPLOAD_FILENAME_TZ);
    return DateTime.now().setZone(UPLOAD_FILENAME_TZ);
  }

  // 設備常推送無 offset 的本地牆鐘 → 視為營運時區
  const local = DateTime.fromISO(raw, { zone: UPLOAD_FILENAME_TZ });
  return local.isValid ? local : DateTime.now().setZone(UPLOAD_FILENAME_TZ);
};

/** ISAPI 附圖檔名時間戳（固定秒級 yyyy-MM-ddTHH-mm-ss，營運時區） */
const formatUploadTimestampForFilename = (value) =>
  parseEventTimeForUploadFilename(value).toFormat("yyyy-MM-dd'T'HH-mm-ss");

/** ISAPI 附圖唯一檔名：{deviceKey}_{營運日時間}_{recordId}.jpg */
const buildIsapiUploadBasename = ({
  deviceKey,
  eventTime,
  recordId,
  ext = "jpg",
}) => {
  const safeKey = String(deviceKey || "unknown").replace(/[^0-9a-fA-F.:]/g, "_");
  const rawTime = formatUploadTimestampForFilename(eventTime);
  return `${safeKey}_${rawTime}_${recordId}.${ext}`;
};

const decodeUploadRequestPath = (requestPath) => {
  const raw = String(requestPath || "").replace(/^\/+/, "").trim();
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const resolveAbsoluteUnderUploads = (relativePath) => {
  const normalized = path.normalize(
    String(relativePath || "").replace(/^\/+/, ""),
  );
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return null;
  }
  const root = path.resolve(getUploadsRoot());
  const absolute = path.resolve(root, normalized);
  if (!absolute.startsWith(root + path.sep) && absolute !== root) {
    return null;
  }
  return absolute;
};

/** GET /api/uploads/* 相對路徑 */
const resolveUploadRelativePath = (relativePath) => {
  const absolute = resolveAbsoluteUnderUploads(relativePath);
  if (!absolute) {
    return null;
  }
  try {
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      return absolute;
    }
  } catch {
    return null;
  }
  return absolute;
};

/** DB／設定中的 `/uploads/...` */
const resolveUploadFilePath = (urlPath) => {
  const normalized = String(urlPath || "")
    .trim()
    .replace(/\\/g, "/");
  if (!normalized.startsWith("/uploads/")) {
    return null;
  }
  const rel = normalized.slice("/uploads/".length);
  if (!rel || rel.includes("..")) {
    return null;
  }
  return resolveUploadRelativePath(rel);
};

const ensureDirSync = (dirPath) => {
  if (dirPath && !fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const UPLOADS_SUBDIRS = [
  "personnel",
  "access-events",
  "face-contrast-events",
  "vehicle-events",
  "settings",
  "multimedia",
];

const ensureRuntimeDataLayout = () => {
  ensureDirSync(getUploadsRoot());
  for (const sub of UPLOADS_SUBDIRS) {
    ensureDirSync(getUploadsDir(sub));
  }
  ensureDirSync(getPostgresDataDir());
  ensureDirSync(getPostgresLogDir());
};

module.exports = {
  getProjectDir,
  getInstallRoot,
  getUploadsRoot,
  getUploadsDir,
  getPostgresDataDir,
  getPostgresLogDir,
  getMediamtxDir,
  getMediamtxGeneratedConfigPath,
  getBackupRootDir,
  decodeUploadRequestPath,
  resolveUploadRelativePath,
  resolveUploadFilePath,
  formatUploadTimestampForFilename,
  parseEventTimeForUploadFilename,
  buildIsapiUploadBasename,
  UPLOAD_FILENAME_TZ,
  ensureDirSync,
  ensureRuntimeDataLayout,
};
