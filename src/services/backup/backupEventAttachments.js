/**
 * 門禁／車輛 ISAPI 事件附圖：歸檔複製至 backups/，冷刪除時清理 uploads 原檔
 */
const fs = require("fs");
const path = require("path");
const { resolveUploadFilePath } = require("../../utils/baDataPaths");
const { getBackupConfig } = require("./backupConfig");

const getAttachmentBackupDir = (subdir) => {
  const root = getBackupConfig().directories.root;
  return path.join(root, subdir);
};

const copyPictureToBackup = (picturePath, subdir) => {
  const normalized = String(picturePath || "").trim();
  if (!normalized) return null;

  const src = resolveUploadFilePath(normalized);
  if (!src || !fs.existsSync(src)) return null;

  const destDir = getAttachmentBackupDir(subdir);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const basename = path.basename(src);
  const dest = path.join(destDir, basename);
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(src, dest);
  }
  return `${subdir}/${basename}`;
};

const copyPicturesForRows = (rows, subdir, picturePathField = "picture_path") => {
  const backupPaths = new Map();
  for (const row of rows || []) {
    const url = row?.[picturePathField];
    if (!url || backupPaths.has(url)) continue;
    const backupRel = copyPictureToBackup(url, subdir);
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
