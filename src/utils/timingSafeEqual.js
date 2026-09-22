/**
 * PDA 裝置金鑰比對（timing-safe）
 */
const crypto = require("crypto");

const timingSafeEqualUtf8 = (a, b) => {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length === 0 || left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
};

module.exports = {
  timingSafeEqualUtf8,
};
