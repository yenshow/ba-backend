const crypto = require("crypto");
const db = require("../../database/db");

const STEP_COLUMNS = {
  userInfo: { hash: "user_info_hash", status: "user_info_status", at: "user_info_synced_at" },
  face: { hash: "face_hash", status: "face_status", at: "face_synced_at" },
  card: { hash: "card_hash", status: "card_status", at: "card_synced_at" },
  fingerprint: { hash: "fingerprint_hash", status: "fingerprint_status", at: "fingerprint_synced_at" },
};

async function ensureFingerprintDetailColumn() {
  await db.query(`
    DO $$ 
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='person_device_sync_states' AND column_name='fingerprint_detail'
      ) THEN
        ALTER TABLE person_device_sync_states ADD COLUMN fingerprint_detail JSONB;
      END IF;
    END $$;
  `);
}

function isMissingFingerprintDetailColumnError(err) {
  const msg = err && typeof err === "object" ? String(err.message || "") : "";
  return msg.includes('column "fingerprint_detail"') && msg.includes("does not exist");
}

function sha256Hex(input) {
  const h = crypto.createHash("sha256");
  h.update(input);
  return h.digest("hex");
}

function hashUserInfo({ employeeNo, name, valid, password }) {
  const eno = String(employeeNo);
  const nm = String(name ?? "");
  const v = valid && typeof valid === "object" ? valid : null;
  const beginTime = v?.beginTime != null ? String(v.beginTime).trim() : "";
  const endTime = v?.endTime != null ? String(v.endTime).trim() : "";
  const enable =
    v?.enable === 1 ||
    v?.enable === "1" ||
    v?.enable === true ||
    (typeof v?.enable === "string" && v.enable.trim().toLowerCase() === "true")
      ? true
      : false;
  const pw = password != null ? String(password) : "";

  // 注意：UserInfo 同步除了姓名，還包含 Valid（有效期限）與 password；
  // 若不納入 hash，變更有效期限/密碼會被誤判為「未變更」而略過。
  return sha256Hex(
    JSON.stringify({
      employeeNo: eno,
      name: nm,
      valid: { enable, beginTime, endTime },
      password: pw,
    }),
  );
}

function hashCard({ cardNo }) {
  const c = cardNo != null ? String(cardNo).trim() : "";
  return c ? sha256Hex(`cardNo:${c}`) : null;
}

function hashFingerprint({ fingerprints }) {
  const list = Array.isArray(fingerprints) ? fingerprints : [];
  const normalized = list
    .map((fp) => {
      if (!fp || typeof fp !== "object") return null;
      const id = Number(fp.fingerPrintID) || 1;
      const data = fp.fingerData != null ? String(fp.fingerData).trim() : "";
      const type = fp.fingerType != null ? String(fp.fingerType) : "normalFP";
      if (!data) return null;
      return { id, type, data };
    })
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);
  if (normalized.length === 0) return null;
  return sha256Hex(JSON.stringify(normalized));
}

function hashFingerprintTemplate({ fingerPrintID, fingerType, fingerData }) {
  const id = Number(fingerPrintID) || 1;
  const type = fingerType != null ? String(fingerType) : "normalFP";
  const data = fingerData != null ? String(fingerData).trim() : "";
  if (!data) return null;
  return sha256Hex(`id:${id}|type:${type}|data:${data}`);
}

function hashFace({ faceBuffer, faceUrl }) {
  if (Buffer.isBuffer(faceBuffer) && faceBuffer.length > 0) return sha256Hex(faceBuffer);
  const u = faceUrl != null ? String(faceUrl).trim() : "";
  return u ? sha256Hex(`faceUrl:${u}`) : null;
}

async function getStatesForDevice(deviceId, employeeNos) {
  const list = Array.isArray(employeeNos)
    ? employeeNos.map((x) => String(x)).filter(Boolean)
    : [];
  if (list.length === 0) return new Map();
  const rows = await db.query(
    `SELECT *
     FROM person_device_sync_states
     WHERE device_id = ? AND employee_no = ANY(?::text[])`,
    [Number(deviceId), list],
  );
  const map = new Map();
  for (const r of rows || []) {
    map.set(String(r.employee_no), r);
  }
  return map;
}

async function upsertStepState(params) {
  const {
    deviceId,
    employeeNo,
    step,
    status,
    hash,
    syncedAt = new Date(),
    lastErrorMessage = null,
  } = params || {};

  const cols = STEP_COLUMNS[step];
  if (!cols) throw new Error(`未知同步步驟: ${String(step)}`);

  const did = Number(deviceId);
  const eno = String(employeeNo);
  const st = status != null ? String(status) : null;
  const h = hash != null ? String(hash) : null;

  await db.query(
    `INSERT INTO person_device_sync_states (
       device_id, employee_no,
       ${cols.hash}, ${cols.status}, ${cols.at},
       last_error_message
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (device_id, employee_no)
     DO UPDATE SET
       ${cols.hash} = EXCLUDED.${cols.hash},
       ${cols.status} = EXCLUDED.${cols.status},
       ${cols.at} = EXCLUDED.${cols.at},
       last_error_message = EXCLUDED.last_error_message,
       updated_at = CURRENT_TIMESTAMP`,
    [did, eno, h, st, syncedAt, lastErrorMessage],
  );
}

async function upsertFingerprintDetailState(params) {
  const {
    deviceId,
    employeeNo,
    fingerPrintID,
    status,
    hash,
    syncedAt = new Date(),
    lastErrorMessage = null,
  } = params || {};

  const did = Number(deviceId);
  const eno = String(employeeNo);
  const id = String(Number(fingerPrintID) || 1);
  const st = status != null ? String(status) : null;
  const h = hash != null ? String(hash) : null;
  const payload = JSON.stringify({ hash: h, status: st, at: syncedAt });

  const run = async () =>
    db.query(
      `INSERT INTO person_device_sync_states (
         device_id, employee_no,
         fingerprint_detail,
         last_error_message
       ) VALUES (?, ?, jsonb_set('{}'::jsonb, ARRAY[?]::text[], ?::jsonb, true), ?)
       ON CONFLICT (device_id, employee_no)
       DO UPDATE SET
         fingerprint_detail = jsonb_set(COALESCE(person_device_sync_states.fingerprint_detail, '{}'::jsonb), ARRAY[?]::text[], ?::jsonb, true),
         last_error_message = EXCLUDED.last_error_message,
         updated_at = CURRENT_TIMESTAMP`,
      [did, eno, id, payload, lastErrorMessage, id, payload],
    );

  try {
    await run();
  } catch (err) {
    if (!isMissingFingerprintDetailColumnError(err)) throw err;
    await ensureFingerprintDetailColumn();
    await run();
  }
}

module.exports = {
  hashUserInfo,
  hashFace,
  hashCard,
  hashFingerprint,
  hashFingerprintTemplate,
  getStatesForDevice,
  upsertStepState,
  upsertFingerprintDetailState,
};

