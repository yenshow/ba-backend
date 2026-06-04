/**
 * 權限目錄 SSOT（與 moduleRegistry.permissionCode 對齊）
 * - 父層 system.{module}：模組進入（路由 / 模組 GET）
 * - 子層 system.{module}.{action}：細項操作
 * - Central 基礎設施／安防快照子系統（照明、排水等）：僅父層；區域 CRUD 另由後端 requireAdmin 保護
 */

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
      { code: "location.create", name: "地點新增", sort_order: 1 },
      { code: "location.update", name: "地點編輯", sort_order: 2 },
      { code: "location.delete", name: "地點刪除", sort_order: 3 },
      { code: "report.full", name: "完整報表", sort_order: 4 },
      { code: "report.export", name: "報表匯出", sort_order: 5 },
    ],
  },
  {
    code: "system.environment",
    name: "環境品質",
    sort_order: 11,
    children: [
      { code: "location.create", name: "地點新增", sort_order: 1 },
      { code: "location.update", name: "地點編輯", sort_order: 2 },
      { code: "location.delete", name: "地點刪除", sort_order: 3 },
      { code: "report.full", name: "完整報表", sort_order: 4 },
      { code: "report.export", name: "報表匯出", sort_order: 5 },
    ],
  },
  {
    code: "system.vehicle_access",
    name: "車輛進出",
    sort_order: 12,
    children: [
      { code: "location.create", name: "地點新增", sort_order: 1 },
      { code: "location.update", name: "地點編輯", sort_order: 2 },
      { code: "location.delete", name: "地點刪除", sort_order: 3 },
      { code: "plate.manage", name: "車牌管理", sort_order: 4 },
      { code: "plate.create", name: "車牌新增", sort_order: 5 },
      { code: "plate.update", name: "車牌編輯", sort_order: 6 },
      { code: "plate.delete", name: "車牌刪除", sort_order: 7 },
      { code: "report.full", name: "完整報表", sort_order: 8 },
      { code: "report.export", name: "報表匯出", sort_order: 9 },
      { code: "statistics.reset", name: "重製統計", sort_order: 10 },
      { code: "barrier.control", name: "道閘控制", sort_order: 11 },
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

/** Central 專屬模組（moduleRegistry central profile） */
const CENTRAL_MODULES = [
  {
    code: "system.area_point_map",
    name: "全區點位圖",
    sort_order: 4,
    children: [
      { code: "zone.create", name: "區域新增", sort_order: 1 },
      { code: "zone.update", name: "區域編輯", sort_order: 2 },
      { code: "zone.delete", name: "區域刪除", sort_order: 3 },
      { code: "location.delete", name: "地點刪除", sort_order: 4 },
    ],
  },
  {
    code: "system.lighting",
    name: "照明系統",
    sort_order: 20,
    children: [],
  },
  {
    code: "system.hvac",
    name: "空調系統",
    sort_order: 21,
    children: [],
  },
  {
    code: "system.power",
    name: "電力系統",
    sort_order: 22,
    children: [],
  },
  {
    code: "system.drainage",
    name: "衛生排水系統",
    sort_order: 23,
    children: [],
  },
  {
    code: "system.air_circulation",
    name: "空氣循環系統",
    sort_order: 24,
    children: [],
  },
  {
    code: "system.fire",
    name: "消防系統",
    sort_order: 25,
    children: [],
  },
  {
    code: "system.emergency_rescue",
    name: "緊急求救系統",
    sort_order: 26,
    children: [],
  },
  {
    code: "system.smoke_alarm",
    name: "煙霧警報系統",
    sort_order: 27,
    children: [],
  },
  {
    code: "system.multimedia",
    name: "多媒體資訊",
    sort_order: 28,
    children: [],
  },
];

const MODULES = [...SHARED_MODULES, ...CENTRAL_MODULES];

const normalizeProfile = (profile) =>
  profile === "construction" ? "construction" : "central";

/** 依部署樣貌回傳可設定／可生效的模組（與 moduleRegistryService profile 對齊） */
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

/** 扁平種子列（initSchema / sync 用；含 Central，單一 DB 部署兩產品線） */
function getPermissionSeedRows() {
  return buildPermissionSeedRows(MODULES);
}

function getPermissionSeedRowsForProfile(profile) {
  return buildPermissionSeedRows(getCatalogModulesForProfile(profile));
}

/** 部署樣貌下合法權限碼（含父層）；未傳 profile 時等同 central 全量（僅種子／遷移） */
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

/** 目前後端實例的權限碼集合（與 LICENSE_DEPLOYMENT_PROFILE 一致） */
function getPermissionCodesForDeployment() {
  return getAllPermissionCodes(resolveDeploymentProfile());
}

module.exports = {
  MODULES,
  SHARED_MODULES,
  CENTRAL_MODULES,
  normalizeProfile,
  getCatalogModulesForProfile,
  getPermissionSeedRows,
  getPermissionSeedRowsForProfile,
  getAllPermissionCodes,
  resolveDeploymentProfile,
  getPermissionCodesForDeployment,
};
