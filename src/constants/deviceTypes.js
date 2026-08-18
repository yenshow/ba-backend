const FIXED_DEVICE_TYPES = [
  { name: "攝影機", code: "camera" },
  { name: "感測器", code: "sensor" },
  { name: "控制器", code: "controller" },
  { name: "門禁設備", code: "access_control" },
  { name: "視訊對講", code: "video_intercom" },
];

const FIXED_DEVICE_TYPE_CODES = new Set(FIXED_DEVICE_TYPES.map((t) => t.code));

function isFixedDeviceTypeCode(code) {
  return typeof code === "string" && FIXED_DEVICE_TYPE_CODES.has(code);
}

function normalizeDeviceTypeCode(code) {
  if (typeof code !== "string") return null;
  const c = code.trim();
  return isFixedDeviceTypeCode(c) ? c : null;
}

function getDeviceTypeName(code) {
  const c = normalizeDeviceTypeCode(code);
  if (!c) return String(code || "");
  return FIXED_DEVICE_TYPES.find((t) => t.code === c)?.name || c;
}

module.exports = {
  FIXED_DEVICE_TYPES,
  FIXED_DEVICE_TYPE_CODES,
  isFixedDeviceTypeCode,
  normalizeDeviceTypeCode,
  getDeviceTypeName,
};

