const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { disableHttpCache } = require("../middleware/common");
const { authenticate } = require("../middleware/authMiddleware");
const { hasPermissionCode } = require("../access/permissionService");
const licenseService = require("../services/license/licenseService");
const locationService = require("../services/location/locationService");
const { getMonitoringOverviewSystems } = require("./snapshotSystems");
const {
	resolveStatusSnapshot,
} = require("../services/monitoring/resolveStatusSnapshot");

const hasPermission = (req, requiredCode) => {
	if (!req.user) return false;
	if (req.user.role === "admin") return true;
	return hasPermissionCode(req.user.permissions, requiredCode);
};

/** 聚合 overview 僅回傳使用者已授權子系統模組的狀態 */
const canReadSystemStatusForOverview = (req, systemPermissionCode) =>
	hasPermission(req, systemPermissionCode);

module.exports = (() => {
	const router = express.Router();
	router.use(authenticate);

	/**
	 * Central 總覽聚合：一次回傳多個系統的 zones + status items。
	 * - 前端可用於 area-point-map 等總覽頁降低多路請求尖峰。
	 */
	router.get(
		"/overview/status",
		disableHttpCache,
		asyncHandler(async (req, res) => {
			const license = await licenseService.getLicenseState();
			const licensedFeatures = new Set(license.features || []);

			const systems = getMonitoringOverviewSystems();

			const enabled = systems.filter(
				(s) =>
					licensedFeatures.has(s.featureKey) &&
					canReadSystemStatusForOverview(req, s.permissionCode),
			);

			const pairs = await Promise.allSettled(
				enabled.map(async (s) => {
					const zonesRes = await locationService.getZones({ locationType: s.locationType });
					const statusRes = await resolveStatusSnapshot(s.key, s.statusService, {
						zoneIds: undefined,
					});
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
