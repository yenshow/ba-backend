const express = require("express");
const modbusClient = require("../services/modbusClient");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");

const router = express.Router();

const parseAddressParams = (req) => {
	const address = Number(req.query.address ?? 0);
	const length = Number(req.query.length ?? 10);

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

// ==================== 已棄用的路由（保留僅為向後兼容）===================
// 注意：以下路由已移至 /api/devices，建議前端遷移到新的路由
// - 設備管理：/api/devices (GET, POST, PUT, DELETE)
// - 設備類型：/api/devices/types
// - 設備型號：/api/devices/models

// 取得所有設備類型（已棄用，請使用 /api/devices/types）
router.get("/device-types", async (req, res, next) => {
	try {
		const deviceTypeService = require("../services/deviceTypeService");
		const result = await deviceTypeService.getAllDeviceTypes();
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 取得單一設備類型（已棄用，請使用 /api/devices/types/:id）
router.get("/device-types/:id", async (req, res, next) => {
	try {
		const deviceTypeService = require("../services/deviceTypeService");
		const id = parseInt(req.params.id, 10);
		if (isNaN(id)) {
			return res.status(400).json({ error: "設備類型 ID 必須是數字" });
		}
		const result = await deviceTypeService.getDeviceTypeById(id);
		res.json(result);
	} catch (error) {
		if (error.statusCode === 404) {
			return res.status(404).json({ error: error.message });
		}
		next(error);
	}
});

// ==================== 設備型號管理路由（已棄用，請使用 /api/devices/models）===================

// 取得所有設備型號（已棄用，請使用 /api/devices/models）
router.get("/device-models", async (req, res, next) => {
	try {
		const deviceModelService = require("../services/deviceModelService");
		const result = await deviceModelService.getAllDeviceModels();
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 取得單一設備型號（已棄用，請使用 /api/devices/models/:id）
router.get("/device-models/:id", async (req, res, next) => {
	try {
		const deviceModelService = require("../services/deviceModelService");
		const id = parseInt(req.params.id, 10);
		if (isNaN(id)) {
			return res.status(400).json({ error: "設備型號 ID 必須是數字" });
		}
		const result = await deviceModelService.getDeviceModelById(id);
		res.json(result);
	} catch (error) {
		if (error.statusCode === 404) {
			return res.status(404).json({ error: error.message });
		}
		next(error);
	}
});

// 建立設備型號（已棄用，請使用 /api/devices/models）
router.post("/device-models", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const deviceModelService = require("../services/deviceModelService");
		const result = await deviceModelService.createDeviceModel(req.body, req.user.id);
		res.status(201).json(result);
	} catch (error) {
		if (error.statusCode === 400) {
			return res.status(400).json({ error: error.message });
		}
		next(error);
	}
});

// 更新設備型號（已棄用，請使用 /api/devices/models/:id）
router.put("/device-models/:id", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const deviceModelService = require("../services/deviceModelService");
		const id = parseInt(req.params.id, 10);
		if (isNaN(id)) {
			return res.status(400).json({ error: "設備型號 ID 必須是數字" });
		}
		const result = await deviceModelService.updateDeviceModel(id, req.body, req.user.id);
		res.json(result);
	} catch (error) {
		if (error.statusCode === 400 || error.statusCode === 404) {
			return res.status(error.statusCode).json({ error: error.message });
		}
		next(error);
	}
});

// 刪除設備型號（已棄用，請使用 /api/devices/models/:id）
router.delete("/device-models/:id", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const deviceModelService = require("../services/deviceModelService");
		const id = parseInt(req.params.id, 10);
		if (isNaN(id)) {
			return res.status(400).json({ error: "設備型號 ID 必須是數字" });
		}
		const result = await deviceModelService.deleteDeviceModel(id);
		res.json(result);
	} catch (error) {
		if (error.statusCode === 400 || error.statusCode === 404) {
			return res.status(error.statusCode).json({ error: error.message });
		}
		next(error);
	}
});

module.exports = router;
