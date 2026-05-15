/**
 * 設備／型號／Modbus 相關錯誤輔助（與 apiErrorCodes 搭配）
 */
const C = require("./apiErrorCodes");
const { throwApiError, rethrowIfApiError } = require("./apiErrorMeta");

function failOp(code, message, details) {
  throwApiError(code, message, { details: details ?? null });
}

function deviceConfigInvalid(message, details = null) {
  throwApiError(C.DEVICE_CONFIG_INVALID, message, { details });
}

module.exports = {
  rethrowIfApiError,
  deviceConfigInvalid,
  failDeviceList: (message, details) => failOp(C.DEVICE_LIST_FAILED, message, details),
  failDeviceGet: (message, details) => failOp(C.DEVICE_GET_FAILED, message, details),
  failDeviceCreate: (message, details) => failOp(C.DEVICE_CREATE_FAILED, message, details),
  failDeviceUpdate: (message, details) => failOp(C.DEVICE_UPDATE_FAILED, message, details),
  failDeviceDelete: (message, details) => failOp(C.DEVICE_DELETE_FAILED, message, details),
  failDeviceModelList: (message, details) =>
    failOp(C.DEVICE_MODEL_LIST_FAILED, message, details),
  failDeviceModelGet: (message, details) =>
    failOp(C.DEVICE_MODEL_GET_FAILED, message, details),
  failDeviceModelCreate: (message, details) =>
    failOp(C.DEVICE_MODEL_CREATE_FAILED, message, details),
  failDeviceModelUpdate: (message, details) =>
    failOp(C.DEVICE_MODEL_UPDATE_FAILED, message, details),
  failDeviceModelDelete: (message, details) =>
    failOp(C.DEVICE_MODEL_DELETE_FAILED, message, details),
  failDeviceTypeList: (message, details) =>
    failOp(C.DEVICE_TYPE_LIST_FAILED, message, details),
};
