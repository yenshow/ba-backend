/**
 * 衛生排水：依 location_systems 設定讀取 Modbus 並合成 uiStatus（單點失敗不影響其他設備）
 */

const locationService = require("./locationService");
const deviceService = require("../devices/deviceService");
const modbusClient = require("../devices/modbusClient");
const alertService = require("../alerts/alertService");
const systemAlert = require("../alerts/systemAlertHelper");
const alertRuleService = require("../alerts/alertRuleService");

const REGISTER_READERS = {
  coil: (address, length, deviceConfig) =>
    modbusClient.readCoils(address, length, deviceConfig),
  discrete: (address, length, deviceConfig) =>
    modbusClient.readDiscreteInputs(address, length, deviceConfig),
  holding: (address, length, deviceConfig) =>
    modbusClient.readHoldingRegisters(address, length, deviceConfig),
  input: (address, length, deviceConfig) =>
    modbusClient.readInputRegisters(address, length, deviceConfig),
};

const BIT_KEY_TO_ALERT_TYPE = {
  runningAlarm: alertService.ALERT_TYPES.ERROR,
  coverAlarm: alertService.ALERT_TYPES.ERROR,
  highLevel: alertService.ALERT_TYPES.THRESHOLD,
  lowLevel: alertService.ALERT_TYPES.THRESHOLD,
};

const defaultDimensionKeyForDrainageBit = (bitKey) => {
  const k = String(bitKey || "").trim();
  if (!k) return "drainage:bit_state";
  return `drainage:${k}`;
};

function parseInlineModbus(modbus) {
  if (!modbus || typeof modbus !== "object") return null;
  const { host, port, unitId = 1 } = modbus;
  if (!host || port === undefined || port === null) return null;
  return { host, port: Number(port), unitId: Number(unitId) };
}

async function resolveDeviceConfig(deviceId, modbus) {
  if (deviceId != null && deviceId !== "") {
    try {
      const { device } = await deviceService.getDeviceById(Number(deviceId));
      const c = device.config || {};
      if (c.host != null && c.port !== undefined && c.port !== null) {
        return {
          host: c.host,
          port: Number(c.port),
          unitId: Number(c.unitId ?? 1),
        };
      }
    } catch (_) {
      /* 設備不存在或離線時改試 inline */
    }
  }
  return parseInlineModbus(modbus);
}

function normalizeRegisterType(pointDef) {
  let registerType = String(pointDef.registerType || pointDef.type || "")
    .toLowerCase()
    .trim();
  if (registerType === "di") registerType = "discrete";
  if (registerType === "do") registerType = "coil";
  return registerType;
}

async function readStatusPoint(deviceConfig, pointDef) {
  if (!pointDef || typeof pointDef !== "object") return null;
  const registerType = normalizeRegisterType(pointDef);
  const address = Number(pointDef.address);
  const length = pointDef.length != null ? Number(pointDef.length) : 1;
  if (!Number.isFinite(address) || address < 0) return null;
  if (!REGISTER_READERS[registerType]) return null;

  const data = await REGISTER_READERS[registerType](
    address,
    length,
    deviceConfig,
  );
  if (!data || !data.length) return null;
  const v = data[0];
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return Boolean(v);
}

/**
 * 讀取 statusPoints 物件中每個鍵對應的點位（可每點獨立 deviceId），失敗的鍵略過
 */
async function readAllPoints(statusPoints, cfgDeviceId, cfgModbus) {
  const raw = {};
  if (!statusPoints || typeof statusPoints !== "object") {
    return raw;
  }
  for (const key of Object.keys(statusPoints)) {
    const def = statusPoints[key];
    if (!def || typeof def !== "object") continue;
    let pointDeviceConfig = null;
    try {
      const ownId = def.deviceId != null && def.deviceId !== "";
      pointDeviceConfig = ownId
        ? await resolveDeviceConfig(Number(def.deviceId), def.modbus || null)
        : await resolveDeviceConfig(cfgDeviceId, cfgModbus);
    } catch (_) {
      pointDeviceConfig = null;
    }
    if (!pointDeviceConfig) {
      raw[key] = undefined;
      continue;
    }
    try {
      const val = await readStatusPoint(pointDeviceConfig, def);
      if (val !== null) raw[key] = val;
    } catch (_) {
      raw[key] = undefined;
    }
  }
  return raw;
}

