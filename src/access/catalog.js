/**
 * 權限目錄 SSOT（方案 A：catalog 完全主導 registry 與權限碼）
 * - 父層 system.{module}：模組進入（路由 / 模組 GET）
 * - 子層 system.{module}.{action}：細項操作
 */

const LOCATION_MUTATION_CHILDREN = [
  { code: "location.create", name: "地點新增", sort_order: 1 },
  { code: "location.update", name: "地點編輯", sort_order: 2 },
  { code: "location.delete", name: "地點刪除", sort_order: 3 },
];

const SHARED_MODULES = [
  {
    code: "system.home",
    name: "首頁設定",
    sort_order: 0,
    children: [],
  },
  {
    code: "system.equipment_management",
    name: "設備管理",
    sort_order: 1,
    children: [
      { code: "device.create", name: "設備新增", sort_order: 1 },
      { code: "device.update", name: "設備編輯", sort_order: 2 },
      { code: "device.delete", name: "設備刪除", sort_order: 3 },
    ],
  },
  {
    code: "system.personnel",
    name: "人員管理",
    sort_order: 2,
    children: [
      { code: "group.create", name: "群組新增", sort_order: 1 },
      { code: "group.update", name: "群組編輯", sort_order: 2 },
      { code: "group.delete", name: "群組刪除", sort_order: 3 },
      { code: "person.create", name: "人員新增", sort_order: 4 },
      { code: "person.update", name: "人員編輯", sort_order: 5 },
      { code: "person.delete", name: "人員刪除", sort_order: 6 },
      { code: "device_sync", name: "設備同步", sort_order: 7 },
      { code: "sync.edit", name: "同步編輯", sort_order: 8 },
    ],
  },
  {
    code: "system.alert_log",
    name: "警示紀錄",
    sort_order: 3,
    children: [
      { code: "alert.ignore", name: "警報忽視", sort_order: 1 },
      { code: "report.export", name: "報表匯出", sort_order: 2 },
      { code: "alert.create", name: "警報新增", sort_order: 3 },
      { code: "alert.update", name: "警報編輯", sort_order: 4 },
      { code: "alert.delete", name: "警報刪除", sort_order: 5 },
    ],
  },
  {
    code: "system.people_counting",
    name: "人流統計",
    sort_order: 10,
    children: [
      ...LOCATION_MUTATION_CHILDREN,
      { code: "report.full", name: "完整報表", sort_order: 4 },
    ],
  },
  {
    code: "system.environment",
    name: "環境品質",
    sort_order: 11,
    children: [
      ...LOCATION_MUTATION_CHILDREN,
      { code: "report.full", name: "完整報表", sort_order: 4 },
    ],
  },
  {
    code: "system.vehicle_access",
    name: "車輛進出",
    sort_order: 12,
    children: [
      ...LOCATION_MUTATION_CHILDREN,
      { code: "plate.manage", name: "車牌管理", sort_order: 4 },
      { code: "plate.create", name: "車牌新增", sort_order: 5 },
      { code: "plate.update", name: "車牌編輯", sort_order: 6 },
      { code: "plate.delete", name: "車牌刪除", sort_order: 7 },
      { code: "report.full", name: "完整報表", sort_order: 8 },
      { code: "statistics.reset", name: "重製統計", sort_order: 9 },
      { code: "barrier.control", name: "道閘控制", sort_order: 10 },
    ],
  },
  {
    code: "system.video_surveillance",
    name: "影像監控",
    sort_order: 13,
    children: [
      { code: "stream.control", name: "串流控制", sort_order: 1 },
    ],
  },
];

