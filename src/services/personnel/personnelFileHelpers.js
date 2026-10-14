const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/** 落地檔／multer／upload-face 上限（與海康門禁 Web UI、雙前端一致） */
const PERSONNEL_FACE_MAX_BYTES = 200 * 1024;

/** zip 匯入原始 JPEG buffer 上限（壓縮前） */
const PERSONNEL_FACE_IMPORT_SOURCE_MAX_BYTES = 512 * 1024;

function formatPersonnelFaceMaxSizeLabel() {
  return `${PERSONNEL_FACE_MAX_BYTES / 1024}KB`;
}

function formatPersonnelFaceImportSourceMaxSizeLabel() {
  return `${PERSONNEL_FACE_IMPORT_SOURCE_MAX_BYTES / 1024}KB`;
}

const PERSONNEL_FACE_ALLOWED_MIME = new Set(["image/jpeg", "image/jpg"]);

/** 檔名片段：去空白、移除檔名非法字元 */
function sanitizePersonnelPart(value) {
  return String(value == null ? "" : value)
    .trim()
    .replace(/[/\\:*?"<>|+]/g, "")
    .replace(/\s+/g, "");
}

/**
 * 大頭照檔名基底（SSOT）：僅工號／ID。
 * 工號建立後鎖定，不因改名而失效；較「姓名_工號」精簡。
 */
function buildPersonnelFaceBasename(employeeNo) {
  const noPart = sanitizePersonnelPart(employeeNo);
  return noPart || null;
}

function buildPersonnelFilename(employeeNo, ext) {
  const base = buildPersonnelFaceBasename(employeeNo);
  if (base) return `${base.slice(0, 120)}${ext}`;
  return `face_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
}

/** 批次 zip 內圖片檔名候選（小寫比對）：僅 `工號.jpg`／`.jpeg` */
function listPersonnelImportZipCandidateNames(employeeNo) {
  const noPart = sanitizePersonnelPart(employeeNo);
  if (!noPart) return [];
  return [`${noPart}.jpeg`, `${noPart}.jpg`];
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

/**
 * 解析不重複的大頭照落地路徑（檔名：`工號.jpg`，衝突時加 _N 後綴）。
 */
function resolveUniquePersonnelFacePath(
  personnelUploadsDir,
  employeeNo,
  options = {},
) {
  const excludePath = options.excludePath || null;
  const ext = ".jpg";
  const desiredName = buildPersonnelFilename(employeeNo, ext);
  let finalFilename = desiredName;
  let finalPath = path.join(personnelUploadsDir, finalFilename);
  let n = 0;
  while (fs.existsSync(finalPath) && finalPath !== excludePath) {
    n += 1;
    const base = path.basename(desiredName, ext);
    finalFilename = `${base}_${n}${ext}`;
    finalPath = path.join(personnelUploadsDir, finalFilename);
  }
  return {
    finalFilename,
    finalPath,
    faceUrl: `/uploads/personnel/${finalFilename}`,
  };
}

module.exports = {
  PERSONNEL_FACE_MAX_BYTES,
  PERSONNEL_FACE_IMPORT_SOURCE_MAX_BYTES,
  formatPersonnelFaceMaxSizeLabel,
  formatPersonnelFaceImportSourceMaxSizeLabel,
  PERSONNEL_FACE_ALLOWED_MIME,
  buildPersonnelFilename,
  buildPersonnelFaceBasename,
  listPersonnelImportZipCandidateNames,
  readFileHeaderBytes,
  isJpegByMagicBytes,
  safeUnlink,
  resolveUniquePersonnelFacePath,
};