async function hasResolvableDeviceForPoints(statusPoints, cfgDeviceId, cfgModbus) {
  const keys = Object.keys(statusPoints || {}).filter(
    (k) => statusPoints[k] && typeof statusPoints[k] === "object",
  );
  if (keys.length === 0) {
    try {
      return Boolean(await resolveDeviceConfig(cfgDeviceId, cfgModbus));
    } catch (_) {
      return false;
    }
  }
  for (const key of keys) {
    const def = statusPoints[key];
    let c = null;
    try {
      const ownId = def.deviceId != null && def.deviceId !== "";
      c = ownId
        ? await resolveDeviceConfig(Number(def.deviceId), def.modbus || null)
        : await resolveDeviceConfig(cfgDeviceId, cfgModbus);
    } catch (_) {
      c = null;
    }
    if (c) return true;
  }
  return false;
}

/**
 * 產品語意（馬達／液位一致方向）：
 * - 串接點「觸發」警報條件（例如 running=true、highLevel=true）→ alarm（警報）
 * - 無法取得控制器連線或已設定點位但讀值全失敗 → warning（異常：視為未連線／通訊失敗）
 * - 其餘有成功讀值且無警報 → normal
 */
function deriveUiStatus(equipmentKind, raw, hadDeviceConfig, pointKeysConfigured) {
  if (!hadDeviceConfig) return "warning";
  if (!pointKeysConfigured || pointKeysConfigured.length === 0) return "unknown";

  const kind = equipmentKind === "tank" ? "tank" : "pump";

  const anyRead = pointKeysConfigured.some(
    (k) => raw[k] !== undefined && raw[k] !== null,
  );
  if (!anyRead) return "warning";

  if (kind === "pump") {
    if (raw.fault === true) return "alarm";
    if (raw.running === true) return "alarm";
    return "normal";
  }

  if (raw.coverAlarm === true || raw.highLevel === true) return "alarm";
  if (raw.levelOk === false) return "alarm";
  if (raw.lowLevel === true) return "alarm";
  return "normal";
}

async function syncStatefulDrainageAlerts(systemId, raw) {
  const rules = await alertRuleService.getDrainageBitStateRulesForSystem(systemId);
  for (const r of rules) {
    const bitKey = r?.condition_config?.bit_key;
    if (!bitKey) continue;
    const bitValue = raw[bitKey];
    if (bitValue === undefined || bitValue === null) continue;

    const alertType =
      BIT_KEY_TO_ALERT_TYPE[bitKey] || alertService.ALERT_TYPES.ERROR;
    const dimensionKey = r.dimension_key || defaultDimensionKeyForDrainageBit(bitKey);
    const severity = r.severity || alertService.SEVERITIES.WARNING;
    const message =
      r.message_template ||
      r.name ||
      `排水警報觸發（${String(bitKey)}），請檢查設備狀態`;

    if (bitValue === true) {
      await alertService.createAlert({
        source: alertService.ALERT_SOURCES.DRAINAGE,
        source_id: systemId,
        alert_type: alertType,
        dimension_key: dimensionKey,
        severity,
        message,
        rule_id: r.id,
      });
      continue;
    }

    try {
      await alertService.resolveAlert(
        systemId,
        alertType,
        alertService.ALERT_SOURCES.DRAINAGE,
        dimensionKey,
      );
    } catch (error) {
      if (!String(error.message || "").includes("未找到可更新的警報")) {
        throw error;
      }
    }
  }
}

