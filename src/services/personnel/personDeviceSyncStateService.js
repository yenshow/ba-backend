const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("../../database/db");
const { resolveCardNos } = require("../../utils/accessControlCardsUtils");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const { resolveUploadFilePath } = require("../../utils/baDataPaths");

const STEP_COLUMNS = {
  userInfo: { hash: "user_info_hash", status: "user_info_status", at: "user_info_synced_at" },
  face: { hash: "face_hash", status: "face_status", at: "face_synced_at" },
  card: { hash: "card_hash", status: "card_status", at: "card_synced_at" },
  fingerprint: { hash: "fingerprint_hash", status: "fingerprint_status", at: "fingerprint_synced_at" },
};

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

function hashCards({ cardNos }) {
  const list = Array.isArray(cardNos)
    ? cardNos.map((c) => String(c ?? "").trim()).filter(Boolean)
    : [];
  if (!list.length) return null;
  const sorted = [...new Set(list)].sort();
  return sha256Hex(`cards:${sorted.join("|")}`);
}

function hashLadderCard({
  cardNo,
  homeFloor,
  floors,
  cardType,
  floorMode,
  cardPassword,
  validEnabled,
  validBegin,
  validEnd,
  name,
  employeeNo,
}) {
  const c = cardNo != null ? String(cardNo).trim() : "";
  if (!c) return null;
  const floorList = Array.isArray(floors)
    ? floors.map((f) => Number(f)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const employeeId = Number(employeeNo);
  return sha256Hex(
    JSON.stringify({
      cardNo: c,
      homeFloor: Number(homeFloor) || 1,
      floors: floorList,
      cardType: Number(cardType) || 1,
      floorMode: String(floorMode || "byte"),
      cardPassword: cardPassword != null ? String(cardPassword) : "",
      validEnabled: !!validEnabled,
      validBegin: validBegin ? String(validBegin) : "",
      validEnd: validEnd ? String(validEnd) : "",
      name: name != null ? String(name).trim() : "",
      employeeNo: Number.isFinite(employeeId) && employeeId > 0 ? employeeId : 0,
    }),
  );
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
  if (Buffer.isBuffer(faceBuffer) && faceBuffer.length > 0) {
    return sha256Hex(faceBuffer);
  }
  const u = faceUrl != null ? String(faceUrl).trim() : "";
  if (!u) return null;

  // 對本機檔案（/uploads/...），避免僅用 URL 字串造成誤判：
  // - URL 不變但檔案內容被覆寫：應視為變更
  // - 不在此讀完整內容（避免前端/查詢端點爆 IO）；用 mtime/size 當作保守內容指紋
  if (u.startsWith("/uploads/")) {
    try {
      const fullPath = resolveUploadFilePath(u);
      if (!fullPath) {
        return sha256Hex(`faceUrl:${u}`);
      }
      const st = fs.statSync(fullPath);
      const size = Number(st.size) || 0;
      const mtimeMs = Number(st.mtimeMs) || 0;
      return sha256Hex(`faceFileMeta:${u}|size:${size}|mtimeMs:${mtimeMs}`);
    } catch {
      // 檔案不存在/無法 stat：退回以 URL 當 hash，至少維持穩定
      return sha256Hex(`faceUrl:${u}`);
    }
  }

  return sha256Hex(`faceUrl:${u}`);
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

/**
 * 取得各設備上「平台曾同步過」的工號（person_device_sync_states 有紀錄）
 * @returns {Map<number, Set<string>>}
 */
async function getSyncedEmployeeNosByDeviceIds(deviceIds) {
  const ids = [
    ...new Set(
      (deviceIds || [])
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];
  const map = new Map();
  if (!ids.length) return map;

  const rows = await db.query(
    `SELECT device_id, employee_no
     FROM person_device_sync_states
     WHERE device_id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  for (const r of rows || []) {
    const did = Number(r.device_id);
    if (!map.has(did)) map.set(did, new Set());
    map.get(did).add(String(r.employee_no));
  }
  return map;
}

/** 設備上應刪除的工號：不在目標名單，且平台曾推送過 */
function filterDeletableEmployeeNos(
  currentEmployeeNos,
  targetEmployeeNos,
  platformSyncedEmployeeNos,
) {
  const synced = platformSyncedEmployeeNos || new Set();
  return [...currentEmployeeNos].filter(
    (no) =>
      !targetEmployeeNos.has(String(no)) && synced.has(String(no)),
  );
}

/** 依工號查人員主檔卡號（梯控刪除設備多餘卡時使用） */
async function getCardNosForEmployeeNos(employeeNos) {
  const list = [
    ...new Set(
      (employeeNos || []).map((x) => String(x)).filter(Boolean),
    ),
  ];
  const cardNos = new Set();
  if (!list.length) return cardNos;

  const rows = await db.query(
    `SELECT config FROM persons WHERE employee_no IN (${list.map(() => "?").join(",")})`,
    list,
  );
  for (const row of rows || []) {
    let config = row.config;
    if (typeof config === "string") {
      try {
        config = JSON.parse(config);
      } catch {
        config = {};
      }
    }
    const ac =
      config && typeof config === "object" ? config.access_control || {} : {};
    for (const cardNo of resolveCardNos(ac)) {
      cardNos.add(String(cardNo));
    }
  }
  return cardNos;
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
  if (!cols) {
    throwApiError(
      C.PERSONNEL_SYNC_UNKNOWN_STEP,
      `未知同步步驟: ${String(step)}`,
    );
  }

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

  await db.query(
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
}

module.exports = {
  hashUserInfo,
  hashFace,
  hashCard,
  hashCards,
  hashLadderCard,
  hashFingerprint,
  hashFingerprintTemplate,
  getStatesForDevice,
  getSyncedEmployeeNosByDeviceIds,
  filterDeletableEmployeeNos,
  getCardNosForEmployeeNos,
  upsertStepState,
  upsertFingerprintDetailState,
};

