const db = require("../../database/db");
const locationService = require("./locationService");
const logger = require("../../utils/logger");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const { rethrowIfApiError } = require("../../utils/apiErrorMeta");

const envServiceLogger = logger.createLogger("environmentService");

async function getZones() {
  try {
    const result = await locationService.getZones({
      locationType: "environment",
    });
    return { zones: result.zones };
  } catch (error) {
    rethrowIfApiError(error);
    envServiceLogger.error("取得區域列表失敗", {
      error: error?.message || String(error),
      module: "environmentService",
    });
    throwApiError(C.LOCATION_ZONE_LIST_FAILED, "取得區域列表失敗: " + error.message, {
      statusCode: 500,
      details: error.message,
    });
  }
}

async function getZoneById(id) {
  try {
    const result = await locationService.getZoneById(id, "environment");
    return { zone: result.zone };
  } catch (error) {
    rethrowIfApiError(error);
    envServiceLogger.error("取得區域失敗", {
      id,
      error: error?.message || String(error),
      module: "environmentService",
    });
    throwApiError(C.LOCATION_ZONE_GET_FAILED, "取得區域失敗: " + error.message, {
      statusCode: 500,
      details: error.message,
    });
  }
}

async function createZone(zoneData, userId) {
  try {
    const { locations = [] } = zoneData;
    const unifiedLocations = locations.map((loc) => ({
      ...loc,
      locationType: "environment",
    }));

    const result = await locationService.createZone(
      {
        ...zoneData,
        locations: unifiedLocations,
      },
      userId,
    );
    return {
      merged: result.merged,
      message: result.message,
      zone: result.zone,
    };
  } catch (error) {
    rethrowIfApiError(error);
    envServiceLogger.error("建立區域失敗", {
      error: error?.message || String(error),
      module: "environmentService",
    });
    throwApiError(C.LOCATION_ZONE_CREATE_FAILED, "建立區域失敗: " + error.message, {
      statusCode: 500,
      details: error.message,
    });
  }
}

async function updateZone(id, zoneData, userId) {
  try {
    const { name, locations } = zoneData;
    const unifiedLocations = locations
      ? locations.map((loc) => ({
          ...loc,
          locationType: "environment",
        }))
      : undefined;

    const result = await locationService.updateZone(
      id,
      {
        ...(name !== undefined && { name }),
        locations: unifiedLocations,
      },
      userId,
    );
    return {
      merged: result.merged,
      message: result.message,
      zone: result.zone,
    };
  } catch (error) {
    rethrowIfApiError(error);
    envServiceLogger.error("更新區域失敗", {
      id,
      error: error?.message || String(error),
      module: "environmentService",
    });
    throwApiError(C.LOCATION_ZONE_UPDATE_FAILED, "更新區域失敗: " + error.message, {
      statusCode: 500,
      details: error.message,
    });
  }
}

async function deleteZone(id) {
  try {
    return await locationService.deleteZone(id);
  } catch (error) {
    rethrowIfApiError(error);
    envServiceLogger.error("刪除區域失敗", {
      id,
      error: error?.message || String(error),
      module: "environmentService",
    });
    throwApiError(C.LOCATION_ZONE_DELETE_FAILED, "刪除區域失敗: " + error.message, {
      statusCode: 500,
      details: error.message,
    });
  }
}

async function getReadings(locationId, options = {}) {
  try {
    const { startTime, endTime, limit = 1000 } = options;

    let query = `
      SELECT recorded_at as timestamp, data
      FROM environment_readings
      WHERE location_id = $1
    `;
    const params = [parseInt(locationId, 10)];
    let paramIndex = 2;

    if (startTime) {
      query += ` AND recorded_at >= $${paramIndex++}`;
      params.push(new Date(startTime));
    }

    if (endTime) {
      query += ` AND recorded_at < $${paramIndex++}`;
      params.push(new Date(endTime));
    }

    query += ` ORDER BY recorded_at ASC LIMIT $${paramIndex}`;
    params.push(limit);

    const rows = await db.query(query, params);

    return {
      readings: rows.map((r) => {
        const data =
          typeof r.data === "object" ? r.data : r.data ? JSON.parse(r.data) : {};
        const ts =
          r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp);
        return {
          id: `env_${locationId}_${ts.getTime()}`,
          locationId: String(locationId),
          timestamp: ts.toISOString(),
          data,
          createdAt: ts.toISOString(),
        };
      }),
    };
  } catch (error) {
    rethrowIfApiError(error);
    envServiceLogger.error("取得讀數失敗", {
      locationId,
      error: error?.message || String(error),
      module: "environmentService",
    });
    throwApiError(
      C.ENVIRONMENT_READINGS_LIST_FAILED,
      "取得讀數失敗: " + error.message,
      { statusCode: 500, details: error.message },
    );
  }
}

async function getReadingsAggregated(locationId, options = {}) {
  try {
    const { bucket, startTime, endTime } = options;
    if (!bucket || !["hour", "day", "month"].includes(bucket)) {
      throwApiError(
        C.ENVIRONMENT_BUCKET_INVALID,
        "bucket 必填且為 hour、day 或 month",
      );
    }
    const locId = parseInt(locationId, 10);
    let query = `
      SELECT bucket_at as timestamp, data
      FROM environment_readings_aggregated
      WHERE location_id = $1 AND bucket_type = $2
    `;
    const params = [locId, bucket];
    let paramIndex = 3;
    if (startTime) {
      query += ` AND bucket_at >= $${paramIndex++}`;
      params.push(new Date(startTime));
    }
    if (endTime) {
      query += ` AND bucket_at < $${paramIndex++}`;
      params.push(new Date(endTime));
    }
    query += ` ORDER BY bucket_at ASC`;
    const rows = await db.query(query, params);
    return {
      readings: (rows || []).map((r) => {
        const data =
          typeof r.data === "object" ? r.data : r.data ? JSON.parse(r.data) : {};
        const ts =
          r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp);
        return {
          id: `agg_${locationId}_${bucket}_${ts.getTime()}`,
          locationId: String(locationId),
          timestamp: ts.toISOString(),
          data,
          createdAt: ts.toISOString(),
        };
      }),
    };
  } catch (error) {
    rethrowIfApiError(error);
    envServiceLogger.error("取得彙總讀數失敗", {
      locationId,
      bucket: options?.bucket,
      error: error?.message || String(error),
      module: "environmentService",
    });
    throwApiError(
      C.ENVIRONMENT_READINGS_AGGREGATED_FAILED,
      "取得彙總讀數失敗: " + error.message,
      { statusCode: 500, details: error.message },
    );
  }
}

module.exports = {
  getZones,
  getZoneById,
  createZone,
  updateZone,
  deleteZone,
  getReadings,
  getReadingsAggregated,
};
