/**
 * 能源參考電費：TOU 分季／週末、超額加價、PF 獎懲
 *
 *   npm run test:energy-reference-bill
 */
const assert = require("node:assert/strict");
const {
  buildTaipowerTariff,
  classifyTouBand,
  isUnsetTariff,
  normalizeElectricityTariff,
} = require("../../src/constants/taipowerTouDefaults");
const {
  normalizePfToPercent,
  calcPowerFactorBillAdjustment,
} = require("../../src/services/energy/powerFactorBillAdjustment");
const {
  calcReferenceElectricityCost,
} = require("../../src/services/energy/energyReferenceBill");

/** Asia/Taipei 本地時 → 對應 UTC Date */
const taipeiUtc = (y, m, d, hh, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh - 8, mm, 0, 0));

const run = () => {
  const three = buildTaipowerTariff("three_stage");
  const two = buildTaipowerTariff("two_stage");

  // 2026-07-06 週一夏月；2026-10-05 週一非夏月；2026-07-04 週六
  assert.equal(classifyTouBand(taipeiUtc(2026, 7, 6, 16), three), "peak");
  assert.equal(classifyTouBand(taipeiUtc(2026, 7, 6, 10), three), "semi_peak");
  assert.equal(classifyTouBand(taipeiUtc(2026, 7, 6, 8), three), "off_peak");
  assert.equal(classifyTouBand(taipeiUtc(2026, 7, 6, 22), three), "semi_peak");
  assert.equal(classifyTouBand(taipeiUtc(2026, 7, 4, 18), three), "off_peak");
  assert.equal(classifyTouBand(taipeiUtc(2026, 10, 5, 16), three), "semi_peak");
  assert.equal(classifyTouBand(taipeiUtc(2026, 10, 5, 12), three), "off_peak");
  assert.equal(classifyTouBand(taipeiUtc(2026, 7, 6, 10), two), "peak");
  assert.equal(classifyTouBand(taipeiUtc(2026, 10, 5, 7), two), "peak");
  assert.equal(classifyTouBand(taipeiUtc(2026, 10, 5, 12), two), "off_peak");

  assert.equal(isUnsetTariff({}), true);
  assert.equal(
    isUnsetTariff({
      peak: { rate: 0, windows: [] },
      semi_peak: { rate: 0, windows: [] },
      off_peak: { rate: 0, windows: [] },
    }),
    true,
  );
  const fromEmpty = normalizeElectricityTariff({});
  assert.equal(fromEmpty.scheme, "three_stage");
  assert.equal(fromEmpty.peak.summer_rate, 7.13);
  assert.equal(fromEmpty.off_peak.non_summer_rate, 1.99);

  const legacy = normalizeElectricityTariff({
    peak: { rate: 5, windows: [{ dow: [1, 2, 3, 4, 5], start: "09:00", end: "24:00" }] },
    semi_peak: { rate: 0, windows: [] },
    off_peak: { rate: 2, windows: [] },
  });
  assert.equal(legacy.peak.summer_rate, 5);
  assert.equal(legacy.peak.non_summer_rate, 5);
  assert.equal(legacy.off_peak.summer_rate, 2);

  assert.equal(normalizePfToPercent(0.9), 90);
  assert.equal(normalizePfToPercent(90), 90);
  assert.equal(normalizePfToPercent(null), null);

  const pf90 = calcPowerFactorBillAdjustment(100, 90, { enabled: true });
  assert.equal(pf90.billDeltaPct, -1);
  assert.equal(pf90.finalAmount, 99);

  const pf75 = calcPowerFactorBillAdjustment(100, 75, { enabled: true });
  assert.equal(pf75.billDeltaPct, 0.5);
  assert.equal(pf75.finalAmount, 100.5);

  const pf98 = calcPowerFactorBillAdjustment(100, 98, { enabled: true });
  assert.equal(pf98.effectivePct, 95);
  assert.equal(pf98.billDeltaPct, -1.5);
  assert.equal(pf98.finalAmount, 98.5);

  const pfOff = calcPowerFactorBillAdjustment(100, 90, { enabled: false });
  assert.equal(pfOff.applied, false);
  assert.equal(pfOff.finalAmount, 100);

  const octOff = taipeiUtc(2026, 10, 5, 3);
  const touOnly = calcReferenceElectricityCost(
    [
      {
        bucket_at: octOff,
        tou_peak_kwh: 0,
        tou_semi_peak_kwh: 0,
        tou_off_peak_kwh: 10,
      },
    ],
    three,
    { enabled: false },
    null,
    0,
  );
  assert.equal(touOnly.baseAmount, 19.9);
  assert.equal(touOnly.amount, 19.9);
  assert.equal(touOnly.touLineItems[0].rate, 1.99);

  const excess = calcReferenceElectricityCost(
    [
      {
        bucket_at: octOff,
        tou_peak_kwh: 0,
        tou_semi_peak_kwh: 0,
        tou_off_peak_kwh: 2500,
      },
    ],
    three,
    { enabled: false },
    null,
    0,
  );
  assert.equal(excess.baseAmount, 4975);
  assert.equal(excess.excessKwh, 500);
  assert.equal(excess.excessAmount, 520);
  assert.equal(excess.amount, 5495);

  const withPf = calcReferenceElectricityCost(
    [
      {
        bucket_at: octOff,
        tou_peak_kwh: 0,
        tou_semi_peak_kwh: 0,
        tou_off_peak_kwh: 10,
      },
    ],
    three,
    { enabled: true },
    90,
    1,
  );
  assert.equal(withPf.baseAmount, 19.9);
  assert.equal(withPf.powerFactor.billDeltaPercent, -1);
  assert.equal(withPf.amount, 19.7);
};

run();
console.log("energyReferenceBill tests passed");
