const crypto = require("crypto");
const config = require("../config");

const KEY = crypto.createHash("sha256").update(String(config.jwt.secret)).digest();

function encryptSecret(plainText) {
  const raw = String(plainText ?? "");
  if (!raw) return "";

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decryptSecret(cipherText) {
  const raw = String(cipherText ?? "");
  if (!raw) return "";

  const buf = Buffer.from(raw, "base64");
  if (buf.length < 12 + 16) {
    return "";
  }

  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

module.exports = {
  encryptSecret,
  decryptSecret,
};

