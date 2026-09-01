const fs = require("fs");
const fsPromises = require("fs").promises;
const personnelService = require("./personnelService");
const {
  resolveUniquePersonnelFacePath,
  safeUnlink,
} = require("./personnelFileHelpers");
const { normalizeFaceImage } = require("./personnelFaceImageService");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

/**
 * 將暫存 JPEG 正規化後移至正式檔名並更新 personnel.face_url（DB 成功後刪舊檔）。
 * @returns {{ faceUrl: string, person: object }}
 */
async function finalizeFaceUpload({
  tempPath,
  personnelUploadsDir,
  personId,
  warnLogger,
}) {
  const pid = Number(personId);
  if (!pid || pid <= 0) {
    throwApiError(C.PERSONNEL_FACE_UPLOAD_VALIDATION_FAILED, "personId 不合法");
  }
  if (!tempPath || !fs.existsSync(tempPath)) {
    throwApiError(C.PERSONNEL_FACE_UPLOAD_VALIDATION_FAILED, "上傳暫存檔不存在");
  }

  let inputBuffer;
  try {
    inputBuffer = await fsPromises.readFile(tempPath);
  } catch {
    safeUnlink(tempPath);
    throwApiError(C.PERSONNEL_FACE_UPLOAD_VALIDATION_FAILED, "讀取上傳暫存檔失敗");
  }

  let normalized;
  try {
    normalized = await normalizeFaceImage(inputBuffer);
  } catch (err) {
    safeUnlink(tempPath);
    throw err;
  }

  const person = await personnelService.getPersonById(pid);
  const { finalPath, faceUrl } = resolveUniquePersonnelFacePath(
    personnelUploadsDir,
    person.full_name ?? "",
    person.employee_no ?? "",
    { excludePath: tempPath },
  );

  try {
    await fsPromises.writeFile(finalPath, normalized.buffer);
  } catch (err) {
    safeUnlink(tempPath);
    throw err;
  }
  safeUnlink(tempPath);

  try {
    const updated = await personnelService.updatePerson(pid, { faceUrl });
    return { faceUrl, person: updated };
  } catch (err) {
    try {
      if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    } catch (cleanupErr) {
      warnLogger?.("清理新上傳大頭照失敗", {
        path: finalPath,
        error: cleanupErr?.message,
      });
    }
    throw err;
  }
}

module.exports = { finalizeFaceUpload };
