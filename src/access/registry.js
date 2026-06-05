const yscpPeopleFeature = require("../utils/yscpPeopleCountingFeature");
const yscpVehicleFeature = require("../utils/yscpVehicleAccessFeature");
const {
  getCatalogModulesForProfile,
  resolveDeploymentProfile,
} = require("./catalog");

/**
 * UI 欄位（icon、route、featureKey）；權限碼與名稱由 catalog 主導。
 * 無對應 catalog 項目的模組見 EXTRA_MODULES。
 */
const MODULE_UI = {
  "system.equipment_management": {
    id: 1,
    icon: "device",
    description: "設備管理系統",
    category: "core",
    routePrefix: "/core/device",
    featureKey: null,
  },
  "system.personnel": {
    id: 2,
    icon: "user-management",
    description: "人員管理系統",
    category: "core",
    routePrefix: "/core/personnel",
    featureKey: null,
  },
  "system.alert_log": {
    id: 3,
    icon: "alert-log",
    description: "系統警示與紀錄查詢",
    category: "core",
    routePrefix: "/core/alert-log",
    featureKey: null,
  },
  "system.area_point_map": {
    id: 4,
    icon: "map",
    description: "整合區域平面圖與全區點位圖的空間視覺化系統",
    category: "core",
    routePrefix: "/core/area-point-map",
    featureKey: null,
  },
  "system.environment": {
    id: 5,
    icon: "environment",
    description: "環境品質監測與管理",
    category: "construction-monitoring",
    routePrefix: "/construction-monitoring/environment",
    featureKey: "environment",
  },
  "system.people_counting": {
    id: 6,
    icon: "people-counting",
    description: "人流統計與管理",
    category: "construction-monitoring",
    routePrefix: "/construction-monitoring/people-counting",
    featureKey: "people_counting",
  },
  "system.vehicle_access": {
    id: 7,
    icon: "vehicle-access",
    description: "車輛進出管理系統",
    category: "construction-monitoring",
    routePrefix: "/construction-monitoring/vehicle-access",
    featureKey: "vehicle_access",
  },
  "system.video_surveillance": {
    id: 8,
    icon: "surveillance",
    description: "影像監視與錄影管理（整合 RTSP）",
    category: "construction-monitoring",
    routePrefix: "/construction-monitoring/surveillance",
    featureKey: "surveillance",
  },
  "system.lighting": {
    id: 9,
    icon: "lighting",
    description: "照明設備控制與監控",
    category: "infrastructure",
    routePrefix: "/infrastructure/lighting",
    featureKey: "lighting",
  },
  "system.hvac": {
    id: 10,
    icon: "hvac",
    description: "空調系統控制與監控",
    category: "infrastructure",
    routePrefix: "/infrastructure/hvac",
    featureKey: "hvac",
  },
  "system.power": {
    id: 11,
    icon: "power",
    description: "電力系統監控與管理",
    category: "infrastructure",
    routePrefix: "/infrastructure/power",
    featureKey: "power",
  },
  "system.drainage": {
    id: 13,
    icon: "drainage",
    description: "衛生與排水系統管理",
    category: "infrastructure",
    routePrefix: "/infrastructure/drainage",
    featureKey: "drainage",
  },
  "system.air_circulation": {
    id: 14,
    icon: "air-circulation",
    description: "空氣循環監控與管理",
    category: "infrastructure",
    routePrefix: "/infrastructure/air-circulation",
    featureKey: "air_circulation",
  },
  "system.fire": {
    id: 15,
    icon: "fire",
    description: "消防設備監控與管理",
    category: "security",
    routePrefix: "/security/fire",
    featureKey: "fire",
  },
  "system.emergency_rescue": {
    id: 17,
    icon: "emergency",
    description: "緊急求救與通報系統",
    category: "security",
    routePrefix: "/security/emergency",
    featureKey: "emergency_rescue",
  },
  "system.smoke_alarm": {
    id: 18,
    icon: "smoke-alarm",
    description: "煙霧警報監控與管理",
    category: "security",
    routePrefix: "/security/smoke-alarm",
    featureKey: "smoke_alarm",
  },
  "system.multimedia": {
    id: 21,
    icon: "video-wall",
    description: "整合電視牆模組、多媒體伺服器、資訊平台",
    category: "multimedia",
    routePrefix: "/multimedia",
    featureKey: "multimedia",
  },
};

/** 無 catalog 權限碼的預留模組（僅 UI／導覽） */
const EXTRA_MODULES = [
  {
    id: 12,
    name: "電梯系統",
    icon: "elevator",
    description: "電梯系統監控與管理",
    category: "infrastructure",
    routePrefix: "/infrastructure/elevator",
    featureKey: null,
    permissionCode: null,
    enabled: false,
  },
  {
    id: 16,
    name: "門禁保全系統",
    icon: "security",
    description: "門禁與保全系統管理",
    category: "security",
    routePrefix: "/security/access-control",
    featureKey: null,
    permissionCode: null,
    enabled: false,
  },
  {
    id: 19,
    name: "訪客系統",
    icon: "visitor",
    description: "訪客登記與管理",
    category: "business",
    routePrefix: "/business/visitor",
    featureKey: null,
    permissionCode: null,
  },
  {
    id: 20,
    name: "寄物管理",
    icon: "locker-management",
    description: "寄物櫃管理系統",
    category: "business",
    routePrefix: "/business/locker-management",
    featureKey: null,
    permissionCode: null,
  },
];

const isCategoryVisibleForProfile = (category, profile) => {
  if (profile === "central") return true;
  return category === "core" || category === "construction-monitoring";
};

const mergeCatalogModule = (catalogMod) => {
  const ui = MODULE_UI[catalogMod.code];
  if (!ui) return null;
  return {
    id: ui.id,
    name: catalogMod.name,
    icon: ui.icon,
    description: ui.description,
    category: ui.category,
    routePrefix: ui.routePrefix,
    featureKey: ui.featureKey,
    permissionCode: catalogMod.code,
  };
};

const getModulesForProfile = (profile) => {
  const p = profile === "construction" ? "construction" : "central";
  const fromCatalog = getCatalogModulesForProfile(p)
    .map(mergeCatalogModule)
    .filter(Boolean)
    .filter((m) => isCategoryVisibleForProfile(m.category, p));

  const extras =
    p === "central"
      ? EXTRA_MODULES
      : EXTRA_MODULES.filter((m) =>
          isCategoryVisibleForProfile(m.category, p),
        );

  return [...fromCatalog, ...extras].sort((a, b) => a.id - b.id);
};

const getRegistry = () => {
  const profile = resolveDeploymentProfile();
  return {
    profile,
    modules: getModulesForProfile(profile),
    serverFeatures: {
      enableYscpPeopleCounting: yscpPeopleFeature.isEnabled(),
      enableYscpVehicleAccess: yscpVehicleFeature.isEnabled(),
    },
  };
};

module.exports = {
  getRegistry,
};
