const { MESSAGE_TEMPLATE_KEYS } = require("../services/alerts/alertCopy");

/** 新安裝附帶的能源 Incident 規則（現場已存在同 dimension_key 則不覆寫） */
const ENERGY_ALERT_RULE_CATALOG = [
  {
    name: "契約容量 1 級",
    source: "energy",
    alert_type: "threshold",
    severity: "warning",
    dimension_key: "contract_stage_1",
    condition_type: "energy_contract_stage",
    condition_config: { level: 1, threshold_pct: 80 },
    message_template_key: MESSAGE_TEMPLATE_KEYS.ENERGY_CONTRACT_STAGE_V1,
    enabled: true,
  },
  {
    name: "契約容量 2 級",
    source: "energy",
    alert_type: "threshold",
    severity: "error",
    dimension_key: "contract_stage_2",
    condition_type: "energy_contract_stage",
    condition_config: { level: 2, threshold_pct: 90 },
    message_template_key: MESSAGE_TEMPLATE_KEYS.ENERGY_CONTRACT_STAGE_V1,
    enabled: true,
  },
  {
    name: "契約容量 3 級",
    source: "energy",
    alert_type: "threshold",
    severity: "critical",
    dimension_key: "contract_stage_3",
    condition_type: "energy_contract_stage",
    condition_config: { level: 3, threshold_pct: 100 },
    message_template_key: MESSAGE_TEMPLATE_KEYS.ENERGY_CONTRACT_STAGE_V1,
    enabled: true,
  },
  {
    name: "表計通訊逾時",
    source: "energy",
    alert_type: "offline",
    severity: "critical",
    dimension_key: "meter_stale",
    condition_type: "energy_meter_stale",
    condition_config: { stale_minutes: 15 },
    message_template_key: MESSAGE_TEMPLATE_KEYS.ENERGY_METER_STALE_V1,
    enabled: true,
  },
  {
    name: "讀數跳動異常",
    source: "energy",
    alert_type: "threshold",
    severity: "warning",
    dimension_key: "reading_jump",
    condition_type: "energy_reading_jump",
    condition_config: { multiplier: 3, min_kwh: 10 },
    message_template_key: MESSAGE_TEMPLATE_KEYS.ENERGY_READING_JUMP_V1,
    enabled: true,
  },
];

const listEnergyAlertRules = () => ENERGY_ALERT_RULE_CATALOG;

module.exports = {
  listEnergyAlertRules,
};
