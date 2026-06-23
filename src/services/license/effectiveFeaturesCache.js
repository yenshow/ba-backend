/** reconcile 後的有效授權 feature 快取（供 YSCP 等同步讀取，避免循環依賴） */
let cachedEffectiveFeatures = [];

const setCachedEffectiveFeatures = (features) => {
  cachedEffectiveFeatures = Array.isArray(features)
    ? features.filter((key) => typeof key === "string")
    : [];
};

const getCachedEffectiveFeatures = () => [...cachedEffectiveFeatures];

const hasCachedLicensedFeature = (featureKey) =>
  cachedEffectiveFeatures.includes(featureKey);

module.exports = {
  setCachedEffectiveFeatures,
  getCachedEffectiveFeatures,
  hasCachedLicensedFeature,
};
