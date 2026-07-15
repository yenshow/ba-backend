/**
 * ISAPI 設備 HTTP 客戶端（Digest Auth）
 * 含：一般 axios 請求、訂閱長連線用 raw TCP HTTP（部分設備非標準標頭）
 */
const net = require("net");
const { PassThrough } = require("stream");
const axios = require("axios");
const crypto = require("crypto");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

/** 即時布防：僅推送連線建立後的即時事件（subscribeEvent?deployID=1） */
const ISAPI_DEPLOY_ID_REALTIME = 1;
const CRLFCRLF = Buffer.from("\r\n\r\n");
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/* ---------- raw TCP HTTP（訂閱長連線） ---------- */

const parseHttpHeaders = (headerBlock) => {
  const lines = headerBlock.split(/\r\n/);
  const statusMatch = (lines[0] || "").match(/^HTTP\/\d(?:\.\d)? (\d{3})/i);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  const headers = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${val}` : val;
  }
  return { status, headers };
};

const readStreamToBuffer = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

const rawHttpStream = ({
  host,
  port,
  method,
  path,
  headers = {},
  body,
  keepAlive = false,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  timeoutLabel = "ISAPI 請求",
}) =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timeout = setTimeout(() => {
      socket.destroy();
      finish(() =>
        reject(new Error(`${timeoutLabel}逾時（${requestTimeoutMs}ms）`)),
      );
    }, requestTimeoutMs);

    socket.on("connect", () => {
      const headerLines = [
        `${method.toUpperCase()} ${path} HTTP/1.1`,
        `Host: ${host}`,
        `Connection: ${keepAlive ? "keep-alive" : "close"}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        "",
        "",
      ];
      socket.write(headerLines.join("\r\n"));
      if (body != null) socket.write(body);
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headEnd = buffer.indexOf(CRLFCRLF);
      if (headEnd === -1) return;

      clearTimeout(timeout);
      const headerBlock = buffer.slice(0, headEnd).toString("latin1");
      const bodyStart = headEnd + 4;
      const parsed = parseHttpHeaders(headerBlock);
      const stream = new PassThrough();
      const remainder = buffer.slice(bodyStart);
      if (remainder.length) stream.write(remainder);

      socket.removeAllListeners("data");
      socket.on("data", (c) => stream.write(c));
      socket.on("end", () => stream.end());
      socket.on("error", (e) => stream.destroy(e));

      finish(() =>
        resolve({
          status: parsed.status,
          headers: parsed.headers,
          data: stream,
        }),
      );
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      finish(() => reject(err));
    });
  });

const fetchDigestChallenge = async ({
  host,
  port,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) => {
  const res = await rawHttpStream({
    host,
    port,
    method: "GET",
    path: "/ISAPI/System/deviceInfo",
    requestTimeoutMs,
  });
  await readStreamToBuffer(res.data);

  if (res.status !== 401 || !res.headers["www-authenticate"]) {
    throw new Error(
      `預期設備回傳 401 Digest 挑戰，實際 HTTP ${res.status || "(unknown)"}`,
    );
  }

  const authHeader = res.headers["www-authenticate"];
  if (!String(authHeader).toLowerCase().startsWith("digest ")) {
    throw new Error(`不支援的認證方式: ${String(authHeader).split(" ")[0]}`);
  }

  return authHeader;
};

const requestSubscribePost = (options) =>
  rawHttpStream({
    ...options,
    method: "POST",
    keepAlive: true,
    timeoutLabel: "ISAPI 訂閱回應標頭",
  });

/* ---------- Digest Auth + axios 客戶端 ---------- */

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
    const status = res.status;
    const code =
      status >= 500
        ? C.BAD_GATEWAY
        : C.ACCESS_CONTROL_ISAPI_INVALID_RESPONSE;
    throwApiError(code, msg, {
      statusCode: status >= 400 && status <= 599 ? status : 502,
      details: fallbackBody ? { status, body: fallbackBody } : { status },
    });
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
 * @returns {object} - { request(options), requestSubscribeStream(xmlBody, options) }
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
      throwApiError(
        C.ACCESS_CONTROL_ISAPI_DIGEST_CHALLENGE_EXPECTED,
        "預期設備回傳 401 Digest 挑戰",
      );
    }
    const authHeader = probeRes.headers["www-authenticate"];
    if (!authHeader.toLowerCase().startsWith("digest ")) {
      throwApiError(
        C.ACCESS_CONTROL_ISAPI_AUTH_UNSUPPORTED,
        `不支援的認證方式: ${authHeader.split(" ")[0]}`,
      );
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
      timeout: 15000,
    };
    if (data !== undefined) {
      config.data = typeof data === "string" ? data : JSON.stringify(data);
    }
    if (responseType) config.responseType = responseType;

    let res = await axios(config);
    if (res.status === 401 && res.headers["www-authenticate"]) {
      const authHeader = res.headers["www-authenticate"];
      if (!authHeader.toLowerCase().startsWith("digest ")) {
        throwApiError(
          C.ACCESS_CONTROL_ISAPI_AUTH_UNSUPPORTED,
          `不支援的認證方式: ${authHeader.split(" ")[0]}`,
        );
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
   * 訂閱事件長連線：POST subscribeEvent?deployID=1（即時布防，預設不補傳快取事件）。
   * @param {string} xmlBody - SubscribeEvent XML 字串
   * @param {object} [options]
   * @param {0|1} [options.deployID=1]
   * @returns {Promise<{ status: number, headers: object, data: import('stream').Readable }>}
   */
  async function requestSubscribeStream(xmlBody, options = {}) {
    const { deployID = ISAPI_DEPLOY_ID_REALTIME } = options;
    const path = `/ISAPI/Event/notification/subscribeEvent?deployID=${deployID}`;
    const authHeader = await fetchDigestChallenge({ host, port });
    const challenge = parseDigestChallenge(authHeader);
    const digestAuth = buildAuthHeader(
      challenge,
      "POST",
      path,
      username,
      password,
    );

    const res = await requestSubscribePost({
      host,
      port,
      path,
      headers: {
        "Content-Type": "application/xml",
        Authorization: digestAuth,
        "Content-Length": String(Buffer.byteLength(xmlBody)),
      },
      body: xmlBody,
    });

    if (res.status >= 400) {
      const buf = await readStreamToBuffer(res.data);
      const preview =
        typeof buf === "string"
          ? buf.slice(0, 500)
          : buf.toString("utf8").slice(0, 500);
      throwApiError(
        C.ACCESS_CONTROL_ISAPI_INVALID_RESPONSE,
        preview || `HTTP ${res.status}`,
        {
          statusCode: res.status,
          details: preview
            ? { status: res.status, body: preview }
            : { status: res.status },
        },
      );
    }

    return {
      status: res.status,
      headers: res.headers,
      data: res.data,
    };
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
  buildAuthHeader,
};
