/**
 * 設備寫入節奏 SSOT（門禁 ISAPI／梯控 SDK）
 * @see docs/30-contracts/location-device-sync.md
 */

const toNumber = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const envNum = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  return toNumber(v, fallback);
};

/** 每次成功寫入後歇息（ms） */
const STEP_DELAY_MS = envNum("DEVICE_SYNC_STEP_DELAY_MS", 650);

/** 同一設備每處理 N 人後多歇一段 */
const PERSON_BATCH_EVERY = envNum("DEVICE_SYNC_PERSON_BATCH_EVERY", 15);

/** 人員批次歇息（ms） */
const PERSON_BATCH_PAUSE_MS = envNum("DEVICE_SYNC_PERSON_BATCH_PAUSE_MS", 2500);

/** 批次刪除 UserInfo 每批工號數 */
const DELETE_USER_INFO_CHUNK_SIZE = envNum(
  "DEVICE_SYNC_DELETE_CHUNK_SIZE",
  10,
);

/**
 * 刪除批與批之間額外歇息（ms）。
 * 成功路徑已含 STEP_DELAY_MS；此值為「再多歇」的部分。
 */
const DELETE_CHUNK_PAUSE_MS = envNum("DEVICE_SYNC_DELETE_CHUNK_PAUSE_MS", 1200);

/** 暫態錯誤重試次數（含首次） */
const TRANSIENT_RETRY_ATTEMPTS = envNum(
  "DEVICE_SYNC_TRANSIENT_RETRY_ATTEMPTS",
  4,
);

/** 一般暫態退避基數（ms）→ wait = base * 2^(attempt-1) */
const TRANSIENT_RETRY_BASE_MS = envNum(
  "DEVICE_SYNC_TRANSIENT_RETRY_BASE_MS",
  1000,
);

/** Device Busy 退避基數（ms） */
const TRANSIENT_BUSY_BASE_MS = envNum(
  "DEVICE_SYNC_TRANSIENT_BUSY_BASE_MS",
  1500,
);

module.exports = {
  STEP_DELAY_MS,
  PERSON_BATCH_EVERY,
  PERSON_BATCH_PAUSE_MS,
  DELETE_USER_INFO_CHUNK_SIZE,
  DELETE_CHUNK_PAUSE_MS,
  TRANSIENT_RETRY_ATTEMPTS,
  TRANSIENT_RETRY_BASE_MS,
  TRANSIENT_BUSY_BASE_MS,
};
