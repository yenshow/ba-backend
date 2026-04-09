const db = require("../../database/db");
const { getDeviceById } = require("../devices/deviceService");
const modbusClient = require("../devices/modbusClient");
const modbusBatchService = require("../devices/modbusBatchService");
const logger = require("../../utils/logger");

const linkageLogger = logger.createLogger("alertLinkageService");

const SEVERITY_RANK = {
  warning: 1,
  error: 2,
  critical: 3,
};

const isSeverityAtLeast = (severity, minSeverity) => {
  const s = SEVERITY_RANK[String(severity || "").toLowerCase()] || 0;
  const m = SEVERITY_RANK[String(minSeverity || "").toLowerCase()] || 0;
  return s >= m;
};

const nowIso = () => new Date().toISOString();

const autoOffTimers = new Map(); // key -> Timeout
const buildDoKey = (doDeviceId, doAddress) => `${Number(doDeviceId)}:${Number(doAddress)}`;

const deviceCfgCache = new Map(); // deviceId -> { ts, cfg }
const DEVICE_CFG_TTL_MS = 60_000;

async function resolveDeviceConfig(deviceId) {
  if (!deviceId) return null;
  const id = Number(deviceId);
  const cached = deviceCfgCache.get(id);
  if (cached && Date.now() - cached.ts < DEVICE_CFG_TTL_MS) return cached.cfg;

  const { device } = await getDeviceById(id);
  const c = device?.config || {};
  if (!c.host || c.port == null) return null;
  const cfg = {
    host: String(c.host),
    port: Number(c.port),
    unitId: Number(c.unitId ?? 1),
  };
  deviceCfgCache.set(id, { ts: Date.now(), cfg });
  return cfg;
}

async function hasActiveManualOffOverride(doDeviceId, doAddress) {
  if (!doDeviceId && doDeviceId !== 0) return false;
  if (!Number.isInteger(Number(doAddress))) return false;

  const rows = await db.query(
    `
      SELECT 1
      FROM do_output_overrides
      WHERE do_device_id = ?
        AND do_address = ?
        AND mode = 'manual_off'
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `,
    [Number(doDeviceId), Number(doAddress)],
  );

  return Array.isArray(rows) && rows.length > 0;
}

async function insertExecution({
  linkageId,
  alertId = null,
  executionType,
  doDeviceId = null,
  doAddress = null,
  doValue = null,
  success,
  errorMessage = null,
  createdBy = null,
}) {
  await db.query(
    `
      INSERT INTO alert_linkage_executions (
        linkage_id,
        alert_id,
        execution_type,
        do_device_id,
        do_address,
        do_value,
        success,
        error_message,
        created_by,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `,
    [
      Number(linkageId),
      alertId != null ? Number(alertId) : null,
      String(executionType),
      doDeviceId != null ? Number(doDeviceId) : null,
      doAddress != null ? Number(doAddress) : null,
      typeof doValue === "boolean" ? doValue : null,
      Boolean(success),
      errorMessage ? String(errorMessage) : null,
      createdBy != null ? Number(createdBy) : null,
    ],
  );
}

async function writeDo({
  linkageId,
  alertId = null,
  executionType,
  doDeviceId,
  doAddress,
  doValue,
  createdBy = null,
}) {
  const cfg = await resolveDeviceConfig(doDeviceId);
  if (!cfg) {
    const msg = `DO 設備連線設定不足 (device_id=${doDeviceId})`;
    await insertExecution({
      linkageId,
      alertId,
      executionType,
      doDeviceId,
      doAddress,
      doValue,
      success: false,
      errorMessage: msg,
      createdBy,
    });
    return { success: false, error: msg };
  }

  try {
    const ok = await modbusClient.writeCoil(Number(doAddress), Boolean(doValue), cfg);
    if (ok) {
      modbusBatchService.invalidateDeviceCache(cfg, "coil");
    }
    await insertExecution({
      linkageId,
      alertId,
      executionType,
      doDeviceId,
      doAddress,
      doValue,
      success: Boolean(ok),
      errorMessage: ok ? null : "writeCoil 回傳失敗",
      createdBy,
    });
    return { success: Boolean(ok) };
  } catch (err) {
    const msg = err?.message || String(err);
    await insertExecution({
      linkageId,
      alertId,
      executionType,
      doDeviceId,
      doAddress,
      doValue,
      success: false,
      errorMessage: msg,
      createdBy,
    });
    return { success: false, error: msg };
  }
}

