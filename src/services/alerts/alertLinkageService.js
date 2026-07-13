const db = require("../../database/db");
const modbusClient = require("../devices/modbusClient");
const modbusBatchService = require("../devices/modbusBatchService");
const logger = require("../../utils/logger");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const linkageLogger = logger.createLogger("alertLinkageService");

const getDeviceService = () => require("../devices/deviceService");

const nowIso = () => new Date().toISOString();

const autoOffTimers = new Map(); // key -> Timeout
const buildDoKey = (doDeviceId, doAddress) =>
  `${Number(doDeviceId)}:${Number(doAddress)}`;

const deviceCfgCache = new Map(); // deviceId -> { ts, cfg }
const DEVICE_CFG_TTL_MS = 60_000;

async function resolveDeviceConfig(deviceId) {
  if (!deviceId) return null;
  const id = Number(deviceId);
  const cached = deviceCfgCache.get(id);
  if (cached && Date.now() - cached.ts < DEVICE_CFG_TTL_MS) return cached.cfg;

  const { device } = await getDeviceService().getDeviceById(id);
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

const normalizeDoOutputValue = (v) => {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return s === "off" ? "off" : "on";
};

const outputValueToBool = (v) => normalizeDoOutputValue(v) === "on";
const invertOutputValue = (v) =>
  normalizeDoOutputValue(v) === "on" ? "off" : "on";

const operationalEventService = require("../operationalEvents/operationalEventService");
const { summaryLinkageWrite } = require("../operationalEvents/operationalEventCopy");

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
    const ok = await modbusClient.writeCoil(
      Number(doAddress),
      Boolean(doValue),
      cfg,
    );
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
    if (ok && alertId != null) {
      void operationalEventService.recordEvent({
        source: "alert_linkage",
        event_kind: "linkage_write",
        device_id: doDeviceId,
        address: doAddress,
        bit_key: `do:${doAddress}`,
        new_value: Boolean(doValue),
        summary: summaryLinkageWrite({
          address: doAddress,
          value: Boolean(doValue),
          executionType,
        }),
        alert_id: alertId,
        actor_user_id: createdBy,
        ref_table: "alert_linkage_executions",
        payload: {
          linkageId,
          executionType,
          doDeviceId,
          doAddress,
          doValue: Boolean(doValue),
        },
      });
    }
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

  const timeout = setTimeout(
    async () => {
      autoOffTimers.delete(key);
      const offValue = !outputValueToBool(linkage.do_output_value);
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
    },
    Number(seconds) * 1000,
  );

  autoOffTimers.set(key, timeout);
}

/**
 * 取消尚未觸發的延時 auto_off（日界線復歸 DO 前呼叫，避免與 rollover_revert 打架）
 */
function cancelPendingAutoOffForDo(doDeviceId, doAddress) {
  if (doDeviceId == null || doAddress == null) return;
  const key = buildDoKey(doDeviceId, doAddress);
  const existing = autoOffTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    autoOffTimers.delete(key);
  }
}

/**
 * 日界線：對仍為 active 的警報，依 rule_id 將連動 DO 寫回觸發值的相反狀態
 * @param {Array<Object>} activeAlerts - SELECT * FROM alerts WHERE status=active
 * @returns {Promise<{ reverted: number }>}
 */
async function revertLinkagesForDailyRollover(activeAlerts) {
  if (!Array.isArray(activeAlerts) || activeAlerts.length === 0) {
    return { reverted: 0 };
  }
  let reverted = 0;
  for (const a of activeAlerts) {
    const rid = a.rule_id != null ? Number(a.rule_id) : null;
    if (!Number.isInteger(rid) || rid <= 0) continue;

    const linkages = await db.query(
      `
      SELECT *
      FROM alert_linkages
      WHERE enabled = true
        AND rule_id = ?
      ORDER BY id ASC
    `,
      [rid],
    );

    if (!Array.isArray(linkages) || linkages.length === 0) continue;

    for (const linkage of linkages) {
      const doDeviceId = linkage?.do_device_id;
      const doAddress = linkage?.do_address;
      if (doDeviceId == null || doAddress == null) continue;

      cancelPendingAutoOffForDo(doDeviceId, doAddress);

      await writeDo({
        linkageId: linkage.id,
        alertId: a.id ?? null,
        executionType: "rollover_revert",
        doDeviceId,
        doAddress,
        doValue: !outputValueToBool(linkage?.do_output_value),
        createdBy: null,
      });
      reverted += 1;
    }
  }
  return { reverted };
}

