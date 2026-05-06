/**
 * 排水／消防／電力快照共用：config 欄位解析、警報語意 meta、聚合後 uiStatus
 */

/**
 * @param {object|null|undefined} system - location_system
 * @param {{ equipmentKind?: string, viewCategory?: string }} defaults - 各系統預設 equipmentKind／viewCategory
 */
function resolveLocationSystemStatusFields(system, defaults = {}) {
  const d = defaults && typeof defaults === "object" ? defaults : {};
  const c =
    system?.config && typeof system.config === "object" ? system.config : {};
  const statusPoints =
    c.statusPoints != null && typeof c.statusPoints === "object"
      ? c.statusPoints
      : c.status_points != null && typeof c.status_points === "object"
        ? c.status_points
        : {};
  return {
    deviceId: c.deviceId ?? c.device_id,
    modbus: c.modbus ?? c.modbus_config,
    equipmentKind: c.equipmentKind ?? c.equipment_kind ?? d.equipmentKind,
    viewCategory: c.viewCategory ?? c.view_category ?? d.viewCategory,
    statusPoints,
  };
}

/**
 * @param {Array<{ system: { id: unknown } }>} triples
 * @param {(system: object) => { equipmentKind: unknown, statusPoints: object }} resolveFieldsFn
 * @returns {Map<string, { equipmentKind: unknown, statusPoints: object }>}
 */
function buildAlertSemanticsMetaBySystemId(triples, resolveFieldsFn) {
  const metaBySystemId = new Map();
  for (const t of triples) {
    const f = resolveFieldsFn(t.system);
    metaBySystemId.set(String(t.system.id), {
      equipmentKind: f.equipmentKind,
      statusPoints: f.statusPoints,
    });
  }
  return metaBySystemId;
}

/**
 * - normal：已連線且有讀值，且聚合 raw.running 未觸發
 * - alarm：rawMerged.running === true
 * - warning：未連線、無點位或讀值全失敗
 */
function deriveSnapshotAggregateRunningUiStatus(
  rawMerged,
  hadDeviceConfig,
  pointKeysConfigured,
  rawRead,
) {
  if (!hadDeviceConfig) return "warning";
  if (!pointKeysConfigured || pointKeysConfigured.length === 0) {
    return "warning";
  }

  const src = rawRead && typeof rawRead === "object" ? rawRead : rawMerged;
  const anyRead = pointKeysConfigured.some(
    (k) => src[k] !== undefined && src[k] !== null,
  );
  if (!anyRead) return "warning";

  if (rawMerged.running === true) return "alarm";
  return "normal";
}

module.exports = {
  resolveLocationSystemStatusFields,
  buildAlertSemanticsMetaBySystemId,
  deriveSnapshotAggregateRunningUiStatus,
};