function scheduleAutoOff({ linkage, alertId = null, createdBy = null }) {
  const seconds = linkage?.auto_off_seconds;
  if (!Number.isInteger(Number(seconds)) || Number(seconds) <= 0) return;

  const doDeviceId = linkage?.do_device_id;
  const doAddress = linkage?.do_address;
  if (doDeviceId == null || doAddress == null) return;

  const key = buildDoKey(doDeviceId, doAddress);
  const existing = autoOffTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    autoOffTimers.delete(key);
  }

  const timeout = setTimeout(async () => {
    autoOffTimers.delete(key);
    const offValue = !Boolean(linkage.do_value);
    try {
      await writeDo({
        linkageId: linkage.id,
        alertId,
        executionType: "auto_off",
        doDeviceId,
        doAddress,
        doValue: offValue,
        createdBy,
      });
    } catch (err) {
      linkageLogger.warn("auto_off 執行失敗", {
        linkageId: linkage?.id,
        doDeviceId,
        doAddress,
        error: err?.message || String(err),
      });
    }
  }, Number(seconds) * 1000);

  autoOffTimers.set(key, timeout);
}

async function listLinkages() {
  const rows = await db.query(
    `
      SELECT *
      FROM alert_linkages
      ORDER BY id DESC
    `,
  );
  return rows || [];
}

async function createLinkage(payload, userId = null) {
  const {
    name = null,
    enabled = true,
    trigger_source,
    trigger_alert_type,
    trigger_dimension_key = null,
    trigger_severity_min = "warning",
    do_device_id,
    do_address,
    do_value = true,
    auto_off_seconds = null,
  } = payload || {};

  const rows = await db.query(
    `
      INSERT INTO alert_linkages (
        name,
        enabled,
        trigger_source,
        trigger_alert_type,
        trigger_dimension_key,
        trigger_severity_min,
        do_device_id,
        do_address,
        do_value,
        auto_off_seconds,
        created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `,
    [
      name,
      Boolean(enabled),
      trigger_source,
      trigger_alert_type,
      trigger_dimension_key,
      trigger_severity_min,
      do_device_id != null ? Number(do_device_id) : null,
      do_address != null ? Number(do_address) : null,
      Boolean(do_value),
      auto_off_seconds != null ? Number(auto_off_seconds) : null,
      userId != null ? Number(userId) : null,
    ],
  );

  return rows?.[0] || null;
}

async function updateLinkage(id, updates, userId = null) {
  const linkageId = Number(id);
  if (!Number.isInteger(linkageId) || linkageId <= 0) {
    throw new Error("linkage id 不合法");
  }

  const allowed = [
    "name",
    "enabled",
    "trigger_source",
    "trigger_alert_type",
    "trigger_dimension_key",
    "trigger_severity_min",
    "do_device_id",
    "do_address",
    "do_value",
    "auto_off_seconds",
  ];

  const setParts = [];
  const params = [];
  for (const key of allowed) {
    if (updates?.[key] === undefined) continue;
    setParts.push(`${key} = ?`);
    if (key === "enabled") params.push(Boolean(updates[key]));
    else if (key === "do_value") params.push(Boolean(updates[key]));
    else if (key === "do_device_id") params.push(updates[key] != null ? Number(updates[key]) : null);
    else if (key === "do_address") params.push(updates[key] != null ? Number(updates[key]) : null);
    else if (key === "auto_off_seconds")
      params.push(updates[key] != null ? Number(updates[key]) : null);
    else params.push(updates[key]);
  }

  if (setParts.length === 0) {
    const found = await db.query(`SELECT * FROM alert_linkages WHERE id = ?`, [linkageId]);
    return found?.[0] || null;
  }

  params.push(linkageId);
  const rows = await db.query(
    `
      UPDATE alert_linkages
      SET ${setParts.join(", ")}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      RETURNING *
    `,
    params,
  );
  return rows?.[0] || null;
}

async function deleteLinkage(id) {
  const linkageId = Number(id);
  if (!Number.isInteger(linkageId) || linkageId <= 0) {
    throw new Error("linkage id 不合法");
  }

  const rows = await db.query(`DELETE FROM alert_linkages WHERE id = ? RETURNING *`, [linkageId]);
  return rows?.[0] || null;
}

