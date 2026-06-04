const config = require("../../config");
const yscpPeopleFeature = require("../../utils/yscpPeopleCountingFeature");
const yscpVehicleFeature = require("../../utils/yscpVehicleAccessFeature");

/**
 * 模組 Registry（UI + route → permissionCode / featureKey）
 * 權限碼 SSOT 見 permissionCatalog.js
 */

const MODULES = [
  {
    id: 1,
    name: "設備管理",
    icon: "device",
    description: "設備管理系統",
    category: "core",
    routePrefix: "/core/device",
    featureKey: null,
    permissionCode: "system.equipment_management",
  },
  {
    id: 2,
    name: "人員管理",
    icon: "user-management",
    description: "人員管理系統",
    category: "core",
    routePrefix: "/core/personnel",
    featureKey: null,
    permissionCode: "system.personnel",
  },
  {
    id: 3,
    name: "警示紀錄",
    icon: "alert-log",
    description: "系統警示與紀錄查詢",
    category: "core",
    routePrefix: "/core/alert-log",
    featureKey: null,
    permissionCode: "system.alert_log",
  },
  {
    id: 4,
    name: "全區點位圖",
    icon: "map",
    description: "整合區域平面圖與全區點位圖的空間視覺化系統",
    category: "core",
    routePrefix: "/core/area-point-map",
    featureKey: null,
    permissionCode: "system.area_point_map",
  },
  {
    id: 5,
    name: "環境品質系統",
    icon: "environment",
    description: "環境品質監測與管理",
    category: "construction-monitoring",
    routePrefix: "/construction-monitoring/environment",
    featureKey: "environment",
    permissionCode: "system.environment",
  },
  {
    id: 6,
    name: "人流統計管理",
    icon: "people-counting",
    description: "人流統計與管理",
    category: "construction-monitoring",
    routePrefix: "/construction-monitoring/people-counting",
    featureKey: "people_counting",
    permissionCode: "system.people_counting",
  },
  {
    id: 7,
    name: "車輛進出管理",
    icon: "vehicle-access",
    description: "車輛進出管理系統",
    category: "construction-monitoring",
    routePrefix: "/construction-monitoring/vehicle-access",
    featureKey: "vehicle_access",
    permissionCode: "system.vehicle_access",
  },
  {
    id: 8,
    name: "影像監視系統",
    icon: "surveillance",
    description: "影像監視與錄影管理（整合 RTSP）",
    category: "construction-monitoring",
    routePrefix: "/construction-monitoring/surveillance",
    featureKey: "surveillance",
    permissionCode: "system.video_surveillance",
  },
  {
    id: 9,
    name: "照明系統",
    icon: "lighting",
    description: "照明設備控制與監控",
    category: "infrastructure",
    routePrefix: "/infrastructure/lighting",
    featureKey: "lighting",
    permissionCode: "system.lighting",
  },
  {
    id: 10,
    name: "空調系統",
    icon: "hvac",
    description: "空調系統控制與監控",
    category: "infrastructure",
    routePrefix: "/infrastructure/hvac",
    featureKey: "hvac",
    permissionCode: "system.hvac",
  },
  {
    id: 11,
    name: "電力系統",
    icon: "power",
    description: "電力系統監控與管理",
    category: "infrastructure",
    routePrefix: "/infrastructure/power",
    featureKey: "power",
    permissionCode: "system.power",
  },
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
    id: 13,
    name: "衛生排水系統",
    icon: "drainage",
    description: "衛生與排水系統管理",
    category: "infrastructure",
    routePrefix: "/infrastructure/drainage",
    featureKey: "drainage",
    permissionCode: "system.drainage",
  },
  {
    id: 14,
    name: "空氣循環系統",
    icon: "air-circulation",
    description: "空氣循環監控與管理",
    category: "infrastructure",
    routePrefix: "/infrastructure/air-circulation",
    featureKey: "air_circulation",
    permissionCode: "system.air_circulation",
  },
  {
    id: 15,
    name: "消防系統",
    icon: "fire",
    description: "消防設備監控與管理",
    category: "security",
    routePrefix: "/security/fire",
    featureKey: "fire",
    permissionCode: "system.fire",
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
    id: 17,
    name: "緊急求救系統",
    icon: "emergency",
    description: "緊急求救與通報系統",
    category: "security",
    routePrefix: "/security/emergency",
    featureKey: "emergency_rescue",
    permissionCode: "system.emergency_rescue",
  },
  {
    id: 18,
    name: "煙霧警報系統",
    icon: "smoke-alarm",
    description: "煙霧警報監控與管理",
    category: "security",
    routePrefix: "/security/smoke-alarm",
    featureKey: "smoke_alarm",
    permissionCode: "system.smoke_alarm",
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
  {
    id: 21,
    name: "多媒體資訊",
    icon: "video-wall",
    description: "整合電視牆模組、多媒體伺服器、資訊平台",
    category: "multimedia",
    routePrefix: "/multimedia",
    featureKey: "multimedia",
    permissionCode: "system.multimedia",
  },
];

const resolveProfile = () =>
  config?.license?.deploymentProfile === "construction"
    ? "construction"
    : "central";

const getModulesForProfile = (profile) => {
  if (profile === "construction") {
    return MODULES.filter(
      (m) =>
        (m.category === "core" || m.category === "construction-monitoring") &&
        m.routePrefix !== "/core/area-point-map",
    );
  }
  return MODULES;
};

const getRegistry = () => {
  const profile = resolveProfile();
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
  MODULES,
  getRegistry,
  getModulesForProfile,
  resolveProfile,
};
