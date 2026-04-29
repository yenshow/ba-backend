const logger = require("../../utils/logger");
const websocketService = require("../websocket/websocketService");

const serviceLogger = logger.createLogger("YSCP Event Service");

/** OnEventNotify 依 params.ability 對應的事件類型（實際 emit 由 websocketService 統一處理） */
const ABILITY_WS_MAP = {
  event_veh: { type: "vehicle_access" },
  event_acs: { type: "acs" },
};

/**
 * YSCP 事件處理服務
 * 依 method / params.ability 分流：event_veh（車輛進出）、event_acs（門禁／人流統計）。
 * 僅推送對應 WebSocket 供前端刷新，不寫入主庫
 */
class YscpEventService {
  async handleEvent(eventData) {
    try {
      const ability =
        eventData.method === "OnEventNotify" ? eventData.params?.ability : null;
      const mapped = ability ? ABILITY_WS_MAP[ability] : null;

      if (mapped) {
        websocketService.emitYscpEvent(mapped.type);
        return { processed: true, eventType: mapped.type };
      }

      return { processed: true, eventType: null };
    } catch (error) {
      serviceLogger.error("處理事件時發生錯誤", { error: error.message });
      throw error;
    }
  }
}

module.exports = new YscpEventService();