/** Central 專屬模組 */
const CENTRAL_MODULES = [
  {
    code: "system.area_point_map",
    name: "全區點位圖",
    sort_order: 4,
    children: [
      { code: "zone.delete", name: "區域刪除", sort_order: 1 },
      { code: "location.delete", name: "地點刪除", sort_order: 2 },
    ],
  },
  {
    code: "system.lighting",
    name: "照明系統",
    sort_order: 20,
    children: [
      ...LOCATION_MUTATION_CHILDREN,
      { code: "device.control", name: "開關控制", sort_order: 4 },
    ],
  },
  {
    code: "system.hvac",
    name: "空調系統",
    sort_order: 21,
    children: [
      ...LOCATION_MUTATION_CHILDREN,
      { code: "device.control", name: "開關控制", sort_order: 4 },
    ],
  },
  {
    code: "system.power",
    name: "電力系統",
    sort_order: 22,
    children: LOCATION_MUTATION_CHILDREN,
  },
  {
    code: "system.drainage",
    name: "衛生排水系統",
    sort_order: 23,
    children: LOCATION_MUTATION_CHILDREN,
  },
  {
    code: "system.air_circulation",
    name: "空氣循環系統",
    sort_order: 24,
    children: LOCATION_MUTATION_CHILDREN,
  },
  {
    code: "system.fire",
    name: "消防系統",
    sort_order: 25,
    children: LOCATION_MUTATION_CHILDREN,
  },
  {
    code: "system.emergency_rescue",
    name: "緊急求救系統",
    sort_order: 26,
    children: LOCATION_MUTATION_CHILDREN,
  },
  {
    code: "system.smoke_alarm",
    name: "煙霧警報系統",
    sort_order: 27,
    children: LOCATION_MUTATION_CHILDREN,
  },
  {
    code: "system.multimedia",
    name: "多媒體資訊",
    sort_order: 28,
    children: [
      { code: "settings.update", name: "設定編輯", sort_order: 1 },
    ],
  },
];

const MODULES = [...SHARED_MODULES, ...CENTRAL_MODULES];

const MODBUS_CONTROL_SCOPE_PERMISSION = {
  lighting: "system.lighting.device.control",
  hvac: "system.hvac.device.control",
};

const LOCATION_TYPE_MODULE = {
  people_counting: "system.people_counting",
  environment: "system.environment",
  vehicle_access: "system.vehicle_access",
  lighting: "system.lighting",
  hvac: "system.hvac",
  power: "system.power",
  drainage: "system.drainage",
  air_circulation: "system.air_circulation",
  fire: "system.fire",
  emergency_rescue: "system.emergency_rescue",
  smoke_alarm: "system.smoke_alarm",
};

const normalizeProfile = (profile) =>
  profile === "construction" ? "construction" : "central";

function getCatalogModulesForProfile(profile) {
  const p = normalizeProfile(profile);
  if (p === "construction") return SHARED_MODULES;
  return MODULES;
}

function buildPermissionSeedRows(modules) {
  const rows = [];
  for (const mod of modules) {
    rows.push({
      code: mod.code,
      category: "system",
      parent_code: null,
      name: mod.name,
      sort_order: mod.sort_order,
    });
    for (const child of mod.children) {
      rows.push({
        code: `${mod.code}.${child.code}`,
        category: "system",
        parent_code: mod.code,
        name: child.name,
        sort_order: child.sort_order,
      });
    }
  }
  return rows;
}

function getPermissionSeedRows() {
  return buildPermissionSeedRows(MODULES);
}

function getAllPermissionCodes(profile) {
  const modules =
    profile == null ? MODULES : getCatalogModulesForProfile(profile);
  return buildPermissionSeedRows(modules).map((r) => r.code);
}

function resolveDeploymentProfile() {
  try {
    const config = require("../config");
    return config?.license?.deploymentProfile === "construction"
      ? "construction"
      : "central";
  } catch {
    return "central";
  }
}

function getPermissionCodesForDeployment() {
  return getAllPermissionCodes(resolveDeploymentProfile());
}

/** 首頁／儀表板外觀設定（system_settings key）與 RBAC 對齊 */
const HOME_SETTINGS_PERMISSION = "system.home";

const isHomeAppearanceSettingKey = (key) => {
  if (key == null || typeof key !== "string") return false;
  return key === "safety_banner_message" || key.startsWith("home_");
};

module.exports = {
  LOCATION_TYPE_MODULE,
  MODBUS_CONTROL_SCOPE_PERMISSION,
  HOME_SETTINGS_PERMISSION,
  isHomeAppearanceSettingKey,
  getCatalogModulesForProfile,
  getPermissionSeedRows,
  getAllPermissionCodes,
  resolveDeploymentProfile,
  getPermissionCodesForDeployment,
};
