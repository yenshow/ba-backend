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

/** 接近 1:1（表單裁切／設備臉圖）：置中 cover，勿再預裁 */
function isNearSquare(width, height) {
  const aspect = height / width;
  return aspect >= 0.92 && aspect <= 1.08;
}

/**
 * 高直幅半身／全身：先取上段再方形裁切。
 * @param {import("sharp").Sharp} pipeline 已 rotate 的 sharp 實例
 * @param {{ width: number, height: number }} meta
 */
function applyUpperBodyPreCrop(pipeline, meta) {
  const { width, height } = meta;
  if (height / width <= 1.15) return pipeline;
  return pipeline.extract({
    left: 0,
    top: 0,
    width,
    height: Math.min(height, Math.round(width * 1.05)),
  });
}

async function cropToSquareBuffer(inputBuffer, position) {
  const rotated = sharp(inputBuffer, { failOn: "error" }).rotate();
  const meta = await rotated.metadata();
  if (!meta.width || !meta.height) {
    throw new Error("invalid image dimensions");
  }

  const nearSquare = isNearSquare(meta.width, meta.height);
  const base = nearSquare ? rotated : applyUpperBodyPreCrop(rotated, meta);

  return base
    .resize(FACE_OUTPUT_SIZE, FACE_OUTPUT_SIZE, {
      fit: "cover",
      position: nearSquare ? "centre" : position,
    })
    .toBuffer({ resolveWithObject: true });
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
 * JPEG → 設備可接受大頭照（320×320、≤200KB）。
 * 近方形置中；直幅上半身預裁＋attention。
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
