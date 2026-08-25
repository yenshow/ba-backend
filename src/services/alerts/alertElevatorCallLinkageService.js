/**
 * 警報電梯呼梯連動：新 active INSERT 時對指定／全部電梯地點 visitor_call 至 1F。
 * location_ids 空＝全部電梯地點；有值＝僅指定地點。不復歸。
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { createLogger } = require("../../utils/logger");
const licenseService = require("../license/licenseService");
const {
  getElevatorConfigFromLocation,
  findFloorByLabel,
} = require("../elevator/elevatorFloorModel");
const {
  controlGatewayForElevatorRequest,
} = require("../ladderSdk/sdkControlService");
const operationalEventService = require("../operationalEvents/operationalEventService");
const { formatBusinessSummary } = require("../operationalEvents/operationalEventCopy");
const {
  formatPlaceLabel,
} = require("../operationalEvents/operationalEventPlaceContext");

const logger = createLogger("alertElevatorCallLinkage");
const MAX_LOCATION_IDS = 100;
const TARGET_FLOOR_LABEL = "1F";

const normalizeId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const normalizeIdList = (v, maxLen = MAX_LOCATION_IDS) => {
  if (!Array.isArray(v)) return [];
  const ids = v.map(normalizeId).filter(Boolean);
  return [...new Set(ids)].slice(0, maxLen);
};

const parsePgIntArray = (v) => {
  if (Array.isArray(v)) return normalizeIdList(v);
  if (typeof v !== "string") return [];
  const inner = v.trim().replace(/^\s*\{|\}\s*$/g, "");
  if (!inner) return [];
  return normalizeIdList(inner.split(","));
};

const normalizeRow = (row) => {
  if (!row) return row;
  return {
    ...row,
    location_ids: parsePgIntArray(row.location_ids),
  };
};

async function getByRuleId(ruleId) {
  const rid = normalizeId(ruleId);
  if (!rid) return null;
  const rows = await db.query(
    `SELECT * FROM alert_elevator_call_linkages WHERE rule_id = ? LIMIT 1`,
    [rid],
  );
  return normalizeRow(rows?.[0] || null);
}

async function getByRuleIds(ruleIds) {
  const ids = Array.isArray(ruleIds)
    ? [...new Set(ruleIds.map(normalizeId).filter(Boolean))]
    : [];
  if (ids.length === 0) return [];
  const rows = await db.query(
    `SELECT * FROM alert_elevator_call_linkages WHERE rule_id = ANY(?)`,
    [ids],
  );
  return (rows || []).map(normalizeRow);
}

async function upsertForRule(ruleId, payload, userId = null) {
  const rid = normalizeId(ruleId);
  if (!rid) throwApiError(C.ALERT_LINKAGE_RULE_ID_INVALID, "rule_id 不合法");
  const enabled = payload?.enabled !== undefined ? Boolean(payload.enabled) : true;
  const locationIds = normalizeIdList(payload?.location_ids, MAX_LOCATION_IDS);

  const rows = await db.query(
    `
    INSERT INTO alert_elevator_call_linkages (rule_id, enabled, location_ids, created_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (rule_id)
    DO UPDATE SET
      enabled = EXCLUDED.enabled,
      location_ids = EXCLUDED.location_ids,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
    `,
    [rid, enabled, locationIds, userId != null ? Number(userId) : null],
  );
  return normalizeRow(rows?.[0] || null);
}

async function deleteForRule(ruleId) {
  const rid = normalizeId(ruleId);
  if (!rid) return { deleted: 0 };
  const rows = await db.query(
    `DELETE FROM alert_elevator_call_linkages WHERE rule_id = ? RETURNING id`,
    [rid],
  );
  return { deleted: rows?.length || 0 };
}

const ELEVATOR_LOCATION_SELECT = `
  SELECT
    l.id AS location_id,
    l.name AS location_name,
    z.name AS zone_name,
    ls.id AS system_id,
    ls.system_config
  FROM location_systems ls
  INNER JOIN locations l ON l.id = ls.location_id
  LEFT JOIN zones z ON l.zone_id = z.id
  WHERE ls.system_type = 'elevator'
`;

async function loadElevatorLocations(selectedIds) {
  const list = normalizeIdList(selectedIds);
  const rows =
    list.length > 0
      ? await db.query(
          `${ELEVATOR_LOCATION_SELECT} AND l.id = ANY(?) ORDER BY l.id`,
          [list],
        )
      : await db.query(
          `${ELEVATOR_LOCATION_SELECT} ORDER BY l.id LIMIT ?`,
          [MAX_LOCATION_IDS],
        );
  return rows || [];
}

const recordCallOe = ({
  success,
  errorMessage,
  locationId,
  systemId,
  deviceId,
  placeLabel,
  alertId,
  ruleId,
}) => {
  void operationalEventService.recordEvent({
    source: "alert_linkage",
    event_kind: "elevator",
    location_id: locationId,
    system_id: systemId,
    device_id: deviceId,
    message: formatBusinessSummary({
      placeLabel,
      action: success ? "訪客呼梯" : "訪客呼梯失敗",
      detail: TARGET_FLOOR_LABEL,
    }),
    ref_table: "alerts",
    ref_id: alertId != null ? Number(alertId) : null,
    payload: {
      fromAlertLinkage: true,
      linkageKind: "elevator_call",
      alertId: alertId != null ? Number(alertId) : null,
      ruleId: ruleId != null ? Number(ruleId) : null,
      targetFloorLabel: TARGET_FLOOR_LABEL,
      success,
      ...(errorMessage
        ? { errorMessage: String(errorMessage).slice(0, 500) }
        : {}),
    },
  });
};

async function processElevatorCallLinkagesForNewAlert(alert) {
  const licensed = await licenseService.isRuntimeFeatureLicensed("elevator");
  if (!licensed) return;

  const rid = alert?.rule_id != null ? Number(alert.rule_id) : null;
  if (!Number.isInteger(rid) || rid <= 0) return;

  let linkage;
  try {
    linkage = await getByRuleId(rid);
  } catch (err) {
    logger.warn("查詢電梯呼梯連動失敗", {
      ruleId: rid,
      error: err?.message || String(err),
    });
    return;
  }
  if (!linkage?.enabled) return;

  const selectedIds = Array.isArray(linkage.location_ids)
    ? linkage.location_ids
    : [];
  let locations = [];
  try {
    locations = await loadElevatorLocations(selectedIds);
  } catch (err) {
    logger.warn("載入電梯呼梯目標失敗", { error: err?.message || String(err) });
    return;
  }

  if (locations.length === 0) {
    logger.warn("電梯呼梯連動已啟用但無可用電梯地點", {
      ruleId: rid,
      alertId: alert?.id,
      selectedCount: selectedIds.length,
    });
    return;
  }

  const alertId = alert?.id ?? null;
  for (const row of locations) {
    const locationId = Number(row.location_id);
    const placeLabel = formatPlaceLabel(row.zone_name, row.location_name);
    const cfg = getElevatorConfigFromLocation({
      systems: [{ systemType: "elevator", config: row.system_config }],
    });
    const callDeviceId = Number(cfg.callDevice?.deviceId);
    const slot = findFloorByLabel(cfg.floors || [], TARGET_FLOOR_LABEL);
    const callGateway = slot?.floor?.callGateway ?? null;

    if (
      !Number.isFinite(callDeviceId) ||
      callDeviceId <= 0 ||
      !slot ||
      callGateway == null
    ) {
      logger.warn("電梯呼梯連動略過：無 1F 或未設定呼梯", {
        locationId,
        alertId,
        hasCallDevice: Number.isFinite(callDeviceId) && callDeviceId > 0,
        has1F: Boolean(slot),
        callGateway,
      });
      continue;
    }

    try {
      await controlGatewayForElevatorRequest(
        callDeviceId,
        {
          gatewayIndex: callGateway,
          command: "visitor_call",
          locationId,
          targetLogicalIndex: slot.index,
          skipPlatformCallAudit: true,
        },
        { allowAnyLadderDevice: true },
      );
      recordCallOe({
        success: true,
        locationId,
        systemId: row.system_id,
        deviceId: callDeviceId,
        placeLabel,
        alertId,
        ruleId: rid,
      });
    } catch (err) {
      const errorMessage = err?.message || String(err);
      logger.warn("電梯呼梯連動失敗", {
        locationId,
        deviceId: callDeviceId,
        alertId,
        error: errorMessage,
      });
      recordCallOe({
        success: false,
        errorMessage,
        locationId,
        systemId: row.system_id,
        deviceId: callDeviceId,
        placeLabel,
        alertId,
        ruleId: rid,
      });
    }
  }
}

module.exports = {
  MAX_LOCATION_IDS,
  getByRuleId,
  getByRuleIds,
  upsertForRule,
  deleteForRule,
  processElevatorCallLinkagesForNewAlert,
};
