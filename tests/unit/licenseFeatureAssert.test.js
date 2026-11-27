/**
 * 寫入路徑 Feature Gate：assertFeatureLicensed／assertSystemQuotaWithinLimit
 *
 *   node --test tests/unit/licenseFeatureAssert.test.js
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");

const licenseService = require("../../src/services/license/licenseService");
const licenseQuotaService = require("../../src/services/license/licenseQuotaService");
const C = require("../../src/utils/apiErrorCodes");

const stubLicense = (t, overrides = {}) => {
  t.mock.method(licenseService, "getLicenseState", async () => ({
    features: [],
    quotas: {},
    expired: false,
    activationMethod: null,
    ...overrides,
  }));
};

test("assertFeatureLicensed rejects unlicensed feature", async (t) => {
  stubLicense(t, { features: ["environment"] });
  await assert.rejects(
    () => licenseQuotaService.assertFeatureLicensed("lighting"),
    (err) => {
      assert.equal(err.code, C.FEATURE_NOT_LICENSED);
      assert.equal(err.details?.feature, "lighting");
      return true;
    },
  );
});

test("assertFeatureLicensed allows licensed feature", async (t) => {
  stubLicense(t, { features: ["lighting", "hvac"] });
  await licenseQuotaService.assertFeatureLicensed("lighting");
});

test("assertFeatureLicensed allows open_all", async (t) => {
  stubLicense(t, { features: [], activationMethod: "open_all" });
  await licenseQuotaService.assertFeatureLicensed("lighting");
});

test("assertSystemQuotaWithinLimit rejects before quota when unlicensed", async (t) => {
  stubLicense(t, { features: [] });
  await assert.rejects(
    () =>
      licenseQuotaService.assertSystemQuotaWithinLimit({
        query: async () => {
          throw new Error("query should not run");
        },
        systemType: "lighting",
        nextConfig: { status_points: [] },
      }),
    (err) => err.code === C.FEATURE_NOT_LICENSED,
  );
});
