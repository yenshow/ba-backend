const C = require("../utils/apiErrorCodes");
const { sendFailure } = require("./responseHandler");
const logger = require("../utils/logger").createLogger("RateLimit");
const config = require("../config");

/** @type {Map<string, { count: number, resetAt: number }>} */
const apiBuckets = new Map();
/** @type {Map<string, { count: number, resetAt: number }>} */
const loginFailureBuckets = new Map();

const WINDOW_MS = config.rateLimit?.windowMs ?? 15 * 60 * 1000;
const LOGIN_MAX_FAILED = 10;
const API_MAX = config.rateLimit?.max ?? 3000;
const RATE_LIMIT_LOG_COOLDOWN_MS = 30_000;

/** @type {Map<string, number>} */
const lastRateLimitLogAt = new Map();

const getPathWithoutQuery = (req) =>
  String(req.originalUrl || req.url || "").split("?")[0];

/** 已登入電梯 live（mount／visibility 偶發 GET）不計入全站限流 */
const isAuthenticatedElevatorLiveGet = (req) => {
  if (req.method !== "GET" || !req.headers.authorization) return false;
  const path = getPathWithoutQuery(req);
  return /^\/api\/elevator\/sites\/\d+\/live$/.test(path);
};

/**
 * 已登入設備同步 job 進度 GET（長跑輪詢）不計入全站限流。
 * 不含 POST 啟動 job、亦不含 license-plates 列表。
 */
const isAuthenticatedDeviceSyncJobGet = (req) => {
  if (req.method !== "GET" || !req.headers.authorization) return false;
  const path = getPathWithoutQuery(req);
  return (
    /^\/api\/personnel\/sync-location\/jobs\/[^/]+(?:\/items)?$/.test(path) ||
    /^\/api\/personnel\/sync-all-locations\/jobs\/[^/]+$/.test(path) ||
    /^\/api\/elevator\/sync-location\/jobs\/[^/]+$/.test(path)
  );
};

/** 中控室 token 滑動續期不計入全站限流 */
const isSessionRefreshPost = (req) =>
  req.method === "POST" &&
  getPathWithoutQuery(req).endsWith("/users/refresh");

/**
 * 已登入殼層 bootstrap GET：限流後守衛會反覆重抓，形成 429 死亡螺旋。
 * 僅精確路徑；不含 license activate／modules 其他寫入。
 */
const isAuthenticatedShellBootstrapGet = (req) => {
  if (req.method !== "GET" || !req.headers.authorization) return false;
  const path = getPathWithoutQuery(req);
  return (
    path === "/api/users/me" ||
    path === "/api/license" ||
    path === "/api/modules/registry"
  );
};

/** @param {import('express').Request} req */
const shouldSkipApiRateLimit = (req) => {
  if (req.method === "GET" && getPathWithoutQuery(req).startsWith("/api/uploads")) {
    return true;
  }
  if (isSessionRefreshPost(req)) return true;
  if (isAuthenticatedElevatorLiveGet(req)) return true;
  if (isAuthenticatedDeviceSyncJobGet(req)) return true;
  if (isAuthenticatedShellBootstrapGet(req)) return true;
  return false;
};

const rateLimitHandler = (req, res) =>
  sendFailure(
    res,
    {
      code: C.RATE_LIMIT_EXCEEDED,
      message: "請求過於頻繁，請稍後再試",
      details: null,
    },
    429,
  );

const getClientIpKey = (req) =>
  String(req.ip || req.socket?.remoteAddress || "unknown");

const getRequestPath = (req) => String(req.originalUrl || req.url || "");

const getLoginUsernameFromRequest = (req) => {
  const username = String(req.body?.username ?? "").trim();
  return username || undefined;
};

