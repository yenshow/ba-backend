const axios = require("axios");
const config = require("../config");
const C = require("../utils/apiErrorCodes");
const { isAppError } = require("../utils/AppError");
const { throwApiError } = require("../utils/apiErrorMeta");

const platformStatus = (statusCode) =>
  Number.isFinite(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : 502;

const platformCode = (message, statusCode, data) => {
  const fromData =
    data && typeof data.code === "string" ? data.code.trim() : "";
  if (fromData) return fromData;
  const status = platformStatus(statusCode);
  const msg = String(message || "");
  if (status === 403 && msg.includes("使用過")) return C.LICENSE_ALREADY_USED;
  if (status === 403 && msg.includes("停用")) return C.LICENSE_INACTIVE;
  return C.LICENSE_PLATFORM_ERROR;
};

const throwPlatformError = (message, { statusCode, data } = {}) => {
  const status = platformStatus(statusCode);
  throwApiError(platformCode(message, status, data), message || "授權平台回傳錯誤", {
    statusCode: status,
    details: data ?? null,
  });
};

const getClient = () => {
  const baseURL = config.license?.platformApiBaseUrl;
  if (!baseURL) {
    throwApiError(
      C.LICENSE_PLATFORM_API_BASE_URL_MISSING,
      "LICENSE_PLATFORM_API_BASE_URL 未設定",
      { statusCode: 500 },
    );
  }
  return axios.create({
    baseURL,
    timeout: config.license?.platformTimeoutMs ?? 8000,
  });
};

const unwrapResult = (data) => {
  if (!data || typeof data !== "object") return null;
  if (data.success === true && data.result && typeof data.result === "object") {
    return data.result;
  }
  if (data.success === false) {
    throwPlatformError(data.message || "授權平台回傳錯誤", {
      statusCode: data.statusCode,
      data,
    });
  }
  throwPlatformError("授權平台回傳格式不正確", { data });
};

const activateOnline = async ({ licenseKey, deviceFingerprint } = {}) => {
  if (!licenseKey || typeof licenseKey !== "string") {
    throwApiError(
      C.LICENSE_PLATFORM_LICENSE_KEY_REQUIRED,
      "licenseKey 必須為字串",
    );
  }
  if (!deviceFingerprint || typeof deviceFingerprint !== "string") {
    throwApiError(
      C.LICENSE_PLATFORM_DEVICE_FINGERPRINT_REQUIRED,
      "deviceFingerprint 必須為字串",
    );
  }
  const client = getClient();
  const payload = {
    licenseKey: licenseKey.trim(),
    deviceFingerprint: deviceFingerprint.trim(),
  };
  try {
    const res = await client.post("/activate", payload);
    const result = unwrapResult(res.data);
    if (!Array.isArray(result.features)) {
      throwApiError(
        C.LICENSE_PLATFORM_INVALID_RESPONSE,
        "授權平台回傳格式不正確",
        { statusCode: 502 },
      );
    }
    return result;
  } catch (error) {
    if (isAppError(error)) throw error;
    const statusCode = error?.response?.status;
    const data = error?.response?.data;
    const message = data?.message || error?.message || "授權平台啟用失敗";
    throwPlatformError(message, { statusCode, data });
  }
};

module.exports = {
  activateOnline,
};