async function processLinkagesForNewAlert(alert, { createdBy = null } = {}) {
  const a = alert || {};
  if (!a.source || !a.alert_type) return { processed: 0 };

  const linkages = await db.query(
    `
      SELECT *
      FROM alert_linkages
      WHERE enabled = true
        AND trigger_source = ?
        AND trigger_alert_type = ?
      ORDER BY id ASC
    `,
    [String(a.source), String(a.alert_type)],
  );

  if (!Array.isArray(linkages) || linkages.length === 0) return { processed: 0 };

  let processed = 0;
  for (const linkage of linkages) {
    const dim = linkage?.trigger_dimension_key;
    if (dim && String(dim) !== String(a.dimension_key || "")) continue;
    if (!isSeverityAtLeast(a.severity, linkage?.trigger_severity_min)) continue;

    const doDeviceId = linkage?.do_device_id;
    const doAddress = linkage?.do_address;
    if (doDeviceId == null || doAddress == null) continue;

    const manualOff = await hasActiveManualOffOverride(doDeviceId, doAddress);
    if (manualOff && Boolean(linkage?.do_value) === true) {
      await insertExecution({
        linkageId: linkage.id,
        alertId: a.id ?? null,
        executionType: "trigger",
        doDeviceId,
        doAddress,
        doValue: Boolean(linkage?.do_value),
        success: false,
        errorMessage: `已被 manual_off 覆寫，拒絕自動開啟（${nowIso()}）`,
        createdBy,
      });
      processed += 1;
      continue;
    }

    await writeDo({
      linkageId: linkage.id,
      alertId: a.id ?? null,
      executionType: "trigger",
      doDeviceId,
      doAddress,
      doValue: Boolean(linkage?.do_value),
      createdBy,
    });

    scheduleAutoOff({ linkage, alertId: a.id ?? null, createdBy });
    processed += 1;
  }

  return { processed };
}

async function manualOffDoOutput(
  { linkage_id = null, do_device_id, do_address, reason = null, expires_at = null },
  userId = null,
) {
  const doDeviceId = Number(do_device_id);
  const doAddress = Number(do_address);
  if (!Number.isInteger(doDeviceId) || doDeviceId <= 0) {
    throw new Error("do_device_id 不合法");
  }
  if (!Number.isInteger(doAddress) || doAddress < 0) {
    throw new Error("do_address 不合法");
  }

  const cfg = await resolveDeviceConfig(doDeviceId);
  if (!cfg) throw new Error("DO 設備連線設定不足");

  const ok = await modbusClient.writeCoil(doAddress, false, cfg);
  if (ok) modbusBatchService.invalidateDeviceCache(cfg, "coil");

  await db.query(
    `
      INSERT INTO do_output_overrides (
        do_device_id,
        do_address,
        mode,
        reason,
        expires_at,
        created_by
      )
      VALUES (?, ?, 'manual_off', ?, ?, ?)
      ON CONFLICT (do_device_id, do_address, mode)
      DO UPDATE SET
        reason = EXCLUDED.reason,
        expires_at = EXCLUDED.expires_at,
        created_by = EXCLUDED.created_by,
        created_at = CURRENT_TIMESTAMP
      RETURNING *
    `,
    [
      doDeviceId,
      doAddress,
      reason ? String(reason) : null,
      expires_at ? new Date(expires_at) : null,
      userId != null ? Number(userId) : null,
    ],
  );

  // alert_linkage_executions 的 linkage_id 為必填 FK。
  // 若呼叫端有對應 linkage_id，可寫入 execution；否則只保留 override 本身即可。
  const linkageId = linkage_id != null ? Number(linkage_id) : null;
  if (Number.isInteger(linkageId) && linkageId > 0) {
    await insertExecution({
      linkageId,
      alertId: null,
      executionType: "manual_off",
      doDeviceId,
      doAddress,
      doValue: false,
      success: Boolean(ok),
      errorMessage: ok ? null : "writeCoil 回傳失敗",
      createdBy: userId,
    });
  }

  return { success: Boolean(ok) };
}

async function releaseManualOffOverride({ do_device_id, do_address }) {
  const doDeviceId = Number(do_device_id);
  const doAddress = Number(do_address);
  if (!Number.isInteger(doDeviceId) || doDeviceId <= 0) {
    throw new Error("do_device_id 不合法");
  }
  if (!Number.isInteger(doAddress) || doAddress < 0) {
    throw new Error("do_address 不合法");
  }

  const deleted = await db.query(
    `
      DELETE FROM do_output_overrides
      WHERE do_device_id = ?
        AND do_address = ?
        AND mode = 'manual_off'
      RETURNING *
    `,
    [doDeviceId, doAddress],
  );

  return { success: Array.isArray(deleted) && deleted.length > 0 };
}

module.exports = {
  listLinkages,
  createLinkage,
  updateLinkage,
  deleteLinkage,
  processLinkagesForNewAlert,
  manualOffDoOutput,
  releaseManualOffOverride,
  hasActiveManualOffOverride,
};

