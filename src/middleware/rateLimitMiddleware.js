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
const API_MAX = config.rateLimit?.max ?? 300;
const RATE_LIMIT_LOG_COOLDOWN_MS = 30_000;

/** @type {Map<string, number>} */
const lastRateLimitLogAt = new Map();

/** 已登入電梯 live（mount／visibility 偶發 GET）不計入全站限流 */
const isAuthenticatedElevatorLiveGet = (req) => {
  if (req.method !== "GET" || !req.headers.authorization) return false;
  const path = String(req.originalUrl || req.url || "").split("?")[0];
  return /^\/api\/elevator\/sites\/\d+\/live$/.test(path);
};

/** 中控室 token 滑動續期不計入全站限流 */
const isSessionRefreshPost = (req) =>
  req.method === "POST" &&
  String(req.originalUrl || req.url || "")
    .split("?")[0]
    .endsWith("/users/refresh");

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
  skip: (req) => {
    const url = getRequestPath(req);
    if (req.method === "GET" && url.startsWith("/api/uploads")) return true;
    if (isSessionRefreshPost(req)) return true;
    return isAuthenticatedElevatorLiveGet(req);
  },
});

module.exports = {
  loginRateLimitPrecheck,
  recordFailedLoginAttempt,
  apiRateLimiter,
};
