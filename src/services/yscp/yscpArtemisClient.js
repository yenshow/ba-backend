/**
 * YSCP Artemis API 共用 HTTP 客戶端（簽名與 POST）
 */
const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const config = require("../../config");

const buildSignature = (secretKey, path, method = "POST") => {
  const accept = "application/json";
  const contentType = "application/json;charset=UTF-8";
  const plain = `${method}\n${accept}\n${contentType}\n${path}`;
  return crypto.createHmac("sha256", secretKey).update(plain).digest("base64");
};

const artemisPath = (apiVersion, action) =>
  `/artemis/api/eventService/${apiVersion}/${action}`;

const resolveCredentials = (overrides = {}) => ({
  host: overrides.host || config.yscp.host,
  accessKey: overrides.accessKey ?? config.yscp.accessKey,
  secretKey: overrides.secretKey ?? config.yscp.secretKey,
  apiVersion: overrides.apiVersion || config.yscp.apiVersion,
  rejectUnauthorized:
    overrides.rejectUnauthorized ?? config.yscp.rejectUnauthorized,
});

/**
 * @param {string} path - Artemis API path（含 /artemis/...）
 * @param {object} body
 * @param {object} [options]
 * @param {object} [options.credentials] - 覆寫 host/AK/SK（供維運腳本）
 * @param {number} [options.timeout]
 * @param {string} [options.responseType]
 * @param {boolean} [options.validateStatus]
 */
const post = async (path, body = {}, options = {}) => {
  const creds = resolveCredentials(options.credentials);
  const fullUrl = `${creds.host}${path}`;
  const axiosOptions = {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json;charset=UTF-8",
      "X-Ca-Key": creds.accessKey,
      "X-Ca-Signature": buildSignature(creds.secretKey, path),
    },
    httpsAgent: new https.Agent({
      rejectUnauthorized: creds.rejectUnauthorized,
    }),
    timeout: options.timeout ?? 30000,
  };

  if (options.responseType) {
    axiosOptions.responseType = options.responseType;
  }
  if (options.validateStatus !== undefined) {
    axiosOptions.validateStatus = options.validateStatus;
  }

  return axios.post(fullUrl, body, axiosOptions);
};

module.exports = {
  artemisPath,
  resolveCredentials,
  post,
};
