const express = require("express");
const modbusClient = require("../services/devices/modbusClient");
const deviceErrorTracker = require("../services/alerts/deviceErrorTracker");

const router = express.Router();

const parseAddressParams = (req) => {
	const address = Number(req.query.address ?? 0);
	// length 參數可選，預設為 1（讀取單個寄存器）
	const length = req.query.length !== undefined ? Number(req.query.length) : 1;

	if (!Number.isInteger(address) || address < 0) {
		throw new Error("address must be a non-negative integer");
	}

	if (!Number.isInteger(length) || length <= 0 || length > 125) {
		throw new Error("length must be an integer between 1 and 125");
	}

	return { address, length };
};

// 解析設備連接參數（必填）
const parseDeviceParams = (req) => {
	// host 是必填
	if (!req.query.host || typeof req.query.host !== "string" || req.query.host.trim() === "") {
		throw new Error("host is required (device IP address)");
	}
	const host = req.query.host.trim();

	// port 是必填
	if (req.query.port === undefined) {
		throw new Error("port is required");
	}
	const port = Number(req.query.port);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error("port must be an integer between 1 and 65535");
	}

	// unitId 是必填
	if (req.query.unitId === undefined) {
		throw new Error("unitId is required");
	}
	const unitId = Number(req.query.unitId);
	if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255) {
		throw new Error("unitId must be an integer between 0 and 255");
	}

	return { host, port, unitId };
};

const routeFactory = (reader) => async (req, res, next) => {
	try {
		// 禁用快取，確保每次取得最新資料
		res.set({
			"Cache-Control": "no-cache, no-store, must-revalidate",
			Pragma: "no-cache",
			Expires: "0"
		});
		const { address, length } = parseAddressParams(req);
		const deviceConfig = parseDeviceParams(req);
		const data = await reader(address, length, deviceConfig);

		// 成功讀取資料時，清除設備錯誤狀態（設備已恢復連線）
		deviceErrorTracker
			.getDeviceIdFromConfig(deviceConfig)
			.then((deviceId) => {
				if (deviceId) {
					return deviceErrorTracker.clearDeviceError(deviceId);
				}
			})
			.catch((error) => {
				// 靜默處理，不影響正常響應
				console.error("[modbusRoutes] 清除設備錯誤狀態失敗:", error.message);
			});

		res.json({ address, length, data, device: deviceConfig });
	} catch (error) {
		next(error);
	}
};

router.get("/health", (req, res, next) => {
	try {
		// 禁用快取，確保每次取得最新連線狀態
		res.set({
			"Cache-Control": "no-cache, no-store, must-revalidate",
			Pragma: "no-cache",
			Expires: "0"
		});
		const deviceConfig = parseDeviceParams(req);
		res.json(modbusClient.getStatus(deviceConfig));
	} catch (error) {
		next(error);
	}
});

router.get("/holding-registers", routeFactory(modbusClient.readHoldingRegisters.bind(modbusClient)));
router.get("/input-registers", routeFactory(modbusClient.readInputRegisters.bind(modbusClient)));
router.get("/coils", routeFactory(modbusClient.readCoils.bind(modbusClient)));
router.get("/discrete-inputs", routeFactory(modbusClient.readDiscreteInputs.bind(modbusClient)));

// PUT /coils - 寫入單個或多個 DO
router.put("/coils", async (req, res, next) => {
	try {
		const { address, value, values } = req.body;
		const deviceConfig = parseDeviceParams(req);

		if (typeof address !== "number" || address < 0 || !Number.isInteger(address)) {
			return res.status(400).json({ error: "address must be a non-negative integer" });
		}

		// 單個寫入
		if (typeof value === "boolean") {
			const success = await modbusClient.writeCoil(address, value, deviceConfig);
			return res.json({ address, value, success, device: deviceConfig });
		}

		// 多個寫入
		if (Array.isArray(values)) {
			if (values.length === 0 || values.length > 125) {
				return res.status(400).json({ error: "values array length must be between 1 and 125" });
			}
			if (!values.every((v) => typeof v === "boolean")) {
				return res.status(400).json({ error: "all values must be boolean" });
			}
			const success = await modbusClient.writeCoils(address, values, deviceConfig);
			return res.json({ address, values, success, device: deviceConfig });
		}

		return res.status(400).json({ error: "must provide either value (boolean) or values (boolean[])" });
	} catch (error) {
		next(error);
	}
});

module.exports = router;
