/**
 * 衛生排水：依 location_systems 設定讀取 Modbus 並合成 uiStatus（單點失敗不影響其他設備）
 */

const locationService = require("./locationService");
const deviceService = require("../devices/deviceService");
const modbusClient = require("../devices/modbusClient");

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

async function readStatusPoint(deviceConfig, pointDef) {
  if (!pointDef || typeof pointDef !== "object") return null;
  const registerType = String(pointDef.registerType || pointDef.type || "")
    .toLowerCase()
    .trim();
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
 * 讀取 statusPoints 物件中每個鍵對應的點位，失敗的鍵略過
 */
async function readAllPoints(deviceConfig, statusPoints) {
  const raw = {};
  if (!statusPoints || typeof statusPoints !== "object") {
    return raw;
  }
  for (const key of Object.keys(statusPoints)) {
    try {
      const val = await readStatusPoint(deviceConfig, statusPoints[key]);
      if (val !== null) raw[key] = val;
    } catch (_) {
      raw[key] = undefined;
    }
  }
  return raw;
}

/**
 * pump：fault=true → alarm；running=false → warning；無點位 → unknown
 * tank：coverAlarm／highLevel／levelOk=false → alarm；lowLevel → warning
 */
function deriveUiStatus(equipmentKind, raw, hadDeviceConfig, pointKeysConfigured) {
  if (!hadDeviceConfig) return "offline";
  if (!pointKeysConfigured || pointKeysConfigured.length === 0) return "unknown";

  const kind = equipmentKind === "tank" ? "tank" : "pump";

  if (kind === "pump") {
    if (raw.fault === true) return "alarm";
    if (raw.running === false) return "warning";
    const anyRead = pointKeysConfigured.some(
      (k) => raw[k] !== undefined && raw[k] !== null,
    );
    return anyRead ? "normal" : "offline";
  }

  if (raw.coverAlarm === true || raw.highLevel === true) return "alarm";
  if (raw.levelOk === false) return "alarm";
  if (raw.lowLevel === true) return "warning";
  const anyRead = pointKeysConfigured.some(
    (k) => raw[k] !== undefined && raw[k] !== null,
  );
  return anyRead ? "normal" : "offline";
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

  let deviceConfig = null;
  try {
    deviceConfig = await resolveDeviceConfig(deviceId, modbus);
  } catch (_) {
    deviceConfig = null;
  }

  const hadDeviceConfig = Boolean(deviceConfig);
  let raw = {};
  let readError = null;
  if (deviceConfig && pointKeys.length > 0) {
    try {
      raw = await readAllPoints(deviceConfig, statusPoints);
    } catch (err) {
      readError = err.message || String(err);
      raw = {};
    }
  } else if (!deviceConfig) {
    readError = "無可用控制器連線設定（deviceId 或 modbus.host/port）";
  }

  const uiStatus = deriveUiStatus(
    equipmentKind,
    raw,
    hadDeviceConfig,
    pointKeys,
  );

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
