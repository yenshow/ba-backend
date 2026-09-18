const express = require("express");
const router = express.Router();
const pdaScanService = require("../services/pda/pdaScanService");
const isupListenService = require("../services/pda/isupListenService");
const asyncHandler = require("../utils/asyncHandler");

router.get("/status", (req, res) => {
  res.sendSuccess(isupListenService.getStatus());
});

router.get(
  "/scans",
  asyncHandler(async (req, res) => {
    const rows = await pdaScanService.listRecentScans({
      deviceCode: req.query.deviceCode,
      limit: req.query.limit,
    });
    res.sendSuccess({ scans: rows, total: rows.length });
  }),
);

module.exports = router;
