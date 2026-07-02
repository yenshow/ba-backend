/**
 * ISAPI 長連線訂閱用 raw TCP HTTP（手動解析標頭）。
 * 部分門禁／攝影機回應含非標準 HTTP 標頭，axios／http 會拋 Parse Error: Invalid header token。
 */
const net = require("net");
const { PassThrough } = require("stream");

const CRLFCRLF = Buffer.from("\r\n\r\n");
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

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

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  fetchDigestChallenge,
  readStreamToBuffer,
  requestSubscribePost,
};
