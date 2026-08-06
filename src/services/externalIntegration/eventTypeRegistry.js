/**
 * 外部整合事件類型 registry（對接／轉存共用）
 * Adapter 實作見 eventAdapters.js
 */
const { ADAPTERS } = require("./eventAdapters");

const EVENT_TYPES = Object.keys(ADAPTERS);
const EVENT_TYPE_SET = new Set(EVENT_TYPES);

function isValidEventType(raw) {
  const v = String(raw ?? "").trim();
  return EVENT_TYPE_SET.has(v) ? v : "";
}

function requireEventType(raw) {
  const v = isValidEventType(raw);
  if (!v) {
    const err = new Error(
      `不支援的 eventType（允許: ${EVENT_TYPES.join(", ")}）`,
    );
    err.code = "INVALID_EVENT_TYPE";
    err.statusCode = 400;
    throw err;
  }
  return v;
}

function getAdapter(eventType) {
  const key = requireEventType(eventType);
  const adapter = ADAPTERS[key];
  if (!adapter) {
    const err = new Error(`缺少 adapter: ${key}`);
    err.statusCode = 500;
    throw err;
  }
  return adapter;
}

function listEventTypes() {
  return EVENT_TYPES.map((id) => {
    const a = ADAPTERS[id];
    return {
      id,
      label: a?.label || id,
      filterSchema: a?.filterSchema || null,
      fields: a?.catalog || [],
    };
  });
}

module.exports = {
  ADAPTERS,
  EVENT_TYPES,
  isValidEventType,
  requireEventType,
  getAdapter,
  listEventTypes,
};
