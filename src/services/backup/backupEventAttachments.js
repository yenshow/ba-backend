/**
 * 門禁／車輛／人臉比對 ISAPI 事件附圖：歸檔複製至 backups/，冷刪除時清理 uploads 原檔
 */
const fs = require("fs");
const path = require("path");
const { resolveUploadFilePath } = require("../../utils/baDataPaths");
const { getBackupConfig } = require("./backupConfig");

const getAttachmentBackupDir = (subdir) => {
  const root = getBackupConfig().directories.root;
  return path.join(root, subdir);
};

/**
 * @param {string} picturePath
 * @param {string} subdir 相對 BACKUP_ROOT（可含路徑，如 people_counting/attachments）
 * @param {string} [namePrefix] 檔名前綴（防合併目錄撞名）
 * @returns {string|null} 相對 BACKUP_ROOT 路徑
 */
const copyPictureToBackup = (picturePath, subdir, namePrefix = "") => {
  const normalized = String(picturePath || "").trim();
  if (!normalized) return null;

  const src = resolveUploadFilePath(normalized);
  if (!src || !fs.existsSync(src)) return null;

  const destDir = getAttachmentBackupDir(subdir);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const prefix = String(namePrefix || "");
  const basename = `${prefix}${path.basename(src)}`;
  const dest = path.join(destDir, basename);
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(src, dest);
  }
  return `${subdir}/${basename}`.replace(/\\/g, "/");
};

/**
 * @param {object[]} rows
 * @param {string} subdir
 * @param {string} [picturePathField]
 * @param {string} [namePrefix]
 */
const copyPicturesForRows = (
  rows,
  subdir,
  picturePathField = "picture_path",
  namePrefix = "",
) => {
  const backupPaths = new Map();
  for (const row of rows || []) {
    const url = row?.[picturePathField];
    if (!url || backupPaths.has(url)) continue;
    const backupRel = copyPictureToBackup(url, subdir, namePrefix);
    if (backupRel) backupPaths.set(url, backupRel);
  }
  return backupPaths;
};

const removeUploadPicture = (picturePath) => {
  const src = resolveUploadFilePath(picturePath);
  if (!src || !fs.existsSync(src)) return;
  try {
    fs.unlinkSync(src);
  } catch {
    // 忽略
  }
};

const removeUploadPictures = (picturePaths) => {
  for (const p of picturePaths || []) {
    if (p) removeUploadPicture(p);
  }
};

module.exports = {
  copyPicturesForRows,
  removeUploadPictures,
};
