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
			if (config.port !== undefined && typeof config.port !== "number") {
				throw new Error("controller 類型的 port 必須是數字");
			}
			// unitId 可選，如果提供則必須是數字
			if (config.unitId !== undefined && typeof config.unitId !== "number") {
				throw new Error("controller 類型的 unitId 必須是數字");
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
				// unitId 可選，如果提供則必須是數字（將由系統自動生成）
				if (config.unitId !== undefined && typeof config.unitId !== "number") {
					throw new Error("sensor (modbus) 類型的 unitId 必須是數字");
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

/**
 * 驗證 logging 配置
 */
const validateLoggingConfig = (config) => {
	if (!config || typeof config !== "object") {
		return { valid: false, error: "logging 配置必須是物件" };
	}

	if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
		return { valid: false, error: "logging.enabled 必須是布林值" };
	}

	if (config.interval !== undefined) {
		if (typeof config.interval !== "number" || config.interval < 1) {
			return { valid: false, error: "logging.interval 必須是大於 0 的數字" };
		}
	}

	if (config.values !== undefined) {
		if (!Array.isArray(config.values)) {
			return { valid: false, error: "logging.values 必須是陣列" };
		}

		for (const value of config.values) {
			if (!value.name || typeof value.name !== "string") {
				return { valid: false, error: "logging.values[].name 必須是字串" };
			}
			if (!["holding", "input", "coil", "discrete"].includes(value.register_type)) {
				return { valid: false, error: `無效的暫存器類型: ${value.register_type}` };
			}
			if (typeof value.address !== "number" || value.address < 0) {
				return { valid: false, error: "logging.values[].address 必須是非負整數" };
			}
			if (value.length !== undefined && (typeof value.length !== "number" || value.length < 1)) {
				return { valid: false, error: "logging.values[].length 必須是大於 0 的數字" };
			}
			if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
				return { valid: false, error: "logging.values[].enabled 必須是布林值" };
			}
			if (value.conversion !== undefined) {
				if (typeof value.conversion !== "object") {
					return { valid: false, error: "logging.values[].conversion 必須是物件" };
				}
				if (value.conversion.formula !== undefined && typeof value.conversion.formula !== "string") {
					return { valid: false, error: "logging.values[].conversion.formula 必須是字串" };
				}
				if (value.conversion.unit !== undefined && typeof value.conversion.unit !== "string") {
					return { valid: false, error: "logging.values[].conversion.unit 必須是字串" };
				}
				if (value.conversion.scale !== undefined && typeof value.conversion.scale !== "number") {
					return { valid: false, error: "logging.values[].conversion.scale 必須是數字" };
				}
				if (value.conversion.offset !== undefined && typeof value.conversion.offset !== "number") {
					return { valid: false, error: "logging.values[].conversion.offset 必須是數字" };
				}
			}
		}
	}

	return { valid: true };
};

module.exports = {
	parseConfig,
	stringifyConfig,
	validateDeviceConfig,
	validateLoggingConfig
};