/**
 * 單筆或多筆警報結案為 resolved 時：依 rule_id 復歸對應連動 DO（與日界線 rollover_revert 語意一致）
 * @param {Array<Object>} resolvedAlerts - 已結案後之 alerts 列（須含 id、rule_id）
 * @returns {Promise<{ reverted: number }>}
 */
async function revertLinkagesForResolvedAlerts(resolvedAlerts) {
  if (!Array.isArray(resolvedAlerts) || resolvedAlerts.length === 0) {
    return { reverted: 0 };
  }
  let reverted = 0;
  for (const a of resolvedAlerts) {
    const rid = a.rule_id != null ? Number(a.rule_id) : null;
    if (!Number.isInteger(rid) || rid <= 0) continue;

    const linkages = await db.query(
      `
      SELECT *
      FROM alert_linkages
      WHERE enabled = true
        AND rule_id = ?
      ORDER BY id ASC
    `,
      [rid],
    );

    if (!Array.isArray(linkages) || linkages.length === 0) continue;

    for (const linkage of linkages) {
      const doDeviceId = linkage?.do_device_id;
      const doAddress = linkage?.do_address;
      if (doDeviceId == null || doAddress == null) continue;

      cancelPendingAutoOffForDo(doDeviceId, doAddress);

      await writeDo({
        linkageId: linkage.id,
        alertId: a.id ?? null,
        executionType: "manual_revert",
        doDeviceId,
        doAddress,
        doValue: !outputValueToBool(linkage?.do_output_value),
        createdBy: null,
      });
      reverted += 1;
    }
  }
  return { reverted };
}

function mapLinkageRowFromJoin(row) {
  if (!row) return null;
  const linkage = {
    id: row.id,
    enabled: row.enabled,
    rule_id: row.rule_id,
    do_device_id: row.do_device_id,
    do_address: row.do_address,
    do_output_value: row.do_output_value,
    auto_off_seconds: row.auto_off_seconds,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.r_id != null) {
    linkage.rule = {
      id: row.r_id,
      source: row.r_source,
      alert_type: row.r_alert_type,
      severity: row.r_severity,
      dimension_key: row.r_dimension_key,
      enabled: row.r_enabled,
      condition_type: row.r_condition_type,
      condition_config: row.r_condition_config,
      target_type: row.r_target_type,
      target_id: row.r_target_id,
    };
  } else {
    linkage.rule = null;
  }
  return linkage;
}

