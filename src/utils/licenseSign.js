const crypto = require("crypto");
const C = require("./apiErrorCodes");
const { throwApiError } = require("./apiErrorMeta");

const toSortedPayload = (payload) => {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return {};
	}
	const keys = Object.keys(payload).sort((a, b) => a.localeCompare(b));
	const sorted = {};
	for (const key of keys) sorted[key] = payload[key];
	return sorted;
};

const toHmacSha256Hex = (secret, message) =>
	crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");

const normalizeSignature = (signature) => {
	if (signature == null) return "";
	const raw = String(signature).trim();
	if (!raw) return "";
	return raw.toLowerCase();
};

/**
 * 依授權文件規格計算 signature：
 * - payload（不含 signature）依 key 字母排序
 * - JSON.stringify 後做 HMAC-SHA256
 * - 回傳 hex 字串（小寫）
 */
const signLicensePayload = (payload, secret) => {
	if (!secret || typeof secret !== "string") {
		throwApiError(C.LICENSE_SIGN_SECRET_MISSING, "LICENSE_SIGN_SECRET 未設定", {
			statusCode: 500,
		});
	}
	const sorted = toSortedPayload(payload);
	const message = JSON.stringify(sorted);
	return toHmacSha256Hex(secret, message);
};

/**
 * 驗簽回應檔（timing-safe compare）
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
const verifyLicensePayload = (fullPayload, secret) => {
	if (!fullPayload || typeof fullPayload !== "object" || Array.isArray(fullPayload)) {
		return { ok: false, reason: "payload 必須為 object" };
	}
	const receivedSig = normalizeSignature(fullPayload.signature);
	if (!receivedSig) return { ok: false, reason: "缺少 signature" };

	const { signature: _sig, ...rest } = fullPayload;
	const expectedSig = normalizeSignature(signLicensePayload(rest, secret));

	try {
		const a = Buffer.from(receivedSig, "utf8");
		const b = Buffer.from(expectedSig, "utf8");
		if (a.length !== b.length) return { ok: false, reason: "signature 不匹配" };
		const ok = crypto.timingSafeEqual(a, b);
		return ok ? { ok: true } : { ok: false, reason: "signature 不匹配" };
	} catch (error) {
		return { ok: false, reason: error.message };
	}
};

module.exports = {
	signLicensePayload,
	verifyLicensePayload,
};

