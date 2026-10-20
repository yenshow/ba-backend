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

/** 置中深色塊＋白底：近方形正規化後左右白邊應對稱 */
async function makeCenteredFaceJpeg() {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
    <rect width="100%" height="100%" fill="white"/>
    <circle cx="160" cy="140" r="70" fill="#334455"/>
    <ellipse cx="160" cy="240" rx="90" ry="50" fill="#445566"/>
  </svg>`);
  return sharp(svg).jpeg({ quality: 90 }).toBuffer();
}

async function assertRoughlyCentered(buffer, label) {
  const { data, info } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sample = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const isWhite = (p) => p[0] > 240 && p[1] > 240 && p[2] > 240;
  const isDark = (p) => p[0] < 120 && p[1] < 120 && p[2] < 140;
  const left = sample(20, 160);
  const center = sample(160, 160);
  const right = sample(300, 160);
  assert.ok(isDark(center), `${label}: center should stay on face`);
  assert.equal(
    isWhite(left),
    isWhite(right),
    `${label}: left/right white margin should match (got L=${left} R=${right})`,
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

  const centeredIn = await makeCenteredFaceJpeg();
  const centeredOut = await normalizeFaceImage(centeredIn);
  assertSquareOutput(centeredOut, "centered-square");
  await assertRoughlyCentered(centeredOut.buffer, "centered-square");

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
