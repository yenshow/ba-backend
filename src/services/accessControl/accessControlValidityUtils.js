/**
 * 平台 validity（config.access_control.validity）→ ISAPI Valid payload
 *
 * 規則（SSOT）：
 * - longTerm=true  => enable=false
 * - longTerm=false => enable=true
 * - begin/end 若缺漏：補 todayT00:00:00 ~ 2035-12-31T23:59:59（避免同步失敗）
 */
function buildIsapiValidPayloadFromPlatformValidity(validity) {
  const v = validity && typeof validity === "object" ? validity : null;
  const longTerm = v?.longTerm != null ? Boolean(v.longTerm) : true;
  const enable = longTerm ? false : true;
  const beginTime = v?.beginTime != null ? String(v.beginTime).trim() : "";
  const endTime = v?.endTime != null ? String(v.endTime).trim() : "";
  if (beginTime && endTime) return { enable, beginTime, endTime };
  const today = new Date().toISOString().slice(0, 10);
  return {
    enable,
    beginTime: `${today}T00:00:00`,
    endTime: "2035-12-31T23:59:59",
  };
}

module.exports = {
  buildIsapiValidPayloadFromPlatformValidity,
};

