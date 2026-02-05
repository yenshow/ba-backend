const logger = require("../../utils/logger");
const websocketService = require("../websocket/websocketService");

const serviceLogger = logger.createLogger("YSCP Event Service");

/** OnEventNotify 依 params.ability 對應的 WebSocket 事件名稱與類型 */
const ABILITY_WS_MAP = {
  event_veh: { event: "yscp:event:vehicle", type: "vehicle_access" },
  event_acs: { event: "yscp:event:acs", type: "acs" },
};

/**
 * YSCP 事件處理服務
 * 依 method / params.ability 分流：event_veh（車輛進出）、event_acs（門禁／人流統計）。
 * 僅推送對應 WebSocket 供前端刷新，不寫入主庫
 */
class YscpEventService {
  async handleEvent(eventData) {
    try {
      const io = websocketService.getIO();
      const ability =
        eventData.method === "OnEventNotify" ? eventData.params?.ability : null;
      const mapped = ability ? ABILITY_WS_MAP[ability] : null;

      if (io && mapped) {
        io.emit(mapped.event, {
          type: mapped.type,
          timestamp: new Date().toISOString(),
        });
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
