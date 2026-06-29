const C = require("../utils/apiErrorCodes");
const { sendFailure } = require("./responseHandler");

/** @type {Map<string, { count: number, resetAt: number }>} */
const apiBuckets = new Map();
/** @type {Map<string, { count: number, resetAt: number }>} */
const loginFailureBuckets = new Map();

const WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILED = 10;
const API_MAX = 300;

/** 已登入電梯 live（mount／visibility 偶發 GET）不計入全站限流 */
const isAuthenticatedElevatorLiveGet = (req) => {
  if (req.method !== "GET" || !req.headers.authorization) return false;
  const path = String(req.originalUrl || req.url || "").split("?")[0];
  return /^\/api\/elevator\/sites\/\d+\/live$/.test(path);
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
    const bucket = bumpBucket(apiBuckets, getClientIpKey(req), windowMs);
    if (bucket.count > max) {
      return rateLimitHandler(req, res);
    }
    return next();
  };
}

/** 登入前檢查：僅累計認證失敗；成功登入不計入 */
const loginRateLimitPrecheck = (req, res, next) => {
  const key = getClientIpKey(req);
  const bucket = loginFailureBuckets.get(key);
  const now = Date.now();
  if (bucket && now < bucket.resetAt && bucket.count >= LOGIN_MAX_FAILED) {
    return rateLimitHandler(req, res);
  }
  return next();
};

/** 密碼錯誤等 USER_AUTH_FAILED 時由 userRoutes 呼叫 */
const recordFailedLoginAttempt = (req) => {
  bumpBucket(loginFailureBuckets, getClientIpKey(req), WINDOW_MS);
};

const apiRateLimiter = createRateLimiter({
  windowMs: WINDOW_MS,
  max: API_MAX,
  skip: (req) => {
    const url = String(req.originalUrl || req.url || "");
    if (req.method === "GET" && url.startsWith("/api/uploads")) return true;
    return isAuthenticatedElevatorLiveGet(req);
  },
});

module.exports = {
  loginRateLimitPrecheck,
  recordFailedLoginAttempt,
  apiRateLimiter,
};
