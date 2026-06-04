/** 首頁／儀表板外觀設定（system_settings key）與 RBAC 對齊 */

const HOME_SETTINGS_PERMISSION = "system.home";

const isHomeAppearanceSettingKey = (key) => {
  if (key == null || typeof key !== "string") return false;
  return key === "safety_banner_message" || key.startsWith("home_");
};

module.exports = {
  HOME_SETTINGS_PERMISSION,
  isHomeAppearanceSettingKey,
};
