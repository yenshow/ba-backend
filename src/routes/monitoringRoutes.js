const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { noCache } = require("../middleware/common");
const { authenticate } = require("../middleware/authMiddleware");
const permissionService = require("../services/platform/permissionService");
const licenseService = require("../services/license/licenseService");
const locationService = require("../services/location/locationService");

const lightingStatusService = require("../services/snapshotStatus/lightingStatusService");
const hvacStatusService = require("../services/snapshotStatus/hvacStatusService");
const powerStatusService = require("../services/snapshotStatus/powerStatusService");
const drainageStatusService = require("../services/snapshotStatus/drainageStatusService");
const fireStatusService = require("../services/snapshotStatus/fireStatusService");
const airCirculationStatusService = require("../services/snapshotStatus/airCirculationStatusService");
const smokeAlarmStatusService = require("../services/snapshotStatus/smokeAlarmStatusService");
const emergencyRescueStatusService = require("../services/snapshotStatus/emergencyRescueStatusService");

const ensurePermissionsLoaded = async (req) => {
	if (!req.user) return [];
	if (req.user.role === "admin") return ["*"];
	if (Array.isArray(req.user.permissions)) return req.user.permissions;
	const result = await permissionService.getEffectivePermissionsForUser(req.user.id, req.user.role);
	req.user.permissions = result.codes;
	return result.codes;
};

const hasPermission = (req, codes, requiredCode) => {
	if (!req.user) return false;
	if (req.user.role === "admin") return true;
	return Array.isArray(codes) && codes.includes(requiredCode);
};

module.exports = (() => {
	const router = express.Router();
	router.use(authenticate);

	/**
	 * Central 總覽聚合：一次回傳多個系統的 zones + status items。
	 * - 前端可用於 area-point-map 等總覽頁降低多路請求尖峰。
	 */
	router.get(
		"/overview/status",
		noCache,
		asyncHandler(async (req, res) => {
			const permissions = await ensurePermissionsLoaded(req);
			const activeFeatures = new Set(licenseService.getActiveFeatureKeys());
			const syncAlerts = String(req.query.syncAlerts ?? "").trim().toLowerCase() === "true";

			const systems = [
				{
					key: "lighting",
					featureKey: "lighting",
					permissionCode: "system.lighting",
					locationType: "lighting",
					statusService: lightingStatusService,
				},
				{
					key: "hvac",
					featureKey: "hvac",
					permissionCode: "system.hvac",
					locationType: "hvac",
					statusService: hvacStatusService,
				},
				{
					key: "power",
					featureKey: "power",
					permissionCode: "system.power",
					locationType: "power",
					statusService: powerStatusService,
				},
				{
					key: "drainage",
					featureKey: "drainage",
					permissionCode: "system.drainage",
					locationType: "drainage",
					statusService: drainageStatusService,
				},
				{
					key: "fire",
					featureKey: "fire",
					permissionCode: "system.fire",
					locationType: "fire",
					statusService: fireStatusService,
				},
				{
					key: "air_circulation",
					featureKey: "air_circulation",
					permissionCode: "system.air_circulation",
					locationType: "air_circulation",
					statusService: airCirculationStatusService,
				},
				{
					key: "smoke_alarm",
					featureKey: "smoke_alarm",
					permissionCode: "system.smoke_alarm",
					locationType: "smoke_alarm",
					statusService: smokeAlarmStatusService,
				},
				{
					key: "emergency_rescue",
					featureKey: "emergency_rescue",
					permissionCode: "system.emergency_rescue",
					locationType: "emergency_rescue",
					statusService: emergencyRescueStatusService,
				},
			];

			const enabled = systems.filter(
				(s) => activeFeatures.has(s.featureKey) && hasPermission(req, permissions, s.permissionCode)
			);

			const pairs = await Promise.allSettled(
				enabled.map(async (s) => {
					const zonesRes = await locationService.getZones({ locationType: s.locationType });
					const statusRes = await s.statusService.getStatusSnapshot({ zoneIds: undefined, syncAlerts });
					return [
						s.key,
						{
							zones: zonesRes.zones || [],
							items: statusRes.items || [],
						},
					];
				})
			);

			const data = {};
			for (const p of pairs) {
				if (p.status !== "fulfilled") continue;
				const [k, v] = p.value;
				data[k] = v;
			}

			res.sendSuccess({ systems: data });
		})
	);

	return router;
})();

