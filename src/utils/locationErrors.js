/**
 * 地點／區域服務錯誤輔助
 */
const C = require("./apiErrorCodes");
const { throwApiError, rethrowIfApiError } = require("./apiErrorMeta");

function failOp(code, message, details) {
  throwApiError(code, message, { details: details ?? null });
}

module.exports = {
  rethrowIfApiError,
  failLocationZoneList: (message, details) =>
    failOp(C.LOCATION_ZONE_LIST_FAILED, message, details),
  failLocationZoneGet: (message, details) =>
    failOp(C.LOCATION_ZONE_GET_FAILED, message, details),
  failLocationZoneCreate: (message, details) =>
    failOp(C.LOCATION_ZONE_CREATE_FAILED, message, details),
  failLocationZoneUpdate: (message, details) =>
    failOp(C.LOCATION_ZONE_UPDATE_FAILED, message, details),
  failLocationZoneDelete: (message, details) =>
    failOp(C.LOCATION_ZONE_DELETE_FAILED, message, details),
  failLocationGet: (message, details) => failOp(C.LOCATION_GET_FAILED, message, details),
  failLocationCreate: (message, details) =>
    failOp(C.LOCATION_CREATE_FAILED, message, details),
  failLocationUpdate: (message, details) =>
    failOp(C.LOCATION_UPDATE_FAILED, message, details),
  failLocationDelete: (message, details) =>
    failOp(C.LOCATION_DELETE_FAILED, message, details),
};
