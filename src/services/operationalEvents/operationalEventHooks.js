/**
 * 營運事件寫入輔助：
 * - coil 控制寫入後短窗抑制 state_change
 * - Modbus／設備反查 location／system
 * - recordControlWriteEvent
 * - 電梯雙寫略過／邏輯樓層
 */
const db = require("../../database/db");
const operationalEventService = require("./operationalEventService");
const {
  summaryControlWrite,
  resolvePointLabel,
} = require("./operationalEventCopy");
const {
  loadSystemPlaceContext,
  formatPlaceLabel,
} = require("./operationalEventPlaceContext");
const { resolveDiDoParts } = require("../devices/modbusDiDoConfig");
const {
  CALL_RELAY_SUPPRESS_MS,
  isAcsDoorOpenSideEffect,
  isAcsRelayEvent,
} = require("../elevator/elevatorLogAggregation");
const {
  getElevatorConfigFromLocation,
  formatElevatorLogFloor,
} = require("../elevator/elevatorFloorModel");

// ─── coil suppress ───────────────────────────────────────────

const COIL_SUPPRESS_MS = 20_000;
/** @type {Map<string, number>} */
const suppressUntilByCoil = new Map();

const coilEndpointKey = (deviceConfig, address) => {
  const host = String(deviceConfig?.host || "").trim();
  if (!host || address == null) return null;
  const port = Number(deviceConfig.port);
  const unitId = Number(deviceConfig.unitId ?? 1);
  const addr = Number(address);
  if (
    !Number.isFinite(port) ||
    !Number.isFinite(unitId) ||
    !Number.isFinite(addr)
  ) {
    return null;
  }
  return `${host}:${port}:${unitId}:${addr}`;
};

/** 成功寫入 coil 後呼叫；須在 await 其他 I/O 之前 */
const markCoilControlWrite = (deviceConfig, address, ttlMs = COIL_SUPPRESS_MS) => {
  const key = coilEndpointKey(deviceConfig, address);
  if (!key) return;
  const ttl = Math.max(Number(ttlMs) || COIL_SUPPRESS_MS, 1_000);
  suppressUntilByCoil.set(key, Date.now() + ttl);
};

/** diDoMonitor：若近期有控制寫入則略過 state_change */
const shouldSuppressCoilStateChange = (deviceConfig, address) => {
  const key = coilEndpointKey(deviceConfig, address);
  if (!key) return false;
  const until = suppressUntilByCoil.get(key);
  if (until == null) return false;
  if (until <= Date.now()) {
    suppressUntilByCoil.delete(key);
    return false;
  }
  return true;
};

// ─── Modbus／設備反查 ────────────────────────────────────────

const toPositiveInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

async function findDeviceIdByModbusEndpoint(deviceConfig) {
  const host = String(deviceConfig?.host || "").trim();
  if (!host) return null;
  const port = String(deviceConfig.port ?? "");
  const unitId = String(deviceConfig.unitId ?? 1);

  const rows = await db.query(
    `
    SELECT d.id
    FROM devices d
    WHERE (d.config::jsonb->>'host') = ?
      AND (d.config::jsonb->>'port') = ?
      AND COALESCE(d.config::jsonb->>'unitId', '1') = ?
    ORDER BY d.id
    LIMIT 1
    `,
    [host, port, unitId],
  );
  return toPositiveInt(rows?.[0]?.id);
}

async function resolveControlWriteTargets({
  deviceConfig = null,
  deviceId = null,
  systemType = null,
} = {}) {
  let resolvedDeviceId = toPositiveInt(deviceId);
  if (!resolvedDeviceId && deviceConfig) {
    resolvedDeviceId = await findDeviceIdByModbusEndpoint(deviceConfig);
  }
  if (!resolvedDeviceId) {
    return { device_id: null, location_id: null, system_id: null };
  }

  const type = String(systemType || "").trim();
  const params = [resolvedDeviceId];
  let typeClause = "";
  if (type && type !== "modbus" && type !== "alert_linkage") {
    typeClause = "AND ls.system_type = ?";
    params.push(type);
  }

  const rows = await db.query(
    `
    SELECT ls.id AS system_id, ls.location_id
    FROM location_systems ls
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        COALESCE(ls.system_config->'device_ids', '[]'::jsonb)
      ) AS x(id)
      WHERE x.id::int = ?
    )
    ${typeClause}
    ORDER BY ls.id
    LIMIT 1
    `,
    params,
  );

  const hit = rows?.[0];
  return {
    device_id: resolvedDeviceId,
    location_id: toPositiveInt(hit?.location_id),
    system_id: toPositiveInt(hit?.system_id),
  };
}

/**
 * address → statusPoints 鍵／scale，或主 DO → 電源
 * @param {{ systemConfig: object|null, address: number, registerType: 'coil'|'holding' }} args
 */
