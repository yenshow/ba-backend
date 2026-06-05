const yscpPeopleFeature = require("../utils/yscpPeopleCountingFeature");
const yscpVehicleFeature = require("../utils/yscpVehicleAccessFeature");
const {
  getCatalogModulesForProfile,
  resolveDeploymentProfile,
} = require("./catalog");

/**
 * 由 catalog 衍生模組 registry（route → permissionCode / featureKey）。
 * 無 catalog 項目的預留模組見 EXTRA_MODULES。
 */

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
  const ui = catalogMod.ui;
  if (!ui) return null;
  return {
    id: ui.id,
    name: catalogMod.name,
    icon: ui.icon,
    description: ui.description,
    category: ui.category,
    routePrefix: ui.routePrefix,
    featureKey: ui.featureKey ?? null,
    permissionCode: catalogMod.code,
    ...(ui.enabled === false ? { enabled: false } : {}),
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
