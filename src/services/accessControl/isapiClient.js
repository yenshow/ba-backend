/**
 * ISAPI 設備 HTTP 客戶端（Digest Auth）
 * 用於與門禁／人臉設備通訊，支援 401 Digest 挑戰後自動重試。
 */
const axios = require("axios");
const crypto = require("crypto");

/**
 * 解析 WWW-Authenticate: Digest 標頭
 * @param {string} header - WWW-Authenticate 標頭值
 * @returns {object} - { realm, nonce, qop, opaque?, algorithm? }
 */
function parseDigestChallenge(header) {
  const params = {};
  const regex = /(\w+)=(?:"([^"]+)"|([^\s,]+))/g;
  let m;
  while ((m = regex.exec(header)) !== null) {
    params[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return params;
}

/**
 * 計算 Digest Auth 的 response 值（RFC 2617）
 */
function buildDigestResponse({
  username,
  password,
  method,
  uri,
  realm,
  nonce,
  qop,
  nc,
  cnonce,
  opaque,
  algorithm,
}) {
  const md5 = (str) => crypto.createHash("md5").update(str).digest("hex");
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `qop=${qop}`,
    `nc=${nc}`,
    `cnonce="${cnonce}"`,
  ];
  if (opaque) parts.push(`opaque="${opaque}"`);
  if (algorithm) parts.push(`algorithm=${algorithm}`);
  return `Digest ${parts.join(", ")}`;
}

function throwIfBadStatus(res) {
  if (res.status >= 400) {
    const fallbackBody =
      res.data == null
        ? ""
        : typeof res.data === "string"
          ? res.data.slice(0, 500)
          : JSON.stringify(res.data).slice(0, 500);
    const msg =
      res.data?.message ||
      res.data?.error ||
      (fallbackBody
        ? `${res.statusText || `HTTP ${res.status}`}: ${fallbackBody}`
        : res.statusText || `HTTP ${res.status}`);
    const err = new Error(msg);
    err.statusCode = res.status;
    err.response = res;
    throw err;
  }
}

function buildAuthHeader(challenge, method, uri, username, password) {
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  return buildDigestResponse({
    username,
    password,
    method: method.toUpperCase(),
    uri,
    realm: challenge.realm || "",
    nonce: challenge.nonce || "",
    qop: challenge.qop || "auth",
    nc,
    cnonce,
    opaque: challenge.opaque,
    algorithm: challenge.algorithm,
  });
}

/**
 * 建立 ISAPI 客戶端
 * @param {object} deviceConfig - devices.config：{ host, port?, username, password }
 * @returns {object} - { request(options) }
 */
