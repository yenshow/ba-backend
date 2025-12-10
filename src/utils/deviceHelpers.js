// 設備相關共用工具函數

/**
 * 解析 JSON 配置（處理字串或物件格式）
 */
const parseConfig = (config) => {
	if (!config) return null;
	return typeof config === "string" ? JSON.parse(config) : config;
};

/**
 * 序列化配置為 JSON 字串
 */
const stringifyConfig = (config) => {
	if (!config) return null;
	return typeof config === "string" ? config : JSON.stringify(config);
};

/**
 * 驗證設備配置
 */
const validateDeviceConfig = (config, typeCode) => {
	if (!config || typeof config !== "object") {
		throw new Error("config 必須是有效的 JSON 物件");
	}

	if (config.type !== typeCode) {
		throw new Error(`config.type 必須為 "${typeCode}"`);
	}

	switch (typeCode) {
		case "controller":
			if (!config.host || typeof config.host !== "string") {
				throw new Error("controller 類型需要 host (string)");
			}
			if (!config.port || typeof config.port !== "number") {
				throw new Error("controller 類型需要 port (number)");
			}
			if (!config.unitId || typeof config.unitId !== "number") {
				throw new Error("controller 類型需要 unitId (number)");
			}
			break;

		case "camera":
			if (!config.ip_address || typeof config.ip_address !== "string") {
				throw new Error("camera 類型需要 ip_address (string)");
			}
			break;

		case "sensor":
			if (!config.protocol || !["modbus", "http", "mqtt"].includes(config.protocol)) {
				throw new Error("sensor 類型需要 protocol (modbus, http, 或 mqtt)");
			}
			if (config.protocol === "modbus") {
				if (!config.host || typeof config.host !== "string") {
					throw new Error("sensor (modbus) 需要 host (string)");
				}
				if (!config.port || typeof config.port !== "number") {
					throw new Error("sensor (modbus) 需要 port (number)");
				}
				if (!config.unitId || typeof config.unitId !== "number") {
					throw new Error("sensor (modbus) 需要 unitId (number)");
				}
			} else if (config.protocol === "http") {
				if (!config.api_endpoint || typeof config.api_endpoint !== "string") {
					throw new Error("sensor (http) 需要 api_endpoint (string)");
				}
			} else if (config.protocol === "mqtt") {
				if (!config.connection_string || typeof config.connection_string !== "string") {
					throw new Error("sensor (mqtt) 需要 connection_string (string)");
				}
			}
			break;

		case "tablet":
			if (!config.mac_address || typeof config.mac_address !== "string") {
				throw new Error("tablet 類型需要 mac_address (string)");
			}
			break;

		case "network":
			if (!config.ip_address || typeof config.ip_address !== "string") {
				throw new Error("network 類型需要 ip_address (string)");
			}
			if (!config.device_type || !["router", "switch", "access_point", "other"].includes(config.device_type)) {
				throw new Error("network 類型需要 device_type (router, switch, access_point, 或 other)");
			}
			break;

		default:
			throw new Error(`未知的設備類型: ${typeCode}`);
	}
};

module.exports = {
	parseConfig,
	stringifyConfig,
	validateDeviceConfig
};
