/**
 * 全站 apiRateLimiter skip／超限放行（不依賴 HTTP server）
 *
 *   npm run test:security:rate-limit-skip
 */
const assert = require("node:assert/strict");
const {
  shouldSkipApiRateLimit,
  shouldSoftPassOverLimit,
  createRateLimiter,
  _resetApiBucketsForTests,
} = require("../../src/middleware/rateLimitMiddleware");

const mockReq = ({ method = "GET", url, authorization } = {}) => ({
  method,
  originalUrl: url,
  url,
  headers: authorization ? { authorization } : {},
});

const AUTH = "Bearer test-token";

const expectSkip = (req, expected, label) => {
  assert.equal(shouldSkipApiRateLimit(req), expected, label);
};

const runSkipTests = () => {
  expectSkip(mockReq({ url: "/api/uploads/faces/a.jpg" }), true, "uploads");
  expectSkip(
    mockReq({ url: "/api/uploads/faces/a.jpg?access_token=x" }),
    true,
    "uploads with query",
  );
  expectSkip(
    mockReq({ method: "POST", url: "/api/users/refresh", authorization: AUTH }),
    true,
    "refresh",
  );
  expectSkip(
    mockReq({ url: "/api/elevator/sites/12/live", authorization: AUTH }),
    true,
    "elevator live",
  );

  for (const url of [
    "/api/personnel/sync-location/jobs/syncloc_1",
    "/api/personnel/sync-location/jobs/syncloc_1/items",
    "/api/personnel/sync-location/jobs/syncloc_1/items?type=tail&limit=200",
    "/api/personnel/sync-all-locations/jobs/syncall_1",
    "/api/elevator/sync-location/jobs/elevator_sync_1",
  ]) {
    expectSkip(mockReq({ url, authorization: AUTH }), true, `skip ${url}`);
  }

  expectSkip(
    mockReq({ url: "/api/personnel/sync-location/jobs/syncloc_1" }),
    false,
    "job GET without Authorization",
  );
  expectSkip(
    mockReq({
      method: "POST",
      url: "/api/personnel/sync-location/9/job",
      authorization: AUTH,
    }),
    false,
    "POST start job",
  );
  expectSkip(
    mockReq({ url: "/api/users/me", authorization: AUTH }),
    true,
    "shell users/me",
  );
  expectSkip(
    mockReq({ url: "/api/license", authorization: AUTH }),
    true,
    "shell license",
  );
  expectSkip(
    mockReq({ url: "/api/modules/registry", authorization: AUTH }),
    true,
    "shell modules/registry",
  );
  expectSkip(mockReq({ url: "/api/users/me" }), false, "users/me without auth");
  expectSkip(
    mockReq({
      method: "POST",
      url: "/api/license/activate",
      authorization: AUTH,
    }),
    false,
    "license activate still counted",
  );
  expectSkip(
    mockReq({
      url: "/api/personnel/locations/3/license-plates",
      authorization: AUTH,
    }),
    false,
    "license-plates",
  );
};

const runSoftPassHelperTests = () => {
  assert.equal(
    shouldSoftPassOverLimit(mockReq({ url: "/api/alerts", authorization: AUTH })),
    true,
    "auth GET soft-pass",
  );
  assert.equal(
    shouldSoftPassOverLimit(
      mockReq({ method: "POST", url: "/api/alerts", authorization: AUTH }),
    ),
    false,
    "auth POST hard-block",
  );
  assert.equal(
    shouldSoftPassOverLimit(mockReq({ url: "/api/alerts" })),
    false,
    "unauth GET hard-block",
  );
};

const runOverLimitMiddlewareTests = () => {
  _resetApiBucketsForTests();
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
  let nextCount = 0;
  const next = () => {
    nextCount += 1;
  };
  const res = {
    setHeader() {},
    status() {
      return this;
    },
    json() {
      return this;
    },
  };

  limiter(mockReq({ url: "/api/a", authorization: AUTH }), res, next);
  limiter(mockReq({ url: "/api/b", authorization: AUTH }), res, next);
  assert.equal(nextCount, 2, "under max both next");

  nextCount = 0;
  limiter(mockReq({ url: "/api/c", authorization: AUTH }), res, next);
  assert.equal(nextCount, 1, "over max auth GET next");

  nextCount = 0;
  limiter(
    mockReq({ method: "POST", url: "/api/d", authorization: AUTH }),
    res,
    next,
  );
  assert.equal(nextCount, 0, "over max auth POST blocked");

  nextCount = 0;
  limiter(mockReq({ url: "/api/e" }), res, next);
  assert.equal(nextCount, 0, "over max unauth GET blocked");

  _resetApiBucketsForTests();
};

const run = () => {
  runSkipTests();
  runSoftPassHelperTests();
  runOverLimitMiddlewareTests();
  console.log("rateLimitSkip tests passed");
};

try {
  run();
} catch (err) {
  console.error(err);
  process.exit(1);
}
