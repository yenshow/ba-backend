/**
 * 照明系統監控任務
 * 定期檢查所有照明區域的設備狀態
 */

const db = require("../../database/db");
const modbusClient = require("../devices/modbusClient");
const systemAlert = require("../alerts/systemAlertHelper");

/**
 * 檢查照明區域的設備狀態
 */
async function checkLightingAreas() {
	try {
		// 取得所有有 Modbus 配置的照明區域
		const areas = await db.query(`
			SELECT 
				la.id, 
				la.name, 
				la.modbus_config as modbus,
				d.config, 
				dt.code as device_type_code,
				lf.name as floor_name
			FROM lighting_areas la
			INNER JOIN lighting_floors lf ON la.floor_id = lf.id
			LEFT JOIN devices d ON (la.modbus_config->>'deviceId')::integer = d.id
			LEFT JOIN device_types dt ON d.type_id = dt.id
			WHERE la.modbus_config IS NOT NULL
				AND la.modbus_config != '{}'::jsonb
		`);

		if (areas.length === 0) {
			return;
		}

		let successCount = 0;
		let failCount = 0;

		// 並行檢查所有區域（提高效率）
		const checkPromises = areas.map(async (area) => {
			try {
				// 解析 modbus 配置
				const modbusConfig = typeof area.modbus === "string" 
					? JSON.parse(area.modbus) 
					: area.modbus;
					
				if (!modbusConfig || Object.keys(modbusConfig).length === 0) {
					return { areaId: area.id, success: false, reason: "配置為空" };
				}

				let deviceConfig = null;

				// 如果使用新格式（有 deviceId）
				if (modbusConfig.deviceId && area.config) {
					const config = typeof area.config === "string" 
						? JSON.parse(area.config) 
						: area.config;
						
					if (config.host && config.port !== undefined) {
						deviceConfig = {
							host: config.host,
							port: config.port,
							unitId: config.unitId || 1
						};
					}
				} else if (modbusConfig.host && modbusConfig.port !== undefined) {
					// 向後兼容：使用舊格式
					deviceConfig = {
						host: modbusConfig.host,
						port: modbusConfig.port,
						unitId: modbusConfig.unitId || 1
					};
				}

				if (!deviceConfig) {
					return { areaId: area.id, success: false, reason: "配置不完整" };
				}

				// 嘗試讀取第一個離散輸入或線圈來檢查設備狀態
				// 優先使用 DI（離散輸入），因為它反映實際設備狀態
				const diAddresses = modbusConfig.points?.filter(p => p.type === "di").map(p => p.address) || [];
				const doAddresses = modbusConfig.points?.filter(p => p.type === "do").map(p => p.address) || [];
				const address = diAddresses.length > 0 ? diAddresses[0] : (doAddresses.length > 0 ? doAddresses[0] : 0);

				if (diAddresses.length > 0) {
					await modbusClient.readDiscreteInputs(address, 1, deviceConfig);
				} else if (doAddresses.length > 0) {
					await modbusClient.readCoils(address, 1, deviceConfig);
				} else {
					// 如果沒有配置點位，嘗試讀取地址 0
					await modbusClient.readDiscreteInputs(0, 1, deviceConfig);
				}
				
				// 讀取成功，清除錯誤狀態
				await systemAlert.clearError("lighting", area.id);

				return { areaId: area.id, success: true };
			} catch (error) {
				// 讀取失敗，記錄錯誤
				const errorMessage = error.message || "無法讀取照明設備資料";
				await systemAlert.recordError("lighting", area.id, errorMessage);
				
				return { 
					areaId: area.id, 
					success: false, 
					reason: errorMessage 
				};
			}
		});

		const results = await Promise.allSettled(checkPromises);
		
		results.forEach((result) => {
			if (result.status === "fulfilled") {
				if (result.value.success) {
					successCount++;
				} else {
					failCount++;
				}
			} else {
				failCount++;
			}
		});

		if (successCount > 0 || failCount > 0) {
			console.log(
				`[lightingMonitor] 檢查完成: 成功 ${successCount} 個，失敗 ${failCount} 個`
			);
		}
	} catch (error) {
		console.error("[lightingMonitor] 檢查照明區域失敗:", error);
		throw error;
	}
}

module.exports = {
	checkLightingAreas
};