function resolveControlPointMeta({ systemConfig, address, registerType }) {
  const addr = Number(address);
  if (!Number.isFinite(addr)) {
    return { pointKey: null, scale: null, pointLabel: null };
  }

  const cfg =
    systemConfig && typeof systemConfig === "object" ? systemConfig : {};
  // DB SSOT：status_points／modbus_config；API 入庫前可能暫存 camelCase
  const statusPoints =
    cfg.status_points && typeof cfg.status_points === "object"
      ? cfg.status_points
      : cfg.statusPoints && typeof cfg.statusPoints === "object"
        ? cfg.statusPoints
        : null;

  if (statusPoints) {
    for (const [key, def] of Object.entries(statusPoints)) {
      if (!def || typeof def !== "object") continue;
      if (Number(def.address) !== addr) continue;
      const rt = String(def.registerType || "").toLowerCase();
      if (registerType === "holding") {
        if (rt && rt !== "holding") continue;
        const scale =
          def.scale != null && Number.isFinite(Number(def.scale))
            ? Number(def.scale)
            : null;
        return {
          pointKey: key,
          scale,
          pointLabel: resolvePointLabel(key, null, addr, "holding"),
        };
      }
      // coil：discrete／coil 或未標 registerType
      if (rt === "holding" || rt === "input") continue;
      return {
        pointKey: key,
        scale: null,
        pointLabel: resolvePointLabel(key, null, addr, "coil"),
      };
    }
  }

  if (registerType === "coil") {
    const { do: doPart } = resolveDiDoParts(cfg.modbus_config || cfg.modbus);
    if (doPart && Number(doPart.address) === addr) {
      return {
        pointKey: "isOn",
        scale: null,
        pointLabel: resolvePointLabel("isOn", `do:${addr}`, addr, "coil"),
      };
    }
  }

  return { pointKey: null, scale: null, pointLabel: null };
}

function applyHoldingDisplayScale(rawValue, scale) {
  const raw = Number(rawValue);
  if (!Number.isFinite(raw)) return rawValue;
  const s = scale != null ? Number(scale) : 1;
  if (!Number.isFinite(s) || s === 0 || s === 1) return raw;
  const display = raw * s;
  return Number.isInteger(display) ? display : Math.round(display * 1000) / 1000;
}

// ─── control_write ───────────────────────────────────────────

/**
 * mark suppress（僅 coil）+ 反查設備／地點 + recordEvent
 * 呼叫端若需先 await 其他 I/O，請先自行 markCoilControlWrite
 *
 * @param {object} args
 * @param {'coil'|'holding'} [args.registerType='coil'] holding＝AO 數值寫入，不抑制 DI/DO state_change
 */
async function recordControlWriteEvent({
  deviceConfig,
  source,
  address,
  value,
  values = null,
  actorUserId = null,
  deviceId = null,
  summary = null,
  payloadExtra = null,
  refTable = null,
  refId = null,
  registerType = "coil",
}) {
  if (!deviceConfig || address == null) return null;

  const isHolding = registerType === "holding";

  if (!isHolding) {
    markCoilControlWrite(deviceConfig, address);
    if (Array.isArray(values)) {
      for (let i = 1; i < values.length; i++) {
        markCoilControlWrite(deviceConfig, address + i);
      }
    }
  }

  const controlScope = String(source || "modbus").trim() || "modbus";
  const targets = await resolveControlWriteTargets({
    deviceConfig,
    deviceId,
    systemType: controlScope,
  });

  const placeCtx = await loadSystemPlaceContext(targets.system_id);
  const pointMeta = resolveControlPointMeta({
    systemConfig: placeCtx.systemConfig,
    address,
    registerType: isHolding ? "holding" : "coil",
  });

  const batchCount = Array.isArray(values) ? values.length : null;
  const bitKey = isHolding ? `ao:${address}` : `do:${address}`;
  const rawWriteValue = isHolding
    ? values != null
      ? values[0]
      : value
    : Boolean(value);
  const displayValue = isHolding
    ? applyHoldingDisplayScale(rawWriteValue, pointMeta.scale)
    : rawWriteValue;

  const payloadValue = isHolding
    ? values != null
      ? { values }
      : { value: Number(value) }
    : values != null
      ? { values }
      : { value: Boolean(value) };

  return operationalEventService.recordEvent({
    source: controlScope,
    event_kind: "control_write",
    location_id: targets.location_id,
    system_id: targets.system_id,
    device_id: targets.device_id || deviceId,
    address,
    // new_value 欄位為 BOOLEAN；AO 數值改放 payload，此處留 null
    new_value: isHolding ? null : Boolean(value),
    bit_key: bitKey,
    summary:
      summary ||
      summaryControlWrite({
        source: controlScope,
        address,
        bitKey,
        value: displayValue,
        registerType: isHolding ? "holding" : "coil",
        placeLabel: placeCtx.placeLabel,
        pointKey: pointMeta.pointKey,
        pointLabel: pointMeta.pointLabel,
        ...(batchCount != null && batchCount > 1 ? { batchCount } : {}),
      }),
    actor_user_id: actorUserId,
    ref_table: refTable,
    ref_id: refId,
    payload: {
      host: deviceConfig.host,
      port: deviceConfig.port,
      unitId: deviceConfig.unitId,
      address,
      registerType: isHolding ? "holding" : "coil",
      ...(pointMeta.pointKey ? { pointKey: pointMeta.pointKey } : {}),
      ...(isHolding && pointMeta.scale != null && pointMeta.scale !== 1
        ? { scale: pointMeta.scale, displayValue }
        : {}),
      ...payloadValue,
      ...(payloadExtra && typeof payloadExtra === "object" ? payloadExtra : {}),
    },
  });
}

