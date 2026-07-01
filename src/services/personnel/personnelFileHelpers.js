const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PERSONNEL_FACE_MAX_BYTES = 200 * 1024; // 與前端一致（設備限制）
const PERSONNEL_FACE_ALLOWED_MIME = new Set(["image/jpeg", "image/jpg"]);

const PERSONNEL_IMPORT_IMAGE_SEP = "+_";

function sanitizePersonnelPart(value) {
  return String(value == null ? "" : value)
    .trim()
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "");
}

/** zip 對照與落地檔名基底：`姓名+_工號`（例：方維豪+_00047450） */
function buildPersonnelImportImageBasename(fullName, employeeNo) {
  const namePart = sanitizePersonnelPart(fullName);
  const noPart = sanitizePersonnelPart(employeeNo);
  if (!namePart || !noPart) return null;
  return `${namePart}${PERSONNEL_IMPORT_IMAGE_SEP}${noPart}`;
}

function buildPersonnelFilename(fullName, employeeNo, ext) {
  const base = buildPersonnelImportImageBasename(fullName, employeeNo);
  if (base) return `${base.slice(0, 120)}${ext}`;
  return `face_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
}

/** 批次匯入 zip 內圖片檔名候選（小寫比對） */
function listPersonnelImportZipCandidateNames(fullName, employeeNo) {
  const base = buildPersonnelImportImageBasename(fullName, employeeNo);
  const names = [];
  if (base) {
    names.push(`${base}.jpeg`, `${base}.jpg`);
  }
  const noPart = sanitizePersonnelPart(employeeNo);
  if (noPart) {
    names.push(`${noPart}.jpeg`, `${noPart}.jpg`);
  }
  return names;
}

function readFileHeaderBytes(filePath, maxBytes = 32) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.slice(0, Math.max(0, bytesRead));
  } finally {
    try {
      fs.closeSync(fd);
    } catch (_e) {}
  }
}

function isJpegByMagicBytes(header) {
  if (!Buffer.isBuffer(header) || header.length < 3) return false;
  return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (_e) {}
}

function getPersonnelUploadsDir() {
  return path.join(process.cwd(), "uploads", "personnel");
}

module.exports = {
  PERSONNEL_FACE_MAX_BYTES,
  PERSONNEL_FACE_ALLOWED_MIME,
  buildPersonnelFilename,
  buildPersonnelImportImageBasename,
  listPersonnelImportZipCandidateNames,
  readFileHeaderBytes,
  isJpegByMagicBytes,
  safeUnlink,
  getPersonnelUploadsDir,
};
