const fs = require("fs");
const path = require("path");
const personnelService = require("./personnelService");
const {
  PERSONNEL_FACE_MAX_BYTES,
  buildPersonnelFilename,
  readFileHeaderBytes,
  isJpegByMagicBytes,
  safeUnlink,
} = require("./personnelFileHelpers");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

/**
 * 將暫存 JPEG 移至正式檔名並更新 personnel.face_url（DB 成功後刪舊檔）。
 * @returns {{ faceUrl: string, person: object }}
 */
async function finalizeFaceUpload({
  tempPath,
  personnelUploadsDir,
  personId,
  warnLogger,
}) {
  const pid = Number(personId);
  if (!pid || pid <= 0) throwApiError(C.PERSONNEL_FACE_UPLOAD_VALIDATION_FAILED,"personId 不合法");
  if (!tempPath || !fs.existsSync(tempPath)) {
    throwApiError(C.PERSONNEL_FACE_UPLOAD_VALIDATION_FAILED,"上傳暫存檔不存在");
  }

  const st = fs.statSync(tempPath);
  if (st.size > PERSONNEL_FACE_MAX_BYTES) {
    safeUnlink(tempPath);
    throwApiError(C.PERSONNEL_FACE_UPLOAD_VALIDATION_FAILED,"大頭照需小於等於 200KB（設備限制）");
  }

  const header = readFileHeaderBytes(tempPath, 32);
  if (!isJpegByMagicBytes(header)) {
    safeUnlink(tempPath);
    throwApiError(C.PERSONNEL_FACE_UPLOAD_VALIDATION_FAILED,"圖片格式不正確：僅允許 JPEG（JPG）");
  }

  const person = await personnelService.getPersonById(pid);
  const ext = ".jpg";
  const fullName = person.full_name ?? "";
  const employeeNo = person.employee_no ?? "";
  const desiredName = buildPersonnelFilename(fullName, employeeNo, ext);

  const oldPath = tempPath;
  let finalFilename = desiredName;
  let newPath = path.join(personnelUploadsDir, finalFilename);
  let n = 0;
  while (fs.existsSync(newPath) && newPath !== oldPath) {
    n += 1;
    const base = path.basename(desiredName, ext);
    finalFilename = `${base}_${n}${ext}`;
    newPath = path.join(personnelUploadsDir, finalFilename);
  }
  if (oldPath !== newPath) fs.renameSync(oldPath, newPath);
  const faceUrl = `/uploads/personnel/${finalFilename}`;

  try {
    // 舊檔清理由 personnelService.updatePerson 統一處理（避免 upload/import 邏輯分歧）
    const updated = await personnelService.updatePerson(pid, { faceUrl });
    return { faceUrl, person: updated };
  } catch (err) {
    try {
      if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
    } catch (cleanupErr) {
      warnLogger?.("清理新上傳大頭照失敗", {
        path: newPath,
        error: cleanupErr?.message,
      });
    }
    throw err;
  }
}

module.exports = { finalizeFaceUpload };
