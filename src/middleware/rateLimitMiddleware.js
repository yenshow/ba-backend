const C = require("../utils/apiErrorCodes");

/** @type {Map<string, { count: number, resetAt: number }>} */
const buckets = new Map();

const rateLimitHandler = (req, res) => {
  res.sendFailure(
    {
      code: C.RATE_LIMIT_EXCEEDED,
      message: "請求過於頻繁，請稍後再試",
      details: null,
    },
    429,
  );
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

    const key = String(req.ip || req.socket?.remoteAddress || "unknown");
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      return rateLimitHandler(req, res);
    }

    return next();
  };
}

/** POST /api/users/login：10 次 / 15 分鐘 / IP */
const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

/** 全域 API：300 次 / 15 分鐘 / IP；排除 GET /api/uploads */
const apiRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 300,
  skip: (req) => {
    const url = String(req.originalUrl || req.url || "");
    return req.method === "GET" && url.startsWith("/api/uploads");
  },
});

module.exports = {
  loginRateLimiter,
  apiRateLimiter,
};
