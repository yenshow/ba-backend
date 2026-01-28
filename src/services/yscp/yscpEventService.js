const logger = require("../../utils/logger");
const websocketService = require("../websocket/websocketService");

const serviceLogger = logger.createLogger("YSCP Event Service");

/**
 * YSCP 事件處理服務
 * 處理從 YSCP 系統接收的事件
 * 
 * 注意：YSCP 系統已設定為只發送一種類型的事件（包含 events 數組的警報事件）
 * 因此不需要進行事件類型判斷，統一處理即可
 */
class YscpEventService {
	/**
	 * 處理接收到的 YSCP 事件
	 * @param {object} eventData - 事件數據
	 * @returns {Promise<object>} 處理結果
	 */
	async handleEvent(eventData) {
		try {
			// YSCP 實際事件結構：{ method: 'OnEventNotify', params: { events: [...] }, ... }
			// YSCP 系統已設定為只發送包含 events 數組的警報事件，統一處理即可
			const io = websocketService.getIO();
			if (io) {
				io.emit("yscp:event:alarm", {
					type: "alarm",
					data: eventData,
					timestamp: new Date().toISOString(),
				});
			}

			return {
				processed: true,
				eventType: "alarm",
			};
		} catch (error) {
			serviceLogger.error("處理事件時發生錯誤", {
				error: error.message,
			});
			throw error;
		}
	}
}

module.exports = new YscpEventService();

