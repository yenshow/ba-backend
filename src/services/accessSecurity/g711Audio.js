/**
 * 載入 PCM／WAV 並編成 G.711（PCMU/PCMA）20ms 帧
 * 預設官方 soConvert raw PCM（44100Hz stereo → 8kHz mono）
 */
const fs = require("fs");
const path = require("path");

const FRAME_SAMPLES = 160;
const FRAME_BYTES = 160;
const PCM_CANDIDATES = [
  [8000, 1],
  [8000, 2],
  [16000, 1],
  [16000, 2],
  [44100, 1],
  [44100, 2],
  [48000, 1],
  [48000, 2],
];

const BIAS = 0x84;
const CLIP = 32635;

const linearToMulaw = (sample) => {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (
    let expMask = 0x4000;
    (sample & expMask) === 0 && exponent > 0;
    exponent -= 1, expMask >>= 1
  ) {
    /* noop */
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
};

const linearToAlaw = (sample) => {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > 32635) sample = 32635;
  let compressed;
  if (sample >= 256) {
    let exponent = 7;
    for (
      let expMask = 0x4000;
      (sample & expMask) === 0 && exponent > 0;
      exponent -= 1, expMask >>= 1
    ) {
      /* noop */
    }
    const mantissa = (sample >> (exponent + 4)) & 0x0f;
    compressed = (exponent << 4) | mantissa;
  } else {
    compressed = sample >> 4;
  }
  return (compressed ^ 0x55) | sign;
};

const pcm16ToFrames = (pcmBuffer, encodeFn) => {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  const frames = [];
  for (let i = 0; i < sampleCount; i += FRAME_SAMPLES) {
    const frame = Buffer.alloc(FRAME_BYTES);
    const end = Math.min(i + FRAME_SAMPLES, sampleCount);
    for (let j = i; j < end; j += 1) {
      const sample = pcmBuffer.readInt16LE(j * 2);
      frame[j - i] = encodeFn(sample);
    }
    const silence = encodeFn(0);
    for (let k = end - i; k < FRAME_BYTES; k += 1) {
      frame[k] = silence;
    }
    frames.push(frame);
  }
  return frames;
};

const mixToMonoFloat = (pcm, channels) => {
  const samples = Math.floor(pcm.length / 2 / channels);
  const mono = new Float64Array(samples);
  if (channels <= 1) {
    for (let i = 0; i < samples; i += 1) {
      mono[i] = pcm.readInt16LE(i * 2);
    }
    return mono;
  }

  let peakL = 0;
  let peakR = 0;
  for (let i = 0; i < samples; i += 1) {
    const l = Math.abs(pcm.readInt16LE(i * channels * 2));
    const r = Math.abs(pcm.readInt16LE((i * channels + 1) * 2));
    if (l > peakL) peakL = l;
    if (r > peakR) peakR = r;
  }
  const useLeft = peakL > peakR * 2.5;
  const useRight = peakR > peakL * 2.5;

  for (let i = 0; i < samples; i += 1) {
    if (useLeft) {
      mono[i] = pcm.readInt16LE(i * channels * 2);
    } else if (useRight) {
      mono[i] = pcm.readInt16LE((i * channels + 1) * 2);
    } else {
      let sum = 0;
      for (let ch = 0; ch < channels; ch += 1) {
        sum += pcm.readInt16LE((i * channels + ch) * 2);
      }
      mono[i] = sum / channels;
    }
  }
  return mono;
};

/** 平均降採樣（抗混疊）＋線性插值，避免 nearest-neighbor 金屬聲 */
const resampleFloat = (input, fromRate, toRate) => {
  if (fromRate === toRate) return input;
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float64Array(outLen);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLen; i += 1) {
    const start = i * ratio;
    const end = Math.min(input.length, (i + 1) * ratio);
    const i0 = Math.floor(start);
    const i1 = Math.min(input.length, Math.max(i0 + 1, Math.ceil(end)));
    if (ratio >= 1.2) {
      let acc = 0;
      let n = 0;
      for (let j = i0; j < i1; j += 1) {
        acc += input[j];
        n += 1;
      }
      out[i] = n ? acc / n : 0;
    } else {
      const frac = start - i0;
      const a = input[i0] || 0;
      const b = input[Math.min(i0 + 1, input.length - 1)] || 0;
      out[i] = a + (b - a) * frac;
    }
  }
  return out;
};

