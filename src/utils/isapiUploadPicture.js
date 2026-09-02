/**
 * ISAPI 事件附圖落地（門禁／人臉比對／車輛共用）
 */
const fs = require("fs");
const path = require("path");
const {
  getUploadsDir,
  buildIsapiUploadBasename,
  ensureDirSync,
} = require("./baDataPaths");

/**
 * 寫入 uploads 子目錄並回傳 DB 用的 picture_path
 * @returns {{ basename: string, filePath: string, picturePath: string } | null}
 */
const writeIsapiUploadPicture = ({
  subdir,
  deviceKey,
  eventTime,
  recordId,
  pictureBuffer,
}) => {
  if (
    !subdir ||
    recordId == null ||
    !Buffer.isBuffer(pictureBuffer) ||
    pictureBuffer.length === 0
  ) {
    return null;
  }

  const basename = buildIsapiUploadBasename({
    deviceKey,
    eventTime,
    recordId,
  });
  const uploadsDir = getUploadsDir(subdir);
  ensureDirSync(uploadsDir);
  const filePath = path.join(uploadsDir, basename);
  fs.writeFileSync(filePath, pictureBuffer);

  return {
    basename,
    filePath,
    picturePath: `/uploads/${subdir}/${basename}`,
  };
};

module.exports = {
  writeIsapiUploadPicture,
};