function createIsapiClient(deviceConfig) {
  const host = deviceConfig.host;
  const port =
    deviceConfig.port === undefined || deviceConfig.port === null
      ? 80
      : Number(deviceConfig.port) || 80;
  const username = deviceConfig.username;
  const password = deviceConfig.password;
  const baseURL = port === 80 ? `http://${host}` : `http://${host}:${port}`;

  async function requestWithPreemptiveDigest(options) {
    const { method, path, data, headers = {}, responseType } = options;
    const url = path.startsWith("http") ? path : `${baseURL}${path}`;
    const uri = new URL(url).pathname + new URL(url).search;

    const probeRes = await axios({
      method: "GET",
      url: baseURL + "/ISAPI/System/deviceInfo",
      validateStatus: () => true,
      timeout: 10000,
    });
    if (probeRes.status !== 401 || !probeRes.headers["www-authenticate"]) {
      throw new Error("預期設備回傳 401 Digest 挑戰");
    }
    const authHeader = probeRes.headers["www-authenticate"];
    if (!authHeader.toLowerCase().startsWith("digest ")) {
      throw new Error(`不支援的認證方式: ${authHeader.split(" ")[0]}`);
    }
    const challenge = parseDigestChallenge(authHeader);
    const digestAuth = buildAuthHeader(
      challenge,
      method,
      uri,
      username,
      password,
    );
    const config = {
      method,
      url,
      headers: { ...data.getHeaders(), ...headers, Authorization: digestAuth },
      data,
      validateStatus: (status) => status < 500,
      maxRedirects: 0,
      timeout: 60000,
    };
    if (responseType) config.responseType = responseType;
    const res = await axios(config);
    throwIfBadStatus(res);
    return res;
  }

  /**
   * 發送請求，遇 401 時以 Digest 重試一次；FormData 改為預先取得 nonce 再送一次。
   * 若傳入 data 為字串且 headers 含 Content-Type: application/xml，則以 XML 送出。
   */
  async function request(options) {
    const { method = "GET", path, data, headers = {}, responseType } = options;
    const url = path.startsWith("http") ? path : `${baseURL}${path}`;
    const isFormData = data && typeof data.getHeaders === "function";

    if (isFormData) {
      return requestWithPreemptiveDigest({
        method,
        path,
        data,
        headers,
        responseType,
      });
    }

    const contentType =
      headers["Content-Type"] || headers["content-type"] || "application/json";
    const config = {
      method,
      url,
      headers: { "Content-Type": contentType, ...headers },
      validateStatus: (status) => status < 500,
      maxRedirects: 0,
      timeout: 1000000,
    };
    if (data !== undefined) {
      config.data = typeof data === "string" ? data : JSON.stringify(data);
    }
    if (responseType) config.responseType = responseType;

    let res = await axios(config);
    if (res.status === 401 && res.headers["www-authenticate"]) {
      const authHeader = res.headers["www-authenticate"];
      if (!authHeader.toLowerCase().startsWith("digest ")) {
        throw new Error(`不支援的認證方式: ${authHeader.split(" ")[0]}`);
      }
      const challenge = parseDigestChallenge(authHeader);
      const uri = new URL(url).pathname + new URL(url).search;
      const digestAuth = buildAuthHeader(
        challenge,
        method,
        uri,
        username,
        password,
      );
      res = await axios({
        ...config,
        headers: { ...config.headers, Authorization: digestAuth },
      });
    }
    throwIfBadStatus(res);
    return res;
  }

  /**
   * 訂閱事件長連線：POST subscribeEvent，回傳 response（含 res.data 為 stream）。
   * 必須使用預先 Digest（無法在 stream 讀取後重試 401）。
   * @param {string} xmlBody - SubscribeEvent XML 字串
   * @returns {Promise<import('axios').AxiosResponse>} - res.data 為 Node stream
   */
  async function requestSubscribeStream(xmlBody) {
    const path = "/ISAPI/Event/notification/subscribeEvent";
    const url = `${baseURL}${path}`;
    const method = "POST";
    const uri = path;

    const probeRes = await axios({
      method: "GET",
      url: baseURL + "/ISAPI/System/deviceInfo",
      validateStatus: () => true,
      timeout: 10000,
    });
    if (probeRes.status !== 401 || !probeRes.headers["www-authenticate"]) {
      throw new Error("預期設備回傳 401 Digest 挑戰");
    }
    const authHeader = probeRes.headers["www-authenticate"];
    if (!authHeader.toLowerCase().startsWith("digest ")) {
      throw new Error(`不支援的認證方式: ${authHeader.split(" ")[0]}`);
    }
    const challenge = parseDigestChallenge(authHeader);
    const digestAuth = buildAuthHeader(
      challenge,
      method,
      uri,
      username,
      password,
    );

    const res = await axios({
      method,
      url,
      headers: {
        "Content-Type": "application/xml",
        Authorization: digestAuth,
      },
      data: xmlBody,
      responseType: "stream",
      validateStatus: (status) => status >= 200 && status < 400,
      maxRedirects: 0,
      timeout: 0,
    });
    return res;
  }

  return {
    request,
    requestSubscribeStream,
    baseURL,
  };
}

module.exports = {
  createIsapiClient,
  parseDigestChallenge,
  buildDigestResponse,
};
