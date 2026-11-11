const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { createApiError, throwApiError } = require("../../utils/apiErrors");
const {
  createRuleLinkageCrud,
  normalizeId,
} = require("./alertLinkageHelpers");

const MAX_CAMERAS = 4;

/** 允許 0（非 NVR）；不可用 normalizeIdList（會濾掉 0） */
const parseTrackArray = (v) => {
  if (Array.isArray(v)) {
    return v.map((x) => {
      const n = Number(x);
      return Number.isInteger(n) && n > 0 ? n : 0;
    });
  }
  if (typeof v !== "string") return [];
  const inner = v.trim().replace(/^\s*\{|\}\s*$/g, "");
  if (!inner) return [];
  return inner.split(",").map((x) => {
    const n = Number(String(x).trim());
    return Number.isInteger(n) && n > 0 ? n : 0;
  });
};

const alignTracksToDevices = (deviceIds, trackIds) => {
  const raw = parseTrackArray(trackIds);
  return deviceIds.map((_, i) => raw[i] || 0);
};

const crud = createRuleLinkageCrud({
  tableName: "alert_camera_linkages",
  idsColumn: "camera_device_ids",
  payloadIdsKey: "camera_device_ids",
  maxIds: MAX_CAMERAS,
  mapRow: (row, parseIds) => {
    const camera_device_ids = parseIds(row.camera_device_ids);
    const out = {
      ...row,
      camera_device_ids,
      nvr_track_ids: alignTracksToDevices(camera_device_ids, row.nvr_track_ids),
    };
    delete out.camera_device_id;
    return out;
  },
});

/**
 * 依 devices.config.is_nvr 對齊 nvr_track_ids：NVR 必填 >0；非 NVR 強制 0
 */
async function alignNvrTrackIds(deviceIds, trackIds) {
  const aligned = alignTracksToDevices(deviceIds, trackIds);
  if (deviceIds.length === 0) return aligned;

  const rows = await db.query(
    `SELECT id, config FROM devices WHERE id = ANY(?)`,
    [deviceIds],
  );
  const parseCfg = (raw) => {
    if (raw && typeof raw === "object") return raw;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }
    return {};
  };
  const byId = new Map(
    (rows || []).map((r) => [Number(r.id), parseCfg(r.config)]),
  );

  return deviceIds.map((id, i) => {
    const cfg = byId.get(Number(id)) || {};
    const isNvr = cfg.is_nvr === true;
    if (!isNvr) return 0;
    const track = aligned[i];
    if (!(track > 0)) {
      throw createApiError(
        C.DEVICE_NVR_CHANNEL_INVALID,
        `NVR 設備 ${id} 必須指定通道 trackId（nvr_track_ids）`,
      );
    }
    return track;
  });
}

async function upsertForRule(ruleId, payload, userId = null) {
  const rid = normalizeId(ruleId);
  if (!rid) throwApiError(C.ALERT_LINKAGE_RULE_ID_INVALID, "rule_id 不合法");

  const enabled =
    payload?.enabled !== undefined ? Boolean(payload.enabled) : true;
  const camera_device_ids = [
    ...new Set(
      (Array.isArray(payload?.camera_device_ids)
        ? payload.camera_device_ids
        : []
      )
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ].slice(0, MAX_CAMERAS);

  const nvr_track_ids = await alignNvrTrackIds(
    camera_device_ids,
    payload?.nvr_track_ids,
  );

  const rows = await db.query(
    `
    INSERT INTO alert_camera_linkages (
      rule_id, enabled, camera_device_ids, nvr_track_ids, created_by
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (rule_id)
    DO UPDATE SET
      enabled = EXCLUDED.enabled,
      camera_device_ids = EXCLUDED.camera_device_ids,
      nvr_track_ids = EXCLUDED.nvr_track_ids,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
    `,
    [
      rid,
      enabled,
      camera_device_ids,
      nvr_track_ids,
      userId != null ? Number(userId) : null,
    ],
  );
  return crud.normalizeRow(rows?.[0] || null);
}

module.exports = {
  getByRuleId: crud.getByRuleId,
  getByRuleIds: crud.getByRuleIds,
  upsertForRule,
  deleteForRule: crud.deleteForRule,
};
