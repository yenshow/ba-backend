/**
 * 多媒體資訊牆席次：1 台電腦（機器指紋）= 1 席。
 * 啟用後核發 seatToken（僅回傳一次明文；DB 存 hash），唯讀 API 必須帶指紋＋憑證。
 * 僅獨立牆程式佔席；Central 設定頁（JWT）不佔席。
 */
const crypto = require("crypto");
const db = require("../../database/db");
const licenseService = require("../license/licenseService");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrors");
const { timingSafeEqualUtf8 } = require("../../utils/timingSafeEqual");

/** 預設 60 分鐘；可用 MULTIMEDIA_WALL_SEAT_ACTIVE_MS 覆寫（≥60s） */
const parseActiveWindowMs = () => {
  const raw = Number(process.env.MULTIMEDIA_WALL_SEAT_ACTIVE_MS);
  if (Number.isFinite(raw) && raw >= 60_000) return Math.floor(raw);
  return 60 * 60 * 1000;
};

const SEAT_ACTIVE_WINDOW_MS = parseActiveWindowMs();

const WALL_FINGERPRINT_HEADER = "x-multimedia-wall-fingerprint";
const WALL_SEAT_TOKEN_HEADER = "x-multimedia-wall-seat-token";
const WALL_HOSTNAME_HEADER = "x-multimedia-wall-hostname";

const normalizeHex64 = (raw) => {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{64}$/.test(s) ? s : "";
};

const normalizeHostname = (raw) => {
  const s = String(raw || "")
    .trim()
    .slice(0, 255);
  return s || null;
};

const issueSeatToken = () => crypto.randomBytes(32).toString("hex");

const hashSeatToken = (token) =>
  crypto.createHash("sha256").update(String(token), "utf8").digest("hex");

const tokenMatchesHash = (token, hash) =>
  Boolean(token) &&
  Boolean(hash) &&
  timingSafeEqualUtf8(hashSeatToken(token), hash);

const countActiveSeats = async ({ excludeFingerprint = null } = {}) => {
  const params = [SEAT_ACTIVE_WINDOW_MS];
  let sql = `
    SELECT COUNT(*)::int AS cnt
    FROM multimedia_wall_seats
    WHERE seat_token_hash IS NOT NULL
      AND last_seen_at >= NOW() - ($1::bigint * INTERVAL '1 millisecond')
  `;
  if (excludeFingerprint) {
    params.push(excludeFingerprint);
    sql += ` AND fingerprint <> $${params.length}`;
  }
  const rows = await db.query(sql, params);
  return Number(rows?.[0]?.cnt) || 0;
};

const getSeatByFingerprint = async (fingerprint) => {
  const fp = normalizeHex64(fingerprint);
  if (!fp) return null;
  const rows = await db.query(
    `SELECT fingerprint, hostname, registered_at, last_seen_at, seat_token_hash
     FROM multimedia_wall_seats
     WHERE fingerprint = $1
     LIMIT 1`,
    [fp],
  );
  return rows?.[0] || null;
};

const isSeatActive = (row) => {
  if (!row?.last_seen_at || !row?.seat_token_hash) return false;
  const last = new Date(row.last_seen_at).getTime();
  if (!Number.isFinite(last)) return false;
  return Date.now() - last <= SEAT_ACTIVE_WINDOW_MS;
};

const purgeInactiveSeats = async () => {
  await db.query(
    `DELETE FROM multimedia_wall_seats
     WHERE last_seen_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
        OR seat_token_hash IS NULL`,
    [SEAT_ACTIVE_WINDOW_MS],
  );
};

const resolveMaxDevices = (license) => {
  const maxRaw = license?.quotas?.multimedia?.maxDevices;
  if (maxRaw == null || maxRaw === "") return 0;
  const max = Math.floor(Number(maxRaw));
  if (!Number.isFinite(max) || max < 0) return 0;
  return max;
};

const touchSeat = async (fingerprint, hostname) => {
  await db.query(
    `UPDATE multimedia_wall_seats
     SET hostname = COALESCE($2, hostname), last_seen_at = NOW()
     WHERE fingerprint = $1`,
    [fingerprint, normalizeHostname(hostname)],
  );
};

/**
 * 啟用／續用席次並核發（或回傳既有）seatToken。
 * 已有有效席次且未帶正確 token → 拒絕（須 Central 撤銷）。
 */