const shouldCooldownLog = (key) => {
  const now = Date.now();
  const lastAt = lastRateLimitLogAt.get(key);
  if (lastAt !== undefined && now - lastAt < RATE_LIMIT_LOG_COOLDOWN_MS) {
    return true;
  }
  lastRateLimitLogAt.set(key, now);
  if (lastRateLimitLogAt.size > 2000) {
    for (const [k, ts] of lastRateLimitLogAt.entries()) {
      if (now - ts > RATE_LIMIT_LOG_COOLDOWN_MS) {
        lastRateLimitLogAt.delete(k);
      }
    }
  }
  return false;
};

const logRateLimitIfAllowed = (message, meta) => {
  const ip = meta?.ip ?? "unknown";
  const path = meta?.path ?? "";
  const key = `${message}|${ip}|${path}`;
  if (shouldCooldownLog(key)) return;
  logger.warn(message, meta);
};

const respondRateLimited = (req, res, message, meta) => {
  logRateLimitIfAllowed(message, meta);
  const ip = getClientIpKey(req);
  const bucket = apiBuckets.get(ip);
  if (bucket) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000));
    res.setHeader("Retry-After", String(retryAfterSec));
  }
  return rateLimitHandler(req, res);
};

/** @param {Map<string, { count: number, resetAt: number }>} store */
const bumpBucket = (store, key, windowMs) => {
  const now = Date.now();
  let bucket = store.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    store.set(key, bucket);
  }
  bucket.count += 1;
  return bucket;
};

/** 超限時可放行：已帶 Authorization 的 GET（避免 SPA 讀取整站卡死） */
const shouldSoftPassOverLimit = (req) =>
  Boolean(req?.headers?.authorization) &&
  String(req?.method || "GET").toUpperCase() === "GET";

/**
 * @param {{ windowMs: number, max: number, skip?: (req: import('express').Request) => boolean }} options
 */
function createRateLimiter(options) {
  const { windowMs, max, skip } = options;

  return (req, res, next) => {
    if (typeof skip === "function" && skip(req)) {
      return next();
    }
    const ip = getClientIpKey(req);
    const bucket = bumpBucket(apiBuckets, ip, windowMs);
    if (bucket.count > max) {
      if (shouldSoftPassOverLimit(req)) {
        logRateLimitIfAllowed("API 限流中（放行已登入 GET）", {
          ip,
          path: getRequestPath(req),
          count: bucket.count,
        });
        return next();
      }
      return respondRateLimited(req, res, "API 限流觸發", {
        ip,
        path: getRequestPath(req),
        count: bucket.count,
      });
    }
    return next();
  };
}

/** 登入前檢查：僅累計認證失敗；成功登入不計入 */
const loginRateLimitPrecheck = (req, res, next) => {
  const ip = getClientIpKey(req);
  const bucket = loginFailureBuckets.get(ip);
  const now = Date.now();
  if (bucket && now < bucket.resetAt && bucket.count >= LOGIN_MAX_FAILED) {
    const meta = { ip, count: bucket.count };
    const username = getLoginUsernameFromRequest(req);
    if (username) meta.username = username;
    return respondRateLimited(req, res, "登入失敗次數達上限，暫時封鎖", meta);
  }
  return next();
};

/** 密碼錯誤等 USER_AUTH_FAILED 時由 userRoutes 呼叫 */
const recordFailedLoginAttempt = (req) => {
  const ip = getClientIpKey(req);
  const bucket = bumpBucket(loginFailureBuckets, ip, WINDOW_MS);
  const meta = { ip, count: bucket.count };
  const username = getLoginUsernameFromRequest(req);
  if (username) meta.username = username;
  logger.warn("登入失敗", meta);
};

const apiRateLimiter = createRateLimiter({
  windowMs: WINDOW_MS,
  max: API_MAX,
  skip: shouldSkipApiRateLimit,
});

module.exports = {
  loginRateLimitPrecheck,
  recordFailedLoginAttempt,
  apiRateLimiter,
  shouldSkipApiRateLimit,
  shouldSoftPassOverLimit,
  createRateLimiter,
  /** @internal 測試用 */
  _resetApiBucketsForTests: () => apiBuckets.clear(),
};
