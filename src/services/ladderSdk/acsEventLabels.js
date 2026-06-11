/** 梯控 ACS 事件顯示名稱（與 sdk/dotnet/common/AcsEventNames.cs 對齊） */
const DISPLAY_NAMES = new Map([
  ["3:1024", "遠端開門"],
  ["3:1025", "遠端關門"],
  ["3:1026", "遠端常開"],
  ["3:1027", "遠端常閉"],
  ["5:1", "合法卡通行"],
  ["5:95", "呼梯繼電器斷開"],
  ["5:96", "呼梯繼電器閉合"],
  ["5:99", "關門"],
  ["5:100", "開門"],
]);

const LEGACY_HEX_SUFFIX = /\s*\(0x[0-9a-f]+\/0x[0-9a-f]+\)\s*$/i;
const LEGACY_MAJOR_PREFIX = /^(操作|事件)\s*\/\s*/;

const stripLegacyEventLabel = (text) =>
  String(text).replace(LEGACY_HEX_SUFFIX, "").replace(LEGACY_MAJOR_PREFIX, "").trim();

const formatAcsEventDisplayName = (eventName, major, minor) => {
  const key = `${Number(major)}:${Number(minor)}`;
  if (DISPLAY_NAMES.has(key)) return DISPLAY_NAMES.get(key);
  if (eventName == null || eventName === "") return null;
  return stripLegacyEventLabel(eventName);
};

module.exports = {
  formatAcsEventDisplayName,
  ACS_DOOR_OPEN_LABEL: DISPLAY_NAMES.get("5:100"),
  ACS_DOOR_CLOSE_LABEL: DISPLAY_NAMES.get("5:99"),
};
