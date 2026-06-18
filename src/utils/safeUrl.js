const dns = require("dns").promises;
const net = require("net");
const { URL } = require("url");
const C = require("./apiErrorCodes");
const { throwApiError } = require("./apiErrorMeta");

const DEFAULT_ALLOWED_PORTS = new Set([80, 443]);

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

function isPrivateIpv4(ip) {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return true;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("fe80")) return true;
  }
  return true;
}

function assertAllowedPort(port, allowedPorts = DEFAULT_ALLOWED_PORTS) {
  if (!allowedPorts.has(port)) {
    throwApiError(C.VALIDATION_CUSTOM, `不允許的外部 URL 連接埠：${port}`);
  }
}

function assertHostnameNotBlocked(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) {
    throwApiError(C.VALIDATION_CUSTOM, "外部 URL 缺少主機名稱");
  }
  if (BLOCKED_HOSTNAMES.has(host)) {
    throwApiError(C.VALIDATION_CUSTOM, "不允許的外部 URL 主機");
  }
  if (host.endsWith(".local") || host.endsWith(".internal")) {
    throwApiError(C.VALIDATION_CUSTOM, "不允許的外部 URL 主機");
  }
}

async function assertResolvedIpsSafe(hostname) {
  let addresses = [];
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throwApiError(C.VALIDATION_CUSTOM, "無法解析外部 URL 主機");
  }
  if (!addresses.length) {
    throwApiError(C.VALIDATION_CUSTOM, "無法解析外部 URL 主機");
  }
  for (const entry of addresses) {
    if (isPrivateIp(entry.address)) {
      throwApiError(C.VALIDATION_CUSTOM, "不允許存取內部或保留位址");
    }
  }
}

/**
 * 驗證可對外 fetch 的 http(s) URL（SSRF 防護）
 * @param {string} rawUrl
 * @param {{ allowedPorts?: Set<number> }} [options]
 */
async function assertSafeOutboundUrl(rawUrl, options = {}) {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) {
    throwApiError(C.VALIDATION_CUSTOM, "外部 URL 不可為空");
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throwApiError(C.VALIDATION_CUSTOM, "外部 URL 格式不正確");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throwApiError(C.VALIDATION_CUSTOM, "外部 URL 僅允許 http 或 https");
  }

  if (parsed.username || parsed.password) {
    throwApiError(C.VALIDATION_CUSTOM, "外部 URL 不可包含使用者資訊");
  }

  const allowedPorts = options.allowedPorts || DEFAULT_ALLOWED_PORTS;
  const port = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  assertAllowedPort(port, allowedPorts);

  const hostname = parsed.hostname;
  assertHostnameNotBlocked(hostname);

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throwApiError(C.VALIDATION_CUSTOM, "不允許存取內部或保留位址");
    }
    return parsed;
  }

  await assertResolvedIpsSafe(hostname);
  return parsed;
}

function isExternalHttpUrl(value) {
  const trimmed = String(value || "").trim();
  return /^https?:\/\//i.test(trimmed);
}

module.exports = {
  assertSafeOutboundUrl,
  isExternalHttpUrl,
  isPrivateIp,
};