// ─── 電梯投影 ────────────────────────────────────────────────

/** @type {Map<number, { ts: number, ctx: object|null }>} */
const elevatorContextCache = new Map();
const ELEVATOR_CONTEXT_TTL_MS = 60_000;
/** @type {Map<number, number>} */
const callRelaySuppressUntil = new Map();

async function resolveElevatorContextByDeviceId(deviceId) {
  const id = Number(deviceId);
  if (!Number.isFinite(id) || id <= 0) return null;

  const cached = elevatorContextCache.get(id);
  if (cached && Date.now() - cached.ts < ELEVATOR_CONTEXT_TTL_MS) {
    return cached.ctx;
  }

  const rows = await db.query(
    `
    SELECT
      ls.id AS system_id,
      ls.location_id,
      ls.system_config,
      l.name AS location_name,
      z.name AS zone_name
    FROM location_systems ls
    LEFT JOIN locations l ON ls.location_id = l.id
    LEFT JOIN zones z ON l.zone_id = z.id
    WHERE ls.system_type = 'elevator'
      AND (
        (ls.system_config->'ladder_device'->>'device_id')::int = ?
        OR (ls.system_config->'call_device'->>'device_id')::int = ?
      )
    ORDER BY ls.id
    LIMIT 1
    `,
    [id, id],
  );

  const row = rows?.[0];
  if (!row) {
    elevatorContextCache.set(id, { ts: Date.now(), ctx: null });
    return null;
  }

  const elevCfg = getElevatorConfigFromLocation({
    systems: [{ systemType: "elevator", config: row.system_config }],
  });

  const ctx = {
    systemId: row.system_id,
    locationId: row.location_id,
    floors: elevCfg.floors || [],
    placeLabel: formatPlaceLabel(row.zone_name, row.location_name),
  };
  elevatorContextCache.set(id, { ts: Date.now(), ctx });
  return ctx;
}

const markCallElevatorForRelaySuppress = (deviceId) => {
  const id = Number(deviceId);
  if (!Number.isFinite(id) || id <= 0) return;
  callRelaySuppressUntil.set(id, Date.now() + CALL_RELAY_SUPPRESS_MS);
};

async function shouldOmitOperationalElevatorEvent({
  deviceId,
  major,
  minor,
  eventTime,
}) {
  if (isAcsDoorOpenSideEffect(major, minor)) return true;
  if (!isAcsRelayEvent(major, minor)) return false;

  const id = Number(deviceId);
  if (!Number.isFinite(id) || id <= 0) return false;

  const memUntil = callRelaySuppressUntil.get(id);
  if (memUntil != null) {
    if (memUntil > Date.now()) return true;
    callRelaySuppressUntil.delete(id);
  }

  const at = eventTime ? new Date(eventTime) : new Date();
  if (Number.isNaN(at.getTime())) return false;

  const start = new Date(at.getTime() - CALL_RELAY_SUPPRESS_MS).toISOString();
  const end = new Date(at.getTime() + CALL_RELAY_SUPPRESS_MS).toISOString();

  const rows = await db.query(
    `
    SELECT 1
    FROM ladder_sdk_events
    WHERE device_id = ?
      AND major = 3
      AND minor IN (1028, 1029)
      AND event_time >= ?
      AND event_time <= ?
    LIMIT 1
    `,
    [id, start, end],
  );

  return (rows || []).length > 0;
}

const formatOperationalElevatorFloor = (rawFloor, floors) => {
  if (rawFloor == null || rawFloor === "") return null;
  const label = formatElevatorLogFloor(rawFloor, floors || []);
  const text = label != null ? String(label).trim() : "";
  return text || String(rawFloor);
};

module.exports = {
  markCoilControlWrite,
  shouldSuppressCoilStateChange,
  recordControlWriteEvent,
  loadSystemPlaceContext,
  resolveControlPointMeta,
  resolveElevatorContextByDeviceId,
  shouldOmitOperationalElevatorEvent,
  formatOperationalElevatorFloor,
  markCallElevatorForRelaySuppress,
};
