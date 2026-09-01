const sharp = require("sharp");
const {
  PERSONNEL_FACE_MAX_BYTES,
  formatPersonnelFaceMaxSizeLabel,
  isJpegByMagicBytes,
} = require("./personnelFileHelpers");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

/** 與前端 PERSONNEL_FACE_CROP_DIALOG_PROPS.outputMaxLongEdge 一致 */
const FACE_OUTPUT_SIZE = 320;
const JPEG_QUALITIES = [0.85, 0.8, 0.74, 0.68, 0.62, 0.56, 0.5, 0.44, 0.38];

/**
 * 半身／全身照常見構圖：人臉在上方。先取上段再方形裁切，比單靠 attention 更容易放大臉部。
 * @param {import("sharp").Sharp} pipeline 已 rotate 的 sharp 實例
 * @param {{ width: number, height: number }} meta
 */
function applyUpperBodyPreCrop(pipeline, meta) {
  const width = meta.width;
  const height = meta.height;
  const aspect = height / width;

  if (aspect > 1.15) {
    return pipeline.extract({
      left: 0,
      top: 0,
      width,
      height: Math.min(height, Math.round(width * 1.05)),
    });
  }

  if (aspect >= 0.85) {
    return pipeline.extract({
      left: 0,
      top: 0,
      width,
      height: Math.min(height, Math.round(height * 0.72)),
    });
  }

  return pipeline;
}

async function cropToSquareBuffer(inputBuffer, position) {
  const rotated = sharp(inputBuffer, { failOn: "error" }).rotate();
  const meta = await rotated.metadata();
  if (!meta.width || !meta.height) {
    throw new Error("invalid image dimensions");
  }

  const pipeline = applyUpperBodyPreCrop(rotated, meta).resize(
    FACE_OUTPUT_SIZE,
    FACE_OUTPUT_SIZE,
    { fit: "cover", position },
  );

  return pipeline.toBuffer({ resolveWithObject: true });
}

async function cropToSquareBufferWithFallback(inputBuffer) {
  try {
    return await cropToSquareBuffer(inputBuffer, sharp.strategy.attention);
  } catch (err) {
    console.warn(
      "[personnelFaceImageService] attention crop failed, using centre",
      { error: err?.message },
    );
    return cropToSquareBuffer(inputBuffer, "centre");
  }
}

/**
 * 將 JPEG 正規化為設備可接受的大頭照（320×320 方形、≤200KB、attention 居中裁切）。
 * @param {Buffer} inputBuffer
 * @returns {Promise<{ buffer: Buffer, width: number, height: number, bytes: number }>}
 */
async function normalizeFaceImage(inputBuffer) {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throwApiError(C.PERSONNEL_FACE_UPLOAD_VALIDATION_FAILED, "圖片資料為空");
  }
  if (!isJpegByMagicBytes(inputBuffer.slice(0, 32))) {
    throwApiError(
      C.PERSONNEL_FACE_UPLOAD_VALIDATION_FAILED,
      "圖片格式不正確：僅允許 JPEG（JPG）",
    );
  }

  let cropped;
  try {
    cropped = await cropToSquareBufferWithFallback(inputBuffer);
  } catch {
    throwApiError(
      C.PERSONNEL_FACE_UPLOAD_VALIDATION_FAILED,
      "無法解析圖片，請確認為有效的 JPEG 檔",
    );
  }

  const { data: croppedBuffer, info } = cropped;

  for (const quality of JPEG_QUALITIES) {
    const buffer = await sharp(croppedBuffer)
      .jpeg({ quality: Math.round(quality * 100), mozjpeg: true })
      .toBuffer();
    if (buffer.length <= PERSONNEL_FACE_MAX_BYTES) {
      return {
        buffer,
        width: info.width,
        height: info.height,
        bytes: buffer.length,
      };
    }
  }

  throwApiError(
    C.PERSONNEL_FACE_UPLOAD_VALIDATION_FAILED,
    `圖片壓縮後仍超過 ${formatPersonnelFaceMaxSizeLabel()}，請改用更小或更清晰的正臉照片`,
  );
}

module.exports = { normalizeFaceImage, FACE_OUTPUT_SIZE };
