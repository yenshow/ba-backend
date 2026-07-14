/**
 * 營運事件寫入輔助：
 * - coil 控制寫入後短窗抑制 state_change
 * - Modbus／設備反查 location／system
 * - recordControlWriteEvent
 * - 電梯雙寫略過／邏輯樓層
 */
const db = require("../../database/db");
const operationalEventService = require("./operationalEventService");
const { summaryControlWrite } = require("./operationalEventCopy");
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

// ─── control_write ───────────────────────────────────────────

/**
 * mark suppress + 反查設備／地點 + recordEvent
 * 呼叫端若需先 await 其他 I/O，請先自行 markCoilControlWrite
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
}) {
  if (!deviceConfig || address == null) return null;

  markCoilControlWrite(deviceConfig, address);
  if (Array.isArray(values)) {
    for (let i = 1; i < values.length; i++) {
      markCoilControlWrite(deviceConfig, address + i);
    }
  }

  const controlScope = String(source || "modbus").trim() || "modbus";
  const targets = await resolveControlWriteTargets({
    deviceConfig,
    deviceId,
    systemType: controlScope,
  });

  const batchCount = Array.isArray(values) ? values.length : null;
  return operationalEventService.recordEvent({
    source: controlScope,
    event_kind: "control_write",
    location_id: targets.location_id,
    system_id: targets.system_id,
    device_id: targets.device_id || deviceId,
    address,
    new_value: Boolean(value),
    bit_key: `do:${address}`,
    summary:
      summary ||
      summaryControlWrite({
        source: controlScope,
        address,
        bitKey: `do:${address}`,
        value: Boolean(value),
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
      ...(values != null ? { values } : { value: Boolean(value) }),
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
      ls.system_config
    FROM location_systems ls
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
  resolveElevatorContextByDeviceId,
  shouldOmitOperationalElevatorEvent,
  formatOperationalElevatorFloor,
  markCallElevatorForRelaySuppress,
};
