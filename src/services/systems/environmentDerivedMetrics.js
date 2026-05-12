/**
 * 環境 derived 指標（AQI / Heat Index）共用計算
 * - 共用於 environmentMonitor / environmentReadingsService / multimediaDashboardService
 * - 注意：AQI 使用 pm25/pm10 breakpoint 估算，回傳為整數；HeatIndex 回傳攝氏
 */

const PM25_BREAKPOINTS = [
  { cLow: 0, cHigh: 12, iLow: 0, iHigh: 50 },
  { cLow: 12.1, cHigh: 35.4, iLow: 51, iHigh: 100 },
  { cLow: 35.5, cHigh: 55.4, iLow: 101, iHigh: 150 },
  { cLow: 55.5, cHigh: 150.4, iLow: 151, iHigh: 200 },
  { cLow: 150.5, cHigh: 250.4, iLow: 201, iHigh: 300 },
  { cLow: 250.5, cHigh: 350.4, iLow: 301, iHigh: 400 },
  { cLow: 350.5, cHigh: 500.4, iLow: 401, iHigh: 500 },
];

const PM10_BREAKPOINTS = [
  { cLow: 0, cHigh: 54, iLow: 0, iHigh: 50 },
  { cLow: 55, cHigh: 154, iLow: 51, iHigh: 100 },
  { cLow: 155, cHigh: 254, iLow: 101, iHigh: 150 },
  { cLow: 255, cHigh: 354, iLow: 151, iHigh: 200 },
  { cLow: 355, cHigh: 424, iLow: 201, iHigh: 300 },
  { cLow: 425, cHigh: 504, iLow: 301, iHigh: 400 },
  { cLow: 505, cHigh: 604, iLow: 401, iHigh: 500 },
];

function calculatePollutantAqi(value, breakpoints) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  const bp =
    breakpoints.find((b) => v >= b.cLow && v <= b.cHigh) ||
    breakpoints[breakpoints.length - 1];
  const clamped = Math.min(Math.max(v, bp.cLow), bp.cHigh);
  const idx =
    ((bp.iHigh - bp.iLow) / (bp.cHigh - bp.cLow)) * (clamped - bp.cLow) +
    bp.iLow;
  return Number.isFinite(idx) ? Math.round(idx) : null;
}

function calculateAqiScore(pm25, pm10) {
  const list = [
    calculatePollutantAqi(pm25, PM25_BREAKPOINTS),
    calculatePollutantAqi(pm10, PM10_BREAKPOINTS),
  ].filter((n) => typeof n === "number" && Number.isFinite(n));
  if (!list.length) return null;
  return Math.max(...list);
}

const cToF = (c) => c * (9 / 5) + 32;
const fToC = (f) => (f - 32) * (5 / 9);

function calculateHeatIndexC(temperatureC, humidityPercent) {
  if (
    temperatureC == null ||
    humidityPercent == null ||
    !Number.isFinite(Number(temperatureC)) ||
    !Number.isFinite(Number(humidityPercent))
  ) {
    return null;
  }

  const tC = Number(temperatureC);
  const rh = Number(humidityPercent);
  const tF = cToF(tC);

  if (tF < 80 || rh < 40) return tC;

  const T = tF;
  const R = rh;

  const hiF =
    -42.379 +
    2.04901523 * T +
    10.14333127 * R -
    0.22475541 * T * R -
    0.00683783 * T * T -
    0.05481717 * R * R +
    0.00122874 * T * T * R +
    0.00085282 * T * R * R -
    0.00000199 * T * T * R * R;

  const hiC = fToC(hiF);
  return Number.isFinite(hiC) ? hiC : null;
}

/**
 * 依輸入 data 產生 derived（不改動原物件）
 * @param {Record<string, any>} data
 * @returns {{ aqi: number|null, heatIndex: number|null }}
 */
function computeDerivedMetrics(data) {
  const d = data && typeof data === "object" ? data : {};
  return {
    aqi: calculateAqiScore(d.pm25, d.pm10),
    heatIndex: calculateHeatIndexC(d.temperature, d.humidity),
  };
}

module.exports = {
  computeDerivedMetrics,
  calculateAqiScore,
  calculateHeatIndexC,
};

