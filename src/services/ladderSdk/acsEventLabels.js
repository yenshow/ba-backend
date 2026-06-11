/** 梯控 ACS 事件顯示名稱（與 sdk/dotnet/common/AcsEventNames.cs 對齊） */
const DISPLAY_NAMES = new Map([
  ["3:1024", "操作 / 遠端開門"],
  ["3:1025", "操作 / 遠端關門"],
  ["3:1026", "操作 / 遠端常開"],
  ["3:1027", "操作 / 遠端常閉"],
  ["5:1", "事件 / 合法卡通行"],
  ["5:95", "事件 / 呼梯繼電器斷開"],
  ["5:96", "事件 / 呼梯繼電器閉合"],
  ["5:99", "事件 / 關門"],
  ["5:100", "事件 / 開門"],
]);

const LEGACY_HEX_SUFFIX = /\s*\(0x[0-9a-f]+\/0x[0-9a-f]+\)\s*$/i;

const formatAcsEventDisplayName = (eventName, major, minor) => {
  const key = `${Number(major)}:${Number(minor)}`;
  if (DISPLAY_NAMES.has(key)) return DISPLAY_NAMES.get(key);
  if (eventName == null || eventName === "") return null;
  return String(eventName).replace(LEGACY_HEX_SUFFIX, "").trim();
};

module.exports = {
  formatAcsEventDisplayName,
  ACS_DOOR_OPEN_LABEL: DISPLAY_NAMES.get("5:100"),
  ACS_DOOR_CLOSE_LABEL: DISPLAY_NAMES.get("5:99"),
};