const dcBlock = (input) => {
  const out = new Float64Array(input.length);
  let prevX = 0;
  let prevY = 0;
  const r = 0.995;
  for (let i = 0; i < input.length; i += 1) {
    const x = input[i];
    const y = x - prevX + r * prevY;
    prevX = x;
    prevY = y;
    out[i] = y;
  }
  return out;
};

/** 電話頻段語音清晰度：輕微高頻提升（約 2–3kHz 子音） */
const speechPresence = (input) => {
  const out = new Float64Array(input.length);
  let prev = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x = input[i];
    out[i] = x + 0.28 * (x - prev);
    prev = x;
  }
  return out;
};

const peakNormalize = (input, target = 28000) => {
  let peak = 1;
  for (let i = 0; i < input.length; i += 1) {
    const a = Math.abs(input[i]);
    if (a > peak) peak = a;
  }
  const gain = target / peak;
  const out = new Float64Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    let v = input[i] * gain;
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    out[i] = v;
  }
  return out;
};

const floatToPcm16 = (input) => {
  const buf = Buffer.alloc(input.length * 2);
  for (let i = 0; i < input.length; i += 1) {
    buf.writeInt16LE(Math.round(input[i]), i * 2);
  }
  return buf;
};

const resampleTo8kMono = (pcm, sampleRate, channels) => {
  let samples = mixToMonoFloat(pcm, channels);
  samples = resampleFloat(samples, sampleRate, 8000);
  samples = dcBlock(samples);
  samples = speechPresence(samples);
  samples = peakNormalize(samples);
  return floatToPcm16(samples);
};

const parseWavPcm = (buf) => {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("非有效 WAV 檔");
  }
  let offset = 12;
  let sampleRate = 8000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataOffset = null;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "fmt ") {
      channels = buf.readUInt16LE(chunkStart + 2);
      sampleRate = buf.readUInt32LE(chunkStart + 4);
      bitsPerSample = buf.readUInt16LE(chunkStart + 14);
      if (bitsPerSample !== 16) {
        throw new Error(`WAV 需 16-bit PCM（目前 ${bitsPerSample}-bit）`);
      }
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
      dataSize = chunkSize;
      break;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset == null) throw new Error("WAV 缺少 data chunk");
  const pcm = buf.subarray(dataOffset, dataOffset + dataSize);
  return resampleTo8kMono(pcm, sampleRate, channels);
};

/** 依檔長推估 raw PCM：選最接近「合理語音長度」的 取樣率／聲道 */
const inferRawPcmFormat = (byteLength) => {
  let best = { sampleRate: 44100, channels: 2, durationSec: byteLength / (44100 * 4) };
  let bestScore = Infinity;
  for (const [sampleRate, channels] of PCM_CANDIDATES) {
    const durationSec = byteLength / (sampleRate * channels * 2);
    const score = Math.abs(durationSec - 30);
    if (durationSec >= 5 && durationSec <= 120 && score < bestScore) {
      bestScore = score;
      best = { sampleRate, channels, durationSec };
    }
  }
  return best;
};

const parseRawPcm = (buf) => {
  const { sampleRate, channels } = inferRawPcmFormat(buf.length);
  return resampleTo8kMono(buf, sampleRate, channels);
};

/**
 * @param {string} filePath
 * @param {{ payloadType?: 0|8 }} [opts] 0=PCMU, 8=PCMA
 * @returns {{ payloadType: 0|8, frames: Buffer[], durationMs: number }}
 */
const loadG711FramesFromFile = (filePath, opts = {}) => {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`音訊檔不存在：${abs}`);
  }

  const ext = path.extname(abs).toLowerCase();
  const raw = fs.readFileSync(abs);
  let pcm;
  if (ext === ".pcm") {
    pcm = parseRawPcm(raw);
  } else if (ext === ".wav") {
    pcm = parseWavPcm(raw);
  } else {
    throw new Error("僅支援 .pcm 或 .wav");
  }

  const payloadType = opts.payloadType === 8 ? 8 : 0;
  const encodeFn = payloadType === 8 ? linearToAlaw : linearToMulaw;
  const frames = pcm16ToFrames(pcm, encodeFn);
  if (frames.length === 0) {
    throw new Error("音訊過短或無有效樣本");
  }

  return {
    payloadType,
    frames,
    durationMs: frames.length * 20,
  };
};

module.exports = {
  loadG711FramesFromFile,
};
