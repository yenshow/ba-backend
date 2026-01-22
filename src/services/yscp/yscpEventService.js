const logger = require("../../utils/logger");
const websocketService = require("../websocket/websocketService");

const serviceLogger = logger.createLogger("YSCP Event Service");

/**
 * YSCP 事件處理服務
 * 處理從 YSCP 系統接收的事件
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
			// 從 params.events 中提取事件類型
			const events = eventData?.params?.events || [];
			const hasEvents = events.length > 0;
			
			// 如果有 events 數組，視為警報事件；否則視為通用事件
			if (hasEvents) {
				return await this.handleAlarmEvent(eventData);
			} else {
				return await this.handleGenericEvent(eventData);
			}
		} catch (error) {
			serviceLogger.error("處理事件時發生錯誤", {
				error: error.message,
			});
			throw error;
		}
	}

	/**
	 * 處理事件並推送 WebSocket 通知給前端
	 * @param {object} eventData - 事件數據
	 * @param {string} eventType - 事件類型（'alarm' | 'generic'）
	 * @returns {Promise<object>} 處理結果
	 */
	async _processEvent(eventData, eventType) {
		// 通過 WebSocket 推送事件給前端，由前端決定是否重新載入資料
		const io = websocketService.getIO();
		if (io) {
			io.emit(`yscp:event:${eventType}`, {
				type: eventType,
				data: eventData,
				timestamp: new Date().toISOString(),
			});
		}

		return {
			processed: true,
			eventType,
		};
	}

	/**
	 * 處理警報事件
	 * @param {object} eventData - 事件數據
	 * @returns {Promise<object>} 處理結果
	 */
	async handleAlarmEvent(eventData) {
		return await this._processEvent(eventData, "alarm");
	}

	/**
	 * 處理通用事件
	 * @param {object} eventData - 事件數據
	 * @returns {Promise<object>} 處理結果
	 */
	async handleGenericEvent(eventData) {
		return await this._processEvent(eventData, "generic");
	}
}

module.exports = new YscpEventService();

