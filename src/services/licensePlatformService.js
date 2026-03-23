const axios = require("axios");
const config = require("../config");

class LicensePlatformHttpError extends Error {
  constructor(message, { statusCode, data } = {}) {
    super(message);
    this.name = "LicensePlatformHttpError";
    this.statusCode = statusCode;
    this.data = data;
  }
}

const getClient = () => {
  const baseURL = config.license?.platformApiBaseUrl;
  if (!baseURL) {
    throw new Error("LICENSE_PLATFORM_API_BASE_URL 未設定");
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
    throw new LicensePlatformHttpError(data.message || "授權平台回傳錯誤", {
      statusCode: data.statusCode,
      data,
    });
  }
  throw new LicensePlatformHttpError("授權平台回傳格式不正確", { data });
};

const activateOnline = async ({ licenseKey, deviceFingerprint } = {}) => {
  if (!licenseKey || typeof licenseKey !== "string") {
    throw new Error("licenseKey 必須為字串");
  }
  if (!deviceFingerprint || typeof deviceFingerprint !== "string") {
    throw new Error("deviceFingerprint 必須為字串");
  }
  const client = getClient();
  const payload = {
    licenseKey: licenseKey.trim(),
    deviceFingerprint: deviceFingerprint.trim(),
  };
  try {
    const res = await client.post("/activate", payload);
    return unwrapResult(res.data);
  } catch (error) {
    if (error instanceof LicensePlatformHttpError) throw error;
    const statusCode = error?.response?.status;
    const data = error?.response?.data;
    const message = data?.message || error?.message || "授權平台啟用失敗";
    throw new LicensePlatformHttpError(message, { statusCode, data });
  }
};

module.exports = {
  activateOnline,
  LicensePlatformHttpError,
};