async function syncDrainageConnectivityAlert(
  systemId,
  hadDeviceConfig,
  pointKeys,
  raw,
  readError,
) {
  if (!hadDeviceConfig || !pointKeys || pointKeys.length === 0) {
    return;
  }

  const anyRead = pointKeys.some((k) => raw[k] !== undefined && raw[k] !== null);
  const hasConnectionFailure = !anyRead;

  if (hasConnectionFailure) {
    const errorMessage = readError || "無法讀取排水設備資料";
    await systemAlert.recordError("drainage", systemId, errorMessage);
    return;
  }

  await systemAlert.clearError("drainage", systemId);
}

async function buildItemForDrainageSystem(zone, location, system) {
  const cfg = system.config || {};
  const deviceId = cfg.deviceId;
  const modbus = cfg.modbus;
  const equipmentKind = cfg.equipmentKind || "pump";
  const viewCategory = cfg.viewCategory || "drainage";
  const statusPoints = cfg.statusPoints || {};

  const pointKeys = Object.keys(statusPoints).filter(
    (k) => statusPoints[k] && typeof statusPoints[k] === "object",
  );

  const hadDeviceConfig = await hasResolvableDeviceForPoints(
    statusPoints,
    deviceId,
    modbus,
  );
  let raw = {};
  let readError = null;
  if (pointKeys.length > 0) {
    try {
      raw = await readAllPoints(statusPoints, deviceId, modbus);
    } catch (err) {
      readError = err.message || String(err);
      raw = {};
    }
  }
  if (!hadDeviceConfig) {
    readError = "無可用控制器連線設定（deviceId 或 modbus.host/port）";
  }

  const uiStatus = deriveUiStatus(
    equipmentKind,
    raw,
    hadDeviceConfig,
    pointKeys,
  );

  try {
    await syncDrainageConnectivityAlert(
      Number(system.id),
      hadDeviceConfig,
      pointKeys,
      raw,
      readError,
    );
    await syncStatefulDrainageAlerts(Number(system.id), raw);
  } catch (alertErr) {
    if (process.env.NODE_ENV === "development") {
      console.warn(
        `[drainageStatusService] 同步警報失敗 (systemId: ${system.id}): ${alertErr.message}`,
      );
    }
  }

  return {
    zoneId: String(zone.id),
    zoneName: zone.name,
    locationId: String(location.id),
    locationName: location.name,
    systemId: String(system.id),
    equipmentKind,
    viewCategory,
    uiStatus,
    raw,
    ...(readError ? { error: readError } : {}),
  };
}

function collectDrainageItemsFromZones(zones) {
  const items = [];
  for (const zone of zones) {
    const locs = zone.locations || [];
    for (const loc of locs) {
      const systems = loc.systems || [];
      for (const sys of systems) {
        if (sys.systemType === "drainage") {
          items.push({ zone, location: loc, system: sys });
        }
      }
    }
  }
  return items;
}

async function getStatusSnapshot(query = {}) {
  const zoneIdsFilter = query.zoneIds;
  const result = await locationService.getZones({ locationType: "drainage" });
  let zones = result.zones || [];

  if (zoneIdsFilter != null && zoneIdsFilter.length > 0) {
    const want = new Set(zoneIdsFilter.map((id) => String(id)));
    zones = zones.filter((z) => want.has(String(z.id)));
  }

  const triples = collectDrainageItemsFromZones(zones);
  const items = await Promise.all(
    triples.map(({ zone, location, system }) =>
      buildItemForDrainageSystem(zone, location, system),
    ),
  );

  return { items };
}

async function getZoneStatusSnapshot(zoneId) {
  const result = await locationService.getZoneById(zoneId, "drainage");
  const zone = result.zone;
  const triples = collectDrainageItemsFromZones([zone]);
  const items = await Promise.all(
    triples.map(({ zone: z, location, system }) =>
      buildItemForDrainageSystem(z, location, system),
    ),
  );
  return { zoneId: String(zone.id), items };
}

module.exports = {
  getStatusSnapshot,
  getZoneStatusSnapshot,
};
