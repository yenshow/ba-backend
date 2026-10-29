const os = require("os");

/**
 * 省略的 http port 與 :80、省略的 https port 與 :443 視為同一來源。
 * @param {string} origin
 * @returns {string}
 */
const normalizeOrigin = (origin) => {
  try {
    const url = new URL(origin);
    const isHttpDefault =
      url.protocol === "http:" && (url.port === "" || url.port === "80");
    const isHttpsDefault =
      url.protocol === "https:" && (url.port === "" || url.port === "443");
    const port = isHttpDefault || isHttpsDefault ? "" : `:${url.port}`;
    return `${url.protocol}//${url.hostname}${port}`;
  } catch {
    return String(origin || "");
  }
};

const withHttpAndHttps = (host) => [`http://${host}`, `https://${host}`];

/** 埠 80／443 前端的 Origin 不帶 port：本機與區網 IPv4（http 與 https）。 */
const builtinOrigins = () => {
  const origins = [
    ...withHttpAndHttps("127.0.0.1"),
    ...withHttpAndHttps("localhost"),
  ];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      const family = iface.family;
      const isIpv4 = family === "IPv4" || family === 4;
      if (isIpv4 && !iface.internal && iface.address) {
        origins.push(...withHttpAndHttps(iface.address));
      }
    }
  }
  return origins;
};

let cachedBuiltinOrigins = null;

const resetBuiltinOriginCache = () => {
  cachedBuiltinOrigins = null;
};

const getEffectiveOrigins = (configured) => {
  if (!cachedBuiltinOrigins) {
    cachedBuiltinOrigins = builtinOrigins();
  }
  const list = [
    ...(Array.isArray(configured) ? configured : []),
    ...cachedBuiltinOrigins,
  ];
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
};

/**
 * @param {string | undefined} origin
 * @param {string[]} configuredOrigins
 * @returns {boolean}
 */
const isOriginAllowed = (origin, configuredOrigins) => {
  if (!origin) return true;
  const allowed = getEffectiveOrigins(configuredOrigins);
  if (allowed.includes("*")) return true;
  const normalized = normalizeOrigin(origin);
  return allowed.some((item) => normalizeOrigin(item) === normalized);
};

module.exports = {
  normalizeOrigin,
  getEffectiveOrigins,
  isOriginAllowed,
  resetBuiltinOriginCache,
};
