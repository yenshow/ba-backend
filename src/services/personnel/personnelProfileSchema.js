/**
 * 人員自訂欄位定義＋列表顯示（平台專用；不下發設備）
 * 儲存：system_settings.personnel_profile_schema
 */
const settingsService = require("../platform/settingsService");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const SETTINGS_KEY = "personnel_profile_schema";
const MAX_ENABLED_FIELDS = 5;
const MAX_LABEL_LENGTH = 16;
const MAX_VALUE_LENGTH = 100;

const PRESET_KEYS = [
  "job_title",
  "blood_type",
  "insurance",
  "phone",
  "department",
  "emergency_contact",
  "note",
];

const PRESET_CATALOG = {
  job_title: { label: "職稱", aliases: ["職稱", "title", "jobTitle"] },
  blood_type: { label: "血型", aliases: ["血型", "bloodType", "blood"] },
  insurance: { label: "保險", aliases: ["保險", "insurance"] },
  phone: { label: "電話", aliases: ["電話", "手機", "phone"] },
  department: { label: "部門", aliases: ["部門", "department"] },
  emergency_contact: {
    label: "緊急聯絡人",
    aliases: ["緊急聯絡人", "emergencyContact"],
  },
  note: { label: "備註", aliases: ["備註", "note", "remark"] },
};

const BLOOD_TYPE_SUGGESTIONS = ["A", "B", "AB", "O"];

const TOGGLEABLE_LIST_COLUMNS = ["avatar", "group", "accessData", "status"];

const DEFAULT_LIST_COLUMNS = {
  avatar: true,
  group: true,
  accessData: true,
  status: true,
};

const CUSTOM_KEY_RE = /^custom_(\d+)$/;

const RESERVED_LABEL_KEYS = new Set(
  [
    "ID",
    "工號",
    "員工編號",
    "employeeNo",
    "姓名",
    "fullName",
    "名字",
    "有效起始日",
    "有效結束日",
    "有效起",
    "有效迄",
    "有效起始",
    "有效結束",
    "beginTime",
    "endTime",
    "門禁密碼",
    "password",
    "密碼",
    "卡號",
    "cardNo",
    "card_no",
    "車牌",
    "licensePlates",
    "license_plates",
    "plateNumber",
    "群組",
    "狀態",
    "group",
    "status",
  ].map((s) => normalizeKey(s)),
);

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return fallback;
  const s = value.trim();
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function sanitizeLabel(raw) {
  return String(raw || "").trim().slice(0, MAX_LABEL_LENGTH);
}

function sanitizeValue(raw) {
  if (raw == null) return "";
  return String(raw).trim().slice(0, MAX_VALUE_LENGTH);
}

function isPresetKey(key) {
  return PRESET_KEYS.includes(key);
}

function nextCustomKey(fields) {
  let max = 0;
  for (const field of fields || []) {
    const m = CUSTOM_KEY_RE.exec(String(field?.key || ""));
    if (m) max = Math.max(max, Number.parseInt(m[1], 10) || 0);
  }
  return `custom_${max + 1}`;
}

function normalizeListColumns(raw, fieldKeys) {
  const src = asObject(raw);
  const next = { ...DEFAULT_LIST_COLUMNS };
  for (const col of TOGGLEABLE_LIST_COLUMNS) {
    if (src[col] === false) next[col] = false;
    else next[col] = true;
  }
  const requested = Array.isArray(src.custom)
    ? src.custom.map((k) => String(k || "").trim()).filter(Boolean)
    : fieldKeys;
  const keySet = new Set(fieldKeys);
  next.custom = requested.filter((k) => keySet.has(k));
  return next;
}

function normalizeField(raw) {
  const src = asObject(raw);
  const presetRaw = String(src.preset || "").trim();
  const keyRaw = String(src.key || "").trim();
  const preset = isPresetKey(presetRaw)
    ? presetRaw
    : presetRaw === "custom" || CUSTOM_KEY_RE.test(keyRaw)
      ? "custom"
      : isPresetKey(keyRaw)
        ? keyRaw
        : "";
  if (!preset) return null;

  const key = preset === "custom" ? keyRaw : preset;
  if (preset === "custom" && !CUSTOM_KEY_RE.test(key)) return null;
  if (preset !== "custom" && key !== preset) return null;

  const fallbackLabel =
    preset === "custom" ? "" : PRESET_CATALOG[preset]?.label || preset;
  const label = sanitizeLabel(src.label) || fallbackLabel;
  if (!label) return null;

  return { key, preset, label };
}

function emptySchema() {
  return {
    fields: [],
    listColumns: { ...DEFAULT_LIST_COLUMNS, custom: [] },
  };
}

function normalizeSchema(raw) {
  const src = asObject(typeof raw === "string" ? parseJson(raw, {}) : raw);
  const fields = [];
  const seenKeys = new Set();
  const seenLabels = new Set();
  const incoming = Array.isArray(src.fields) ? src.fields : [];
  for (const item of incoming) {
    if (fields.length >= MAX_ENABLED_FIELDS) break;
    const field = normalizeField(item);
    if (!field) continue;
    const labelKey = normalizeKey(field.label);
    if (seenKeys.has(field.key) || seenLabels.has(labelKey)) continue;
    if (RESERVED_LABEL_KEYS.has(labelKey)) continue;
    seenKeys.add(field.key);
    seenLabels.add(labelKey);
    fields.push(field);
  }
  return {
    fields,
    listColumns: normalizeListColumns(src.listColumns, fields.map((f) => f.key)),
  };
}

