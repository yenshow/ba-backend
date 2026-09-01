/**
 * personnelFaceImageService
 *
 *   npm run test:personnel-face-image
 */
const assert = require("node:assert/strict");
const sharp = require("sharp");
const {
  PERSONNEL_FACE_MAX_BYTES,
  isJpegByMagicBytes,
} = require("../../src/services/personnel/personnelFileHelpers");
const {
  normalizeFaceImage,
  FACE_OUTPUT_SIZE,
} = require("../../src/services/personnel/personnelFaceImageService");

async function makeNoisyJpegBuffer(width, height, quality) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 90, b: 70 },
      noise: {
        type: "gaussian",
        mean: 128,
        sigma: 55,
      },
    },
  })
    .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

function assertSquareOutput(normalized, label) {
  assert.equal(normalized.width, FACE_OUTPUT_SIZE, `${label}: width`);
  assert.equal(normalized.height, FACE_OUTPUT_SIZE, `${label}: height`);
  assert.ok(
    normalized.bytes <= PERSONNEL_FACE_MAX_BYTES,
    `${label}: bytes`,
  );
  assert.ok(
    isJpegByMagicBytes(normalized.buffer.slice(0, 32)),
    `${label}: jpeg magic`,
  );
}

async function run() {
  for (const [width, height, quality, label] of [
    [240, 240, 80, "small"],
    [800, 800, 92, "wide"],
    [800, 1200, 88, "portrait"],
  ]) {
    const input = await makeNoisyJpegBuffer(width, height, quality);
    assertSquareOutput(await normalizeFaceImage(input), label);
  }

  await assert.rejects(
    () => normalizeFaceImage(Buffer.from("not-a-jpeg")),
    (err) => {
      assert.match(String(err.message), /JPEG/);
      return true;
    },
  );

  console.log("personnelFaceImageService tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