async function assertRuleExists(ruleId) {
  const id = Number(ruleId);
  if (!Number.isInteger(id) || id <= 0) {
    throwApiError(C.ALERT_LINKAGE_RULE_ID_INVALID, "rule_id 不合法");
  }
  const rows = await db.query(
    `SELECT id FROM alert_rules WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    throwApiError(C.ALERT_RULE_NOT_FOUND, `警報規則不存在: rule_id=${id}`);
  }
}

async function listLinkages() {
  const rows = await db.query(
    `
      SELECT
        l.id,
        l.enabled,
        l.rule_id,
        l.do_device_id,
        l.do_address,
        l.do_output_value,
        l.auto_off_seconds,
        l.created_by,
        l.created_at,
        l.updated_at,
        r.id AS r_id,
        r.source AS r_source,
        r.alert_type AS r_alert_type,
        r.severity AS r_severity,
        r.dimension_key AS r_dimension_key,
        r.enabled AS r_enabled,
        r.condition_type AS r_condition_type,
        r.condition_config AS r_condition_config,
        r.target_type AS r_target_type,
        r.target_id AS r_target_id
      FROM alert_linkages l
      LEFT JOIN alert_rules r ON r.id = l.rule_id
      ORDER BY l.id DESC
    `,
  );
  return (rows || []).map(mapLinkageRowFromJoin);
}

async function createLinkage(payload, userId = null) {
  const {
    enabled = true,
    rule_id,
    do_device_id,
    do_address,
    do_output_value = "on",
    auto_off_seconds = null,
  } = payload || {};

  await assertRuleExists(rule_id);

  const rows = await db.query(
    `
      INSERT INTO alert_linkages (
        enabled,
        rule_id,
        do_device_id,
        do_address,
        do_output_value,
        auto_off_seconds,
        created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `,
    [
      Boolean(enabled),
      Number(rule_id),
      do_device_id != null ? Number(do_device_id) : null,
      do_address != null ? Number(do_address) : null,
      normalizeDoOutputValue(do_output_value),
      auto_off_seconds != null ? Number(auto_off_seconds) : null,
      userId != null ? Number(userId) : null,
    ],
  );

  const created = rows?.[0];
  if (!created) return null;

  const listed = await db.query(
    `
      SELECT
        l.id,
        l.enabled,
        l.rule_id,
        l.do_device_id,
        l.do_address,
        l.do_output_value,
        l.auto_off_seconds,
        l.created_by,
        l.created_at,
        l.updated_at,
        r.id AS r_id,
        r.source AS r_source,
        r.alert_type AS r_alert_type,
        r.severity AS r_severity,
        r.dimension_key AS r_dimension_key,
        r.enabled AS r_enabled,
        r.condition_type AS r_condition_type,
        r.condition_config AS r_condition_config,
        r.target_type AS r_target_type,
        r.target_id AS r_target_id
      FROM alert_linkages l
      LEFT JOIN alert_rules r ON r.id = l.rule_id
      WHERE l.id = ?
    `,
    [created.id],
  );
  return mapLinkageRowFromJoin(listed?.[0]) || created;
}

async function updateLinkage(id, updates, _userId = null) {
  const linkageId = Number(id);
  if (!Number.isInteger(linkageId) || linkageId <= 0) {
    throwApiError(C.ALERT_LINKAGE_ID_INVALID, "linkage id 不合法");
  }

  if (updates?.rule_id !== undefined) {
    await assertRuleExists(updates.rule_id);
  }

  const allowed = [
    "enabled",
    "rule_id",
    "do_device_id",
    "do_address",
    "do_output_value",
    "auto_off_seconds",
  ];

  const setParts = [];
  const params = [];
  for (const key of allowed) {
    if (updates?.[key] === undefined) continue;
    setParts.push(`${key} = ?`);
    if (key === "enabled") params.push(Boolean(updates[key]));
    else if (key === "do_output_value")
      params.push(normalizeDoOutputValue(updates[key]));
    else if (key === "rule_id")
      params.push(updates[key] != null ? Number(updates[key]) : null);
    else if (key === "do_device_id")
      params.push(updates[key] != null ? Number(updates[key]) : null);
    else if (key === "do_address")
      params.push(updates[key] != null ? Number(updates[key]) : null);
    else if (key === "auto_off_seconds")
      params.push(updates[key] != null ? Number(updates[key]) : null);
    else params.push(updates[key]);
  }

  if (setParts.length === 0) {
    const listed = await db.query(
      `
      SELECT
        l.id,
        l.enabled,
        l.rule_id,
        l.do_device_id,
        l.do_address,
        l.do_output_value,
        l.auto_off_seconds,
        l.created_by,
        l.created_at,
        l.updated_at,
        r.id AS r_id,
        r.source AS r_source,
        r.alert_type AS r_alert_type,
        r.severity AS r_severity,
        r.dimension_key AS r_dimension_key,
        r.enabled AS r_enabled,
        r.condition_type AS r_condition_type,
        r.condition_config AS r_condition_config,
        r.target_type AS r_target_type,
        r.target_id AS r_target_id
      FROM alert_linkages l
      LEFT JOIN alert_rules r ON r.id = l.rule_id
      WHERE l.id = ?
    `,
      [linkageId],
    );
    return mapLinkageRowFromJoin(listed?.[0]);
  }

  params.push(linkageId);
  await db.query(
    `
      UPDATE alert_linkages
      SET ${setParts.join(", ")}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    params,
  );

  const listed = await db.query(
    `
      SELECT
        l.id,
        l.enabled,
        l.rule_id,
        l.do_device_id,
        l.do_address,
        l.do_output_value,
        l.auto_off_seconds,
        l.created_by,
        l.created_at,
        l.updated_at,
        r.id AS r_id,
        r.source AS r_source,
        r.alert_type AS r_alert_type,
        r.severity AS r_severity,
        r.dimension_key AS r_dimension_key,
        r.enabled AS r_enabled,
        r.condition_type AS r_condition_type,
        r.condition_config AS r_condition_config,
        r.target_type AS r_target_type,
        r.target_id AS r_target_id
      FROM alert_linkages l
      LEFT JOIN alert_rules r ON r.id = l.rule_id
      WHERE l.id = ?
    `,
    [linkageId],
  );
  return mapLinkageRowFromJoin(listed?.[0]);
}

async function deleteLinkage(id) {
  const linkageId = Number(id);
  if (!Number.isInteger(linkageId) || linkageId <= 0) {
    throwApiError(C.ALERT_LINKAGE_ID_INVALID, "linkage id 不合法");
  }

  const rows = await db.query(
    `DELETE FROM alert_linkages WHERE id = ? RETURNING *`,
    [linkageId],
  );
  return rows?.[0] || null;
}

async function processLinkagesForNewAlert(alert, { createdBy = null } = {}) {
  const a = alert || {};
  const rid = a.rule_id != null ? Number(a.rule_id) : null;
  if (!Number.isInteger(rid) || rid <= 0) return { processed: 0 };

  const linkages = await db.query(
    `
      SELECT *
      FROM alert_linkages
      WHERE enabled = true
        AND rule_id = ?
      ORDER BY id ASC
    `,
    [rid],
  );

  if (!Array.isArray(linkages) || linkages.length === 0)
    return { processed: 0 };

  let processed = 0;
  for (const linkage of linkages) {
    const doDeviceId = linkage?.do_device_id;
    const doAddress = linkage?.do_address;
    if (doDeviceId == null || doAddress == null) continue;

    await writeDo({
      linkageId: linkage.id,
      alertId: a.id ?? null,
      executionType: "trigger",
      doDeviceId,
      doAddress,
      doValue: outputValueToBool(linkage?.do_output_value),
      createdBy,
    });

    scheduleAutoOff({ linkage, alertId: a.id ?? null, createdBy });
    processed += 1;
  }

  return { processed };
}

async function manualTriggerLinkage(linkageId, userId = null) {
  const id = Number(linkageId);
  if (!Number.isInteger(id) || id <= 0) {
    throwApiError(C.ALERT_LINKAGE_ID_INVALID, "linkage id 不合法");
  }

  const rows = await db.query(
    `SELECT * FROM alert_linkages WHERE id = ? LIMIT 1`,
    [id],
  );
  const linkage = rows?.[0] || null;
  if (!linkage) throwApiError(C.ALERT_LINKAGE_NOT_FOUND, "連動規則不存在");

  const doDeviceId = linkage?.do_device_id;
  const doAddress = linkage?.do_address;
  if (doDeviceId == null || doAddress == null)
    throwApiError(C.ALERT_LINKAGE_DO_TARGET_MISSING, "此連動未設定 DO 目標");

  // 手動觸發：依此連動的「觸發時輸出」寫入一次（不建立 override）
  const result = await writeDo({
    linkageId: linkage.id,
    alertId: null,
    executionType: "manual_trigger",
    doDeviceId,
    doAddress,
    doValue: outputValueToBool(linkage?.do_output_value),
    createdBy: userId,
  });

  return { success: Boolean(result?.success) };
}

async function getSingleLinkageByRuleId(ruleId) {
  const id = Number(ruleId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await db.query(
    `
    SELECT *
    FROM alert_linkages
    WHERE rule_id = ?
    ORDER BY id DESC
    LIMIT 1
    `,
    [id],
  );
  return rows?.[0] || null;
}

async function getLatestLinkagesByRuleIds(ruleIds) {
  const ids = Array.isArray(ruleIds)
    ? [
        ...new Set(
          ruleIds
            .map((v) => Number(v))
            .filter((n) => Number.isInteger(n) && n > 0),
        ),
      ]
    : [];
  if (ids.length === 0) return [];

  // 每個 rule_id 只取最新一筆（以 id DESC）
  const rows = await db.query(
    `
    SELECT DISTINCT ON (rule_id) *
    FROM alert_linkages
    WHERE rule_id = ANY(?)
    ORDER BY rule_id ASC, id DESC
    `,
    [ids],
  );
  return rows || [];
}

async function deleteAllLinkagesForRule(ruleId) {
  const id = Number(ruleId);
  if (!Number.isInteger(id) || id <= 0) return { deleted: 0 };
  const rows = await db.query(
    `DELETE FROM alert_linkages WHERE rule_id = ? RETURNING id`,
    [id],
  );
  return { deleted: rows?.length || 0 };
}

async function upsertSingleLinkageForRule(ruleId, payload, userId = null) {
  await assertRuleExists(ruleId);
  const existing = await getSingleLinkageByRuleId(ruleId);
  if (!existing) {
    return await createLinkage({ ...payload, rule_id: Number(ruleId) }, userId);
  }
  return await updateLinkage(existing.id, payload, userId);
}

module.exports = {
  listLinkages,
  createLinkage,
  updateLinkage,
  deleteLinkage,
  processLinkagesForNewAlert,
  manualTriggerLinkage,
  cancelPendingAutoOffForDo,
  revertLinkagesForDailyRollover,
  revertLinkagesForResolvedAlerts,
  getSingleLinkageByRuleId,
  getLatestLinkagesByRuleIds,
  upsertSingleLinkageForRule,
  deleteAllLinkagesForRule,
};
