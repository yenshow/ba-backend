/**
 * 執行期可寫入資料路徑 SSOT。
 * 一律在 {ba-backend} 下（uploads、postgres/data、mediamtx.generated.yml）。
 * 備份預設在 {安裝根目錄}/backups（正式安裝建議 D:\YSOP\ 或 D:\YSOS\）。
 */
const fs = require("fs");
const path = require("path");

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

/** ISAPI 附圖檔名時間戳（避免 Date.toString() 產生空格） */
const formatUploadTimestampForFilename = (value, maxLen = 19) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\..*$/, "")
      .slice(0, maxLen);
  }
  return String(value || "")
    .replace(/:/g, "-")
    .replace(/\+.*$/, "")
    .replace(/Z$/, "")
    .slice(0, maxLen);
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
  ensureDirSync,
  ensureRuntimeDataLayout,
};