function validateAndNormalize(raw) {
  const src = asObject(raw);
  if (src.fields != null && !Array.isArray(src.fields)) {
    throwApiError(C.PERSONNEL_VALIDATION_FAILED, "fields 必須為陣列");
  }
  const incoming = Array.isArray(src.fields) ? src.fields : [];
  if (incoming.length > MAX_ENABLED_FIELDS) {
    throwApiError(
      C.PERSONNEL_VALIDATION_FAILED,
      `自訂欄位最多 ${MAX_ENABLED_FIELDS} 個`,
    );
  }

  const fields = [];
  const seenKeys = new Set();
  const seenLabels = new Set();
  for (const item of incoming) {
    const field = normalizeField(item);
    if (!field) {
      throwApiError(C.PERSONNEL_VALIDATION_FAILED, "欄位 key／preset／標籤無效");
    }
    const label = sanitizeLabel(field.label);
    if (!label) {
      throwApiError(C.PERSONNEL_VALIDATION_FAILED, "欄位標籤不可為空");
    }
    if (label.length > MAX_LABEL_LENGTH) {
      throwApiError(
        C.PERSONNEL_VALIDATION_FAILED,
        `欄位標籤最多 ${MAX_LABEL_LENGTH} 字`,
      );
    }
    const labelKey = normalizeKey(label);
    if (RESERVED_LABEL_KEYS.has(labelKey)) {
      throwApiError(
        C.PERSONNEL_VALIDATION_FAILED,
        `「${label}」為系統保留欄位名稱`,
      );
    }
    if (seenKeys.has(field.key)) {
      throwApiError(C.PERSONNEL_VALIDATION_FAILED, "欄位 key 不可重複");
    }
    if (seenLabels.has(labelKey)) {
      throwApiError(C.PERSONNEL_VALIDATION_FAILED, "欄位標籤不可重複");
    }
    seenKeys.add(field.key);
    seenLabels.add(labelKey);
    fields.push({ key: field.key, preset: field.preset, label });
  }

  return {
    fields,
    listColumns: normalizeListColumns(src.listColumns, fields.map((f) => f.key)),
  };
}

function asCustomFieldsObject(value) {
  const parsed = typeof value === "string" ? parseJson(value, {}) : value;
  return asObject(parsed);
}

function mergeCustomFields(existing, incoming, enabledKeys) {
  const next = { ...asCustomFieldsObject(existing) };
  const src = asObject(incoming);
  const allowed = new Set(enabledKeys);
  for (const key of Object.keys(src)) {
    if (!allowed.has(key)) continue;
    next[key] = sanitizeValue(src[key]);
  }
  return next;
}

function getImportAliases(field) {
  const aliases = [field.label];
  if (field.preset !== "custom") {
    const catalog = PRESET_CATALOG[field.preset];
    if (catalog) {
      aliases.push(catalog.label, ...(catalog.aliases || []));
    }
  }
  const unique = [];
  const seen = new Set();
  for (const alias of aliases) {
    const k = normalizeKey(alias);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    unique.push(alias);
  }
  return unique;
}

async function getProfileSchema() {
  const row = await settingsService.getSettingByKey(SETTINGS_KEY);
  return normalizeSchema(row?.value);
}

async function saveProfileSchema(raw) {
  const next = validateAndNormalize(raw);
  await settingsService.upsertSetting(
    SETTINGS_KEY,
    JSON.stringify(next),
    "人員自訂欄位與列表顯示",
  );
  return next;
}

async function resolveCustomFieldsForWrite(data, existingCustomFields) {
  const incoming = Object.prototype.hasOwnProperty.call(data || {}, "customFields")
    ? data.customFields
    : Object.prototype.hasOwnProperty.call(data || {}, "custom_fields")
      ? data.custom_fields
      : undefined;
  if (incoming === undefined) return undefined;
  const schema = await getProfileSchema();
  return mergeCustomFields(
    existingCustomFields,
    incoming,
    schema.fields.map((f) => f.key),
  );
}

module.exports = {
  SETTINGS_KEY,
  MAX_ENABLED_FIELDS,
  MAX_LABEL_LENGTH,
  MAX_VALUE_LENGTH,
  PRESET_KEYS,
  PRESET_CATALOG,
  BLOOD_TYPE_SUGGESTIONS,
  TOGGLEABLE_LIST_COLUMNS,
  DEFAULT_LIST_COLUMNS,
  RESERVED_LABEL_KEYS,
  normalizeKey,
  normalizeSchema,
  validateAndNormalize,
  emptySchema,
  nextCustomKey,
  asCustomFieldsObject,
  mergeCustomFields,
  sanitizeValue,
  getImportAliases,
  getProfileSchema,
  saveProfileSchema,
  resolveCustomFieldsForWrite,
};
