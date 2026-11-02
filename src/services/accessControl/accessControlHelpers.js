/**
 * 門禁共用 helpers（平台 validity → ISAPI Valid payload）
 *
 * 規則（SSOT）：
 * - longTerm=true  => enable=false
 * - longTerm=false => enable=true
 * - begin/end 正規化為 YYYY-MM-DDTHH:mm:ss（去掉時區／毫秒；日期-only 起日 00:00:00、迄日 23:59:59）
 * - 年份夾在 2000–2037（多數門禁機 32-bit 上限 2037-12-31）
 * - 缺漏：補台北今日 T00:00:00 ~ 2037-12-31T23:59:59
 *
 * 不同機種／韌體對 Valid 的 schema 不一致（timeType、enable=false 是否仍要日期、
 * 最晚迄日 2037 或 2030）。同步層用 listIsapiValidPayloadFallbacks 依序嘗試。
 */

const ISAPI_VALID_MIN_BEGIN = "2000-01-01T00:00:00";
const ISAPI_VALID_MAX_END = "2037-12-31T23:59:59";
const ISAPI_VALID_SAFE_END = "2030-12-31T23:59:59";
const ISAPI_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;
const ISAPI_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad2 = (n) => String(n).padStart(2, "0");

const taipeiDateOnly = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const formatIsapiDateTime = (year, month, day, hour, minute, second) =>
  `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;

/**
 * 將平台／匯入的時間字串收成海康 UserInfo.Valid 可接受的本地日時。
 * 有時區或 Z 時只取牆上時分，不轉 UTC（避免 +08:00 被改成前一天）。
 * @param {unknown} value
 * @param {{ asEnd?: boolean }} [opts]
 * @returns {string} 空字串＝無法解析
 */
function normalizeIsapiDateTime(value, opts = {}) {
  const asEnd = Boolean(opts.asEnd);
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  let year;
  let month;
  let day;
  let hour;
  let minute;
  let second;

  const dateOnly = ISAPI_DATE_RE.exec(raw);
  if (dateOnly) {
    year = Number(dateOnly[1]);
    month = Number(dateOnly[2]);
    day = Number(dateOnly[3]);
    hour = asEnd ? 23 : 0;
    minute = asEnd ? 59 : 0;
    second = asEnd ? 59 : 0;
  } else {
    const match = ISAPI_DATETIME_RE.exec(raw);
    if (!match) return "";
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
    hour = Number(match[4]);
    minute = Number(match[5]);
    second = match[6] != null ? Number(match[6]) : asEnd ? 59 : 0;
  }

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return "";
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return "";
  }

  let out = formatIsapiDateTime(year, month, day, hour, minute, second);
  if (out < ISAPI_VALID_MIN_BEGIN) return ISAPI_VALID_MIN_BEGIN;
  if (out > ISAPI_VALID_MAX_END) return ISAPI_VALID_MAX_END;
  return out;
}

function defaultBeginTime() {
  return `${taipeiDateOnly()}T00:00:00`;
}

function buildIsapiValidPayloadFromPlatformValidity(validity) {
  const v = validity && typeof validity === "object" ? validity : null;
  const longTerm = v?.longTerm != null ? Boolean(v.longTerm) : true;
  const enable = longTerm ? false : true;
  let beginTime = normalizeIsapiDateTime(v?.beginTime, { asEnd: false });
  let endTime = normalizeIsapiDateTime(v?.endTime, { asEnd: true });
  if (!beginTime || !endTime) {
    beginTime = beginTime || defaultBeginTime();
    endTime = endTime || ISAPI_VALID_MAX_END;
  }
  if (beginTime > endTime) {
    beginTime = defaultBeginTime();
    endTime = ISAPI_VALID_MAX_END;
  }
  return { enable, beginTime, endTime };
}

const validKey = (payload) => JSON.stringify(payload);

/**
 * 依常見機種差異列出 Valid 嘗試順序（去重）。
 * 第一筆即 canonical（正規化、不含 timeType），以減少已成功設備的無謂重寫。
 * @param {object} canonical
 * @returns {object[]}
 */
function listIsapiValidPayloadFallbacks(canonical) {
  const c =
    canonical && typeof canonical === "object"
      ? canonical
      : { enable: false };
  const enable = Boolean(c.enable);
  const beginTime = c.beginTime ? String(c.beginTime) : "";
  const endTime = c.endTime ? String(c.endTime) : "";
  const dated = Boolean(beginTime && endTime);
  const seen = new Set();
  const variants = [];
  const push = (payload) => {
    const key = validKey(payload);
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(payload);
  };

  if (dated) {
    push({ enable, beginTime, endTime });
    push({ enable, beginTime, endTime, timeType: "local" });
    if (!enable) push({ enable: true, beginTime, endTime });
    if (endTime > ISAPI_VALID_SAFE_END) {
      const safeBegin =
        beginTime <= ISAPI_VALID_SAFE_END ? beginTime : ISAPI_VALID_MIN_BEGIN;
      push({ enable: true, beginTime: safeBegin, endTime: ISAPI_VALID_SAFE_END });
    }
  }
  if (!enable) push({ enable: false });
  if (variants.length === 0) push({ enable });

  return variants;
}

/**
 * 是否為 UserInfo.Valid 欄位 schema 錯誤（可改格式重試）。
 * 人臉建模、工號格式等永久錯不屬此類。
 * @param {unknown} errOrMessage
 */
function isIsapiValidContentError(errOrMessage) {
  const err =
    errOrMessage && typeof errOrMessage === "object" ? errOrMessage : null;
  const msg =
    err?.message != null
      ? String(err.message)
      : errOrMessage != null
        ? String(errOrMessage)
        : "";
  if (!msg) return false;
  if (
    /SubpicAnalysisModelingError|saveFacePic|checkEmployeeNo/i.test(msg)
  ) {
    return false;
  }
  const looksInvalid =
    /badJsonContent|Invalid Content|MessageParametersLack|wrong\.(enable|beginTime|endTime|timeType)/i.test(
      msg,
    );
  if (!looksInvalid) return false;
  return /endTime|beginTime|timeType|Valid|\.enable/i.test(msg);
}

module.exports = {
  ISAPI_VALID_MIN_BEGIN,
  ISAPI_VALID_MAX_END,
  ISAPI_VALID_SAFE_END,
  taipeiDateOnly,
  normalizeIsapiDateTime,
  buildIsapiValidPayloadFromPlatformValidity,
  listIsapiValidPayloadFallbacks,
  isIsapiValidContentError,
};
