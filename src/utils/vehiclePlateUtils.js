/**
 * 車牌正規化（與前端 vehicleAccessUtils.normalizePlate 對齊）
 */
function normalizePlate(plate) {
  if (plate == null) return "";
  return String(plate).trim().toUpperCase();
}

module.exports = {
  normalizePlate,
};
