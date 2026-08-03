const express = require("express");
const router = express.Router();
const {
  authenticate,
  requirePermission,
  requireEnergyReportFullIfScoped,
} = require("../middleware/authMiddleware");
const { disableHttpCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { getEnergyParametersPayload } = require("../constants/energyParameterCatalog");
const energySettingsService = require("../services/energy/energySettingsService");
const energyDashboardService = require("../services/energy/energyDashboardService");
const energyReadingsService = require("../services/energy/energyReadingsService");
const energyAggregationService = require("../services/energy/energyAggregationService");

router.use(authenticate, requirePermission("system.energy"));

router.get(
  "/parameters",
  disableHttpCache,
  asyncHandler(async (_req, res) => {
    res.sendSuccess(getEnergyParametersPayload());
  }),
);

router.get(
  "/settings",
  disableHttpCache,
  asyncHandler(async (_req, res) => {
    res.sendSuccess(await energySettingsService.getSettings());
  }),
);

router.put(
  "/settings",
  asyncHandler(async (req, res) => {
    res.sendSuccess(await energySettingsService.updateSettings(req.body || {}));
  }),
);

router.get(
  "/dashboard/summary",
  disableHttpCache,
  asyncHandler(async (_req, res) => {
    res.sendSuccess(await energyDashboardService.getDashboardSummary());
  }),
);

router.get(
  "/dashboard/trends",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    res.sendSuccess(
      await energyDashboardService.getTrends(String(req.query.range || "day")),
    );
  }),
);

router.get(
  "/dashboard/distribution",
  disableHttpCache,
  asyncHandler(async (_req, res) => {
    res.sendSuccess(await energyDashboardService.getDistribution());
  }),
);

router.get(
  "/dashboard/ranking",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    res.sendSuccess(
      await energyDashboardService.getRanking(parseInt(req.query.limit, 10) || 5),
    );
  }),
);

router.get(
  "/usage/aggregated",
  requireEnergyReportFullIfScoped(),
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const { config } = await energySettingsService.getSettings();
    let deviceIds = config.include_device_ids;
    if (req.query.deviceId) {
      deviceIds = [parseInt(req.query.deviceId, 10)];
    }
    const bucket = String(req.query.bucket || "hour");
    const startTime = req.query.startTime;
    const endTime = req.query.endTime || new Date().toISOString();
    if (!startTime) {
      return res.sendSuccess({ readings: [], meta: { source: "aggregated" } });
    }
    let rows = await energyAggregationService.queryAggregated({
      deviceIds,
      bucketType: bucket,
      startTime,
      endTime,
    });
    let source = "aggregated";
    if (rows.length === 0 && bucket === "hour") {
      source = "raw_computed";
      rows = [];
      for (const id of deviceIds) {
        rows.push(
          ...(await energyAggregationService.computeHourDeltasFromRaw(
            id,
            startTime,
            endTime,
          )),
        );
      }
    }
    res.sendSuccess({
      readings: rows.map((r) => ({
        deviceId: r.device_id,
        bucketType: r.bucket_type || bucket,
        timestamp: new Date(r.bucket_at).toISOString(),
        deltaEnergyKwh: r.delta_energy_kwh,
        deltaWaterM3: r.delta_water_m3,
        touPeakKwh: r.tou_peak_kwh,
        touSemiPeakKwh: r.tou_semi_peak_kwh,
        touOffPeakKwh: r.tou_off_peak_kwh,
        maxPowerKw: r.max_power_kw,
        maxDemandKw: r.max_demand_kw,
      })),
      meta: { source },
    });
  }),
);

router.get(
  "/readings",
  requireEnergyReportFullIfScoped(),
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const rows = await energyReadingsService.listReadings({
      deviceId: req.query.deviceId,
      startTime: req.query.startTime,
      endTime: req.query.endTime,
      limit: req.query.limit,
      order: req.query.order,
    });
    res.sendSuccess({
      readings: rows.map((r) => ({
        id: r.id,
        deviceId: r.device_id,
        deviceName: r.device_name,
        recordedAt: new Date(r.recorded_at).toISOString(),
        data: typeof r.data === "string" ? JSON.parse(r.data) : r.data,
      })),
    });
  }),
);

module.exports = router;