const activateSeat = async ({ fingerprint, hostname, seatToken } = {}) => {
  const fp = normalizeHex64(fingerprint);
  if (!fp) {
    throw createApiError(C.BAD_REQUEST, "缺少有效的牆面指紋", {
      statusCode: 400,
      details: { header: WALL_FINGERPRINT_HEADER },
    });
  }

  const presentedToken = normalizeHex64(seatToken);
  const host = normalizeHostname(hostname);
  const license = await licenseService.getLicenseState();
  const openAll = license?.activationMethod === "open_all";

  await purgeInactiveSeats();

  const existing = await getSeatByFingerprint(fp);
  if (existing && isSeatActive(existing)) {
    if (tokenMatchesHash(presentedToken, existing.seat_token_hash)) {
      await touchSeat(fp, host);
      return { fingerprint: fp, seatToken: presentedToken, existing: true };
    }
    throw createApiError(
      C.FORBIDDEN,
      "此牆面指紋已啟用；請於 Central「授權電腦」撤銷後再啟用，或使用原機憑證",
      {
        statusCode: 403,
        details: { feature: "multimedia", fingerprint: fp },
      },
    );
  }

  if (!openAll) {
    const max = resolveMaxDevices(license);
    const used = await countActiveSeats({
      excludeFingerprint: existing ? fp : null,
    });
    if (used + 1 > max) {
      throw createApiError(C.LICENSE_QUOTA_EXCEEDED, "已達到授權配額上限", {
        statusCode: 403,
        details: { feature: "multimedia", used, max },
      });
    }
  }

  const nextToken = issueSeatToken();
  await db.query(
    `INSERT INTO multimedia_wall_seats (
       fingerprint, hostname, registered_at, last_seen_at, seat_token_hash
     ) VALUES ($1, $2, NOW(), NOW(), $3)
     ON CONFLICT (fingerprint) DO UPDATE
       SET hostname = COALESCE(EXCLUDED.hostname, multimedia_wall_seats.hostname),
           last_seen_at = NOW(),
           registered_at = NOW(),
           seat_token_hash = EXCLUDED.seat_token_hash`,
    [fp, host, hashSeatToken(nextToken)],
  );

  return {
    fingerprint: fp,
    seatToken: nextToken,
    existing: Boolean(existing),
  };
};

/**
 * 唯讀 API：驗證指紋＋seatToken，並更新 heartbeat。
 * 不自動開新席；未啟用須先走 activate。
 */
const verifySeatAndTouch = async ({ fingerprint, seatToken, hostname } = {}) => {
  const fp = normalizeHex64(fingerprint);
  if (!fp) {
    throw createApiError(C.BAD_REQUEST, "缺少有效的牆面指紋", {
      statusCode: 400,
      details: { header: WALL_FINGERPRINT_HEADER },
    });
  }
  const token = normalizeHex64(seatToken);
  if (!token) {
    throw createApiError(C.BAD_REQUEST, "缺少牆面席次憑證", {
      statusCode: 400,
      details: { header: WALL_SEAT_TOKEN_HEADER },
    });
  }

  const row = await getSeatByFingerprint(fp);
  if (!row?.seat_token_hash || !isSeatActive(row)) {
    throw createApiError(C.FORBIDDEN, "牆面席次未啟用或已逾時，請重新啟用", {
      statusCode: 403,
      details: { feature: "multimedia", fingerprint: fp },
    });
  }
  if (!tokenMatchesHash(token, row.seat_token_hash)) {
    throw createApiError(C.FORBIDDEN, "牆面席次憑證無效", {
      statusCode: 403,
      details: { feature: "multimedia", fingerprint: fp },
    });
  }

  await touchSeat(fp, hostname);
  return { fingerprint: fp };
};

const listSeats = async () => {
  const rows = await db.query(
    `SELECT fingerprint, hostname, registered_at, last_seen_at,
            (seat_token_hash IS NOT NULL
              AND last_seen_at >= NOW() - ($1::bigint * INTERVAL '1 millisecond')) AS active
     FROM multimedia_wall_seats
     ORDER BY last_seen_at DESC`,
    [SEAT_ACTIVE_WINDOW_MS],
  );
  return (rows || []).map((r) => ({
    fingerprint: r.fingerprint,
    hostname: r.hostname || null,
    registeredAt: r.registered_at,
    lastSeenAt: r.last_seen_at,
    active: Boolean(r.active),
  }));
};

const revokeSeat = async (fingerprint) => {
  const fp = normalizeHex64(fingerprint);
  if (!fp) {
    throw createApiError(C.BAD_REQUEST, "無效的牆面指紋", { statusCode: 400 });
  }
  const result = await db.query(
    `DELETE FROM multimedia_wall_seats WHERE fingerprint = $1 RETURNING fingerprint`,
    [fp],
  );
  return { deleted: (result || []).length > 0, fingerprint: fp };
};

const resolveFingerprintFromRequest = (req) =>
  normalizeHex64(req.headers?.[WALL_FINGERPRINT_HEADER]);

const resolveSeatTokenFromRequest = (req) =>
  normalizeHex64(req.headers?.[WALL_SEAT_TOKEN_HEADER]);

const resolveHostnameFromRequest = (req) =>
  normalizeHostname(req.headers?.[WALL_HOSTNAME_HEADER]);

module.exports = {
  SEAT_ACTIVE_WINDOW_MS,
  countActiveSeats,
  activateSeat,
  verifySeatAndTouch,
  listSeats,
  revokeSeat,
  resolveFingerprintFromRequest,
  resolveSeatTokenFromRequest,
  resolveHostnameFromRequest,
};
