const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PERSONNEL_FACE_MAX_BYTES = 200 * 1024; // 與前端一致（設備限制）
const PERSONNEL_FACE_ALLOWED_MIME = new Set(["image/jpeg", "image/jpg"]);

function buildPersonnelFilename(fullName, employeeNo, ext) {
  const safe = (s) =>
    String(s == null ? "" : s)
      .trim()
      .replace(/[/\\:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 60);
  const namePart = safe(fullName);
  const noPart = safe(employeeNo);
  const parts = [noPart, namePart].filter(Boolean);
  const base = parts.length
    ? parts.join("_")
    : `face_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  return `${base.slice(0, 120)}${ext}`;
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
  readFileHeaderBytes,
  isJpegByMagicBytes,
  safeUnlink,
  getPersonnelUploadsDir,
};
