/**
 * 警報 enrichment SELECT／JOIN 共用片段
 * list／byId／backup 只差欄位集合，JOIN 與 CASE 單一來源。
 */

/** 站級能源契約告警：source=energy 且 source_id=1（energy_settings.id） */
const ENERGY_STATION_ALERT_SQL =
  "(a.source = 'energy' AND a.source_id = 1)";

/** 設備中心 source（source_id = devices.id） */
const DEVICE_SCOPED_ALERT_SOURCES_SQL = "'device', 'energy'";

/** 關聯 location_systems 的 alert source */
const LOCATION_ALERT_SOURCES_SQL = [
  "environment",
  "lighting",
  "people_counting",
  "drainage",
  "power",
  "hvac",
  "air_circulation",
  "fire",
  "emergency_rescue",
  "smoke_alarm",
  "security",
]
  .map((source) => `'${source}'`)
  .join(", ");

const ENRICHMENT_CASES = `
      CASE 
        WHEN ${ENERGY_STATION_ALERT_SQL} THEN NULL
        WHEN a.source IN (${DEVICE_SCOPED_ALERT_SOURCES_SQL}) THEN d.type_code
        WHEN a.source IN (${LOCATION_ALERT_SOURCES_SQL}) THEN d_system.type_code
        ELSE NULL
      END as device_type_code,
      CASE 
        WHEN ${ENERGY_STATION_ALERT_SQL} THEN '能源管理（契約容量）'
        WHEN a.source IN (${DEVICE_SCOPED_ALERT_SOURCES_SQL}) THEN d.name
        WHEN a.source IN (${LOCATION_ALERT_SOURCES_SQL}) THEN l.name
        ELSE NULL
      END as source_name,
      CASE
        WHEN ${ENERGY_STATION_ALERT_SQL} THEN NULL
        WHEN a.source IN (${DEVICE_SCOPED_ALERT_SOURCES_SQL}) THEN d.name
        ELSE NULL
      END as device_name,
      CASE 
        WHEN a.source IN (${LOCATION_ALERT_SOURCES_SQL}) THEN z.name 
        ELSE NULL 
      END as zone_name,
      CASE 
        WHEN ${ENERGY_STATION_ALERT_SQL} THEN NULL
        WHEN a.source IN (${DEVICE_SCOPED_ALERT_SOURCES_SQL}) THEN d.config
        WHEN a.source IN (${LOCATION_ALERT_SOURCES_SQL}) THEN d_system.config
        ELSE NULL
      END as device_config`;

const ENRICHMENT_JOINS = `
    LEFT JOIN users iu ON a.ignored_by = iu.id
    LEFT JOIN devices d
      ON a.source IN (${DEVICE_SCOPED_ALERT_SOURCES_SQL})
     AND a.source_id = d.id
     AND NOT ${ENERGY_STATION_ALERT_SQL}
    LEFT JOIN location_systems ls ON a.source IN (${LOCATION_ALERT_SOURCES_SQL}) AND a.source_id = ls.id
    LEFT JOIN locations l ON ls.location_id = l.id
    LEFT JOIN zones z ON l.zone_id = z.id
    LEFT JOIN devices d_system
      ON (ls.system_config->'device_ids'->>0) IS NOT NULL
     AND (ls.system_config->'device_ids'->>0)::integer = d_system.id`;

/** backup 不含 device_name（與既有 ALERT_BACKUP_SELECT 對齊） */
const BACKUP_ENRICHMENT_CASES = `
    CASE 
      WHEN ${ENERGY_STATION_ALERT_SQL} THEN NULL
      WHEN a.source IN (${DEVICE_SCOPED_ALERT_SOURCES_SQL}) THEN d.type_code
      WHEN a.source IN (${LOCATION_ALERT_SOURCES_SQL}) THEN d_system.type_code
      ELSE NULL
    END as device_type_code,
    CASE 
      WHEN ${ENERGY_STATION_ALERT_SQL} THEN '能源管理（契約容量）'
      WHEN a.source IN (${DEVICE_SCOPED_ALERT_SOURCES_SQL}) THEN d.name
      WHEN a.source IN (${LOCATION_ALERT_SOURCES_SQL}) THEN l.name
      ELSE NULL
    END as source_name,
    CASE 
      WHEN a.source IN (${LOCATION_ALERT_SOURCES_SQL}) THEN z.name 
      ELSE NULL 
    END as zone_name,
    CASE 
      WHEN ${ENERGY_STATION_ALERT_SQL} THEN NULL
      WHEN a.source IN (${DEVICE_SCOPED_ALERT_SOURCES_SQL}) THEN d.config
      WHEN a.source IN (${LOCATION_ALERT_SOURCES_SQL}) THEN d_system.config
      ELSE NULL
    END as device_config`;

/**
 * @param {'list'|'byId'|'backup'} [mode='list']
 * @returns {string} SELECT 語句（不含 WHERE）
 */
function buildAlertSelectQuery(mode = "list") {
  const m = String(mode || "list");

  if (m === "byId") {
    return `
      SELECT 
        a.*,
        iu.username as ignored_by_username,
        ${ENRICHMENT_CASES.trim()}
      FROM alerts a
      ${ENRICHMENT_JOINS.trim()}
    `;
  }

  if (m === "backup") {
    return `
  SELECT 
    a.id,
    a.source,
    a.source_id,
    a.alert_type,
    a.severity,
    a.message,
    a.status,
    a.ignored_at,
    a.created_at,
    a.updated_at,
    iu.username as ignored_by_username,
    ${BACKUP_ENRICHMENT_CASES.trim()}
  FROM alerts a
  ${ENRICHMENT_JOINS.trim()}`;
  }

  // list（預設）
  return `
    SELECT 
      a.id,
      a.source,
      a.source_id,
      a.alert_type,
      a.dimension_key,
      a.rule_id,
      a.severity,
      a.message,
      a.status,
      a.ignored_at,
      a.ignored_by,
      a.created_at,
      a.updated_at,
      iu.username as ignored_by_username,
      ${ENRICHMENT_CASES.trim()}
    FROM alerts a
    ${ENRICHMENT_JOINS.trim()}
    `;
}

module.exports = {
  ENERGY_STATION_ALERT_SQL,
  DEVICE_SCOPED_ALERT_SOURCES_SQL,
  LOCATION_ALERT_SOURCES_SQL,
  buildAlertSelectQuery,
};
