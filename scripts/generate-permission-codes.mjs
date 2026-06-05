/**
 * 由 access/catalog.js 產生兩前端 permissionCodes.ts
 * 用法：npm run gen:perm
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  getCatalogModulesForProfile,
  LOCATION_TYPE_MODULE,
} = require("../src/access/catalog.js");

const MODULE_PERM_KEYS = {
  "system.home": "home",
  "system.equipment_management": "equipment",
  "system.personnel": "personnel",
  "system.alert_log": "alertLog",
  "system.people_counting": "peopleCounting",
  "system.environment": "environment",
  "system.vehicle_access": "vehicleAccess",
  "system.video_surveillance": "videoSurveillance",
  "system.area_point_map": "areaPointMap",
  "system.lighting": "lighting",
  "system.hvac": "hvac",
  "system.power": "power",
  "system.drainage": "drainage",
  "system.air_circulation": "airCirculation",
  "system.fire": "fire",
  "system.emergency_rescue": "emergencyRescue",
  "system.smoke_alarm": "smokeAlarm",
  "system.multimedia": "multimedia",
};

const CHILD_PROP_OVERRIDES = {
  "alert.ignore": "ignore",
  "report.export": "export",
  "alert.create": "create",
  "alert.update": "update",
  "alert.delete": "delete",
  "report.full": "reportFull",
  "statistics.reset": "statisticsReset",
  "barrier.control": "barrierControl",
  "stream.control": "streamControl",
  "settings.update": "settingsUpdate",
  "zone.delete": "zoneDelete",
};

const defaultChildProp = (childCode) => {
  if (CHILD_PROP_OVERRIDES[childCode]) {
    return CHILD_PROP_OVERRIDES[childCode];
  }
  const parts = childCode.split(/[._]/);
  return parts
    .map((part, index) =>
      index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
};

const buildPermObject = (profile) => {
  const modules = getCatalogModulesForProfile(profile);
  const lines = [];

  for (const mod of modules) {
    const permKey = MODULE_PERM_KEYS[mod.code];
    if (!permKey) continue;

    const childLines = mod.children.map((child) => {
      const fullCode = `${mod.code}.${child.code}`;
      const prop = defaultChildProp(child.code);
      return `\t\t${prop}: "${fullCode}",`;
    });

    if (childLines.length === 0) {
      lines.push(`\t${permKey}: { module: "${mod.code}" },`);
      continue;
    }

    lines.push(`\t${permKey}: {`);
    lines.push(`\t\tmodule: "${mod.code}",`);
    lines.push(...childLines);
    lines.push("\t},");
  }

  return lines.join("\n");
};

const buildLocationDeleteMap = () => {
  const entries = Object.entries(LOCATION_TYPE_MODULE)
    .map(([locationType, moduleCode]) => {
      const permKey = MODULE_PERM_KEYS[moduleCode];
      if (!permKey) return null;
      return `\t${locationType}: PERM.${permKey}.locationDelete,`;
    })
    .filter(Boolean);
  return entries.join("\n");
};

const renderFile = (profile) => {
  const permBody = buildPermObject(profile);
  const locationMap =
    profile === "central"
      ? `

/** locationType（DB／API）→ 地點刪除權限碼；全區點位圖依系統刪除地點時使用 */
export const LOCATION_DELETE_BY_SYSTEM_TYPE: Record<string, string> = {
${buildLocationDeleteMap()}
}`
      : "";

  return `// AUTO-GENERATED — do not edit; run: npm run gen:perm (ba-backend)
/** Profile: ${profile} — aligned with access/catalog.js */

export const PERM = {
${permBody}
} as const${locationMap}
`;
};

const targets = [
  {
    profile: "central",
    path: join(__dirname, "../../ba-frontend-central/app/config/permissionCodes.ts"),
  },
  {
    profile: "construction",
    path: join(
      __dirname,
      "../../ba-frontend-construction/app/config/permissionCodes.ts",
    ),
  },
];

for (const { profile, path } of targets) {
  writeFileSync(path, renderFile(profile), "utf8");
  console.log(`✅ ${profile} → ${path}`);
}
