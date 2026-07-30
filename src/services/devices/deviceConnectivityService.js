const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");
const modbusBatchService = require("./modbusBatchService");
const { createIsapiClient } = require("../accessControl/isapiClient");
const net = require("net");
const { URL } = require("url");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrors");
const {
  parseConfig,
  isHcnetSdkController,
  resolveHcnetSdkPort,
} = require("../../utils/deviceHelpers");

/**
 * In-memory connectivity snapshot.
 * No DB persistence by design.
 */
const statusByDeviceId = new Map(); // deviceId -> { status, updatedAt, failCount }

const VALID_STATUSES = new Set(["online", "offline"]);

const FAIL_THRESHOLD = 1;
// Unified timeout for connectivity probes (RTSP / ISAPI).
const { CONNECTIVITY_TIMEOUT_MS } = require("../../config/realtimeTiming");
const CONCURRENCY = 8;

function nowIso() {
  return new Date().toISOString();
}

function normalizeStatus(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  return VALID_STATUSES.has(s) ? s : "offline";
}

function getSnapshotItem(deviceId) {
  const row = statusByDeviceId.get(deviceId);
  if (!row) {
    return { device_id: deviceId, status: "offline", updated_at: null };
  }
  return {
    device_id: deviceId,
    status: normalizeStatus(row.status),
    updated_at: row.updatedAt || null,
  };
}

function setStatus(deviceId, status) {
  const nextStatus = normalizeStatus(status);
  const prev = statusByDeviceId.get(deviceId);
  const next = {
    status: nextStatus,
    updatedAt: nowIso(),
    failCount: nextStatus === "online" ? 0 : (prev?.failCount ?? 0),
  };
  statusByDeviceId.set(deviceId, next);
  return { prevStatus: prev?.status ?? "offline", nextStatus };
}

function bumpFail(deviceId) {
  const prev = statusByDeviceId.get(deviceId);
  const prevFail = prev?.failCount ?? 0;
  const nextFail = prevFail + 1;
  const nextStatus =
    nextFail >= FAIL_THRESHOLD ? "offline" : (prev?.status ?? "offline");
  const next = {
    status: normalizeStatus(nextStatus),
    updatedAt: nowIso(),
    failCount: nextFail,
  };
  statusByDeviceId.set(deviceId, next);
  return {
    prevStatus: prev?.status ?? "offline",
    nextStatus: next.status,
    failCount: nextFail,
  };
}

async function rtspOptionsProbe(rtspUrl) {
  const url = new URL(rtspUrl);
  const host = url.hostname;
  const port = url.port ? Number(url.port) : 554;
  if (!host || !Number.isFinite(port)) {
    throw createApiError(C.DEVICE_CONNECTIVITY_RTSP_URL_INVALID, "RTSP URL 無效（host/port）");
  }

  return await new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (err, ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (_) {}
      if (err) reject(err);
      else resolve(ok);
    };

    const timer = setTimeout(() => {
      done(
        createApiError(C.DEVICE_CONNECTIVITY_RTSP_TIMEOUT, "RTSP 連線超時"),
        false,
      );
    }, CONNECTIVITY_TIMEOUT_MS);

    socket.once("error", (e) => {
      clearTimeout(timer);
      done(
        createApiError(
          C.DEVICE_CONNECTIVITY_RTSP_FAILED,
          e?.message || "RTSP 連線失敗",
        ),
        false,
      );
    });

    socket.connect(port, host, () => {
      // OPTIONS 可能回 200/401/403 都代表 server reachable（「可連」）
      // 多數設備支援 `OPTIONS *`；比帶完整 URL 更通用
      const req =
        `OPTIONS * RTSP/1.0\r\n` +
        `CSeq: 1\r\n` +
        `User-Agent: BA-System\r\n` +
        `\r\n`;
      socket.write(req);
    });

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes("\r\n\r\n")) {
        clearTimeout(timer);
        if (/^RTSP\/1\.\d\s+\d{3}/m.test(buf)) {
          done(null, true);
        } else {
          done(
            createApiError(
              C.DEVICE_CONNECTIVITY_RTSP_RESPONSE_INVALID,
              "RTSP 回應格式不正確",
            ),
            false,
          );
        }
      }
    });
  });
}

async function tcpPortHealthCheck(host, port) {
  const normalizedHost = String(host || "").trim();
  const normalizedPort = Number(port);
  if (!normalizedHost || !Number.isFinite(normalizedPort)) {
    throw createApiError(
      C.DEVICE_CONNECTIVITY_TCP_CONFIG_INCOMPLETE,
      "TCP 配置不完整（host/port）",
    );
  }

  return await new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (err, ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (_) {}
      if (err) reject(err);
      else resolve(ok);
    };

    const timer = setTimeout(() => {
      done(
        createApiError(C.DEVICE_CONNECTIVITY_TCP_TIMEOUT, "TCP 連線超時"),
        false,
      );
    }, CONNECTIVITY_TIMEOUT_MS);

    socket.once("error", (e) => {
      clearTimeout(timer);
      done(
        createApiError(
          C.DEVICE_CONNECTIVITY_TCP_FAILED,
          e?.message || "TCP 連線失敗",
        ),
        false,
      );
    });

    socket.connect(normalizedPort, normalizedHost, () => {
      clearTimeout(timer);
      done(null, true);
    });
  });
}

async function modbusHealthCheck(deviceConfig) {
  const host = String(deviceConfig?.host || "").trim();
  const port = Number(deviceConfig?.port);
  const unitId = Number(deviceConfig?.unitId ?? deviceConfig?.unit_id ?? 1);
  if (!host || !Number.isFinite(port) || !Number.isFinite(unitId)) {
    throw createApiError(
      C.DEVICE_CONNECTIVITY_MODBUS_CONFIG_INCOMPLETE,
      "Modbus 配置不完整（host/port/unitId）",
    );
  }
  const results = await modbusBatchService.batchRead([
    {
      host,
      port,
      unitId,
      registerType: "holding",
      address: 0,
      length: 1,
      meta: { health: true, noCache: true },
    },
  ]);
  const first = results?.[0];
  if (!first || first.ok !== true) {
    throw createApiError(
      C.DEVICE_CONNECTIVITY_MODBUS_FAILED,
      first?.error || "Modbus 健康檢查失敗",
    );
  }
  return true;
}

async function isapiHealthCheck(deviceConfig) {
  const host = String(deviceConfig?.host || "").trim();
  if (!host) {
    throw createApiError(
      C.DEVICE_CONNECTIVITY_ISAPI_CONFIG_INCOMPLETE,
      "ISAPI 配置不完整（host）",
    );
  }
  const client = createIsapiClient({
    host,
    port: deviceConfig?.port ?? 80,
    username: deviceConfig?.username || "admin",
    password: deviceConfig?.password || "",
  });
  // 只要能拿到 deviceInfo（含 digest 流程）就算可連
  await client.request({
    method: "GET",
    path: "/ISAPI/System/deviceInfo",
    headers: {},
    // isapiClient 內部有 timeout，但這裡再用 Promise.race 保護更直覺
  });
  return true;
}

async function checkSingleDeviceConnectivity(deviceRow) {
  const deviceId = Number(deviceRow?.id);
  const typeCode = String(deviceRow?.type_code || "")
    .trim()
    .toLowerCase();
  if (!Number.isFinite(deviceId)) {
    return { deviceId: null, ok: false, error: "deviceId 無效" };
  }

  const cfg = parseConfig(deviceRow?.config) || {};
  const modelCfg = parseConfig(deviceRow?.model_config) || {};
  const modelPort = deviceRow?.model_port;

  if (typeCode === "camera") {
    const rtspUrl = String(cfg?.rtsp_url || "").trim();
    if (!rtspUrl) {
      throw createApiError(
        C.DEVICE_CONNECTIVITY_CAMERA_RTSP_MISSING,
        "攝影機未設定 rtsp_url",
      );
    }
    await rtspOptionsProbe(rtspUrl);
    return { deviceId, ok: true, nextStatus: "online" };
  }

  if (typeCode === "controller") {
    if (isHcnetSdkController(cfg, modelCfg)) {
      const host = String(cfg?.host || "").trim();
      await tcpPortHealthCheck(host, resolveHcnetSdkPort(cfg, modelPort));
      return { deviceId, ok: true, nextStatus: "online" };
    }
    await modbusHealthCheck(cfg);
    return { deviceId, ok: true, nextStatus: "online" };
  }

  if (typeCode === "sensor") {
    const protocol = String(cfg?.protocol || "")
      .trim()
      .toLowerCase();
    if (protocol !== "modbus") {
      // 目前方案 A 只定義 modbus sensor 的健康檢查；其餘視為離線（UI 不顯示 unknown）
      return { deviceId, ok: true, skipped: true, nextStatus: "offline" };
    }
    await modbusHealthCheck(cfg);
    return { deviceId, ok: true, nextStatus: "online" };
  }

  if (typeCode === "access_control") {
    // ISAPI 連線成功
    const p = Promise.race([
      isapiHealthCheck(cfg),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              createApiError(C.DEVICE_CONNECTIVITY_ISAPI_TIMEOUT, "ISAPI 連線超時"),
            ),
          CONNECTIVITY_TIMEOUT_MS,
        ),
      ),
    ]);
    await p;
    return { deviceId, ok: true, nextStatus: "online" };
  }

  return { deviceId, ok: true, skipped: true, nextStatus: "offline" };
}

async function mapWithConcurrency(items, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let idx = 0;
  const runners = new Array(Math.min(CONCURRENCY, list.length))
    .fill(null)
    .map(async () => {
      while (idx < list.length) {
        const my = idx++;
        try {
          results[my] = await worker(list[my], my);
        } catch (e) {
          results[my] = {
            ok: false,
            error: e?.message || String(e),
            code: e?.code || null,
          };
        }
      }
    });
  await Promise.all(runners);
  return results;
}

async function checkAndBroadcastConnectivity({ type_code } = {}) {
  const typeCode = type_code ? String(type_code).trim().toLowerCase() : null;
  const params = [];
  let where = "WHERE 1=1";
  if (typeCode) {
    where += " AND LOWER(d.type_code) = ?";
    params.push(typeCode);
  }

  const rows = await db.query(
    `
      SELECT d.id, d.type_code, d.config, dm.config AS model_config, dm.port AS model_port
      FROM devices d
      LEFT JOIN device_models dm ON dm.id = d.model_id
      ${where}
      ORDER BY d.id ASC
    `,
    params,
  );

  const checks = await mapWithConcurrency(rows, async (row) => {
    try {
      const r = await checkSingleDeviceConnectivity(row);
      return { ok: true, ...r };
    } catch (e) {
      return {
        ok: false,
        deviceId: Number(row?.id),
        error: e?.message || String(e),
        code: e?.code || null,
      };
    }
  });

  const updates = [];
  for (const r of checks) {
    const deviceId = Number(r?.deviceId);
    if (!Number.isFinite(deviceId)) continue;

    const prev = statusByDeviceId.get(deviceId);
    const prevStatus = normalizeStatus(prev?.status);

    if (r.ok && r.nextStatus === "online") {
      const { nextStatus } = setStatus(deviceId, "online");
      if (prevStatus !== nextStatus) {
        updates.push({
          system: "device",
          sourceId: deviceId,
          deviceId,
          status: nextStatus,
        });
      }
      continue;
    }

    if (r.ok && r.nextStatus === "unknown") {
      const { nextStatus } = setStatus(deviceId, "unknown");
      if (prevStatus !== nextStatus) {
        updates.push({
          system: "device",
          sourceId: deviceId,
          deviceId,
          status: nextStatus,
        });
      }
      continue;
    }

    // failed check
    const bumped = bumpFail(deviceId);
    if (prevStatus !== bumped.nextStatus) {
      updates.push({
        system: "device",
        sourceId: deviceId,
        deviceId,
        status: bumped.nextStatus,
      });
    }
  }

  if (updates.length > 0) {
    websocketService.emitBatchDeviceStatus(updates);
  }

  return {
    checked: rows.length,
    updates: updates.length,
  };
}

async function checkAndBroadcastConnectivityByDeviceIds(deviceIds = []) {
  const ids = Array.isArray(deviceIds)
    ? deviceIds.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : [];
  if (ids.length === 0) return { checked: 0, updates: 0 };

  const rows = await db.query(
    `
      SELECT d.id, d.type_code, d.config, dm.config AS model_config, dm.port AS model_port
      FROM devices d
      LEFT JOIN device_models dm ON dm.id = d.model_id
      WHERE d.id = ANY($1::int[])
      ORDER BY d.id ASC
    `,
    [ids],
  );

  const checks = await mapWithConcurrency(rows, async (row) => {
    try {
      const r = await checkSingleDeviceConnectivity(row);
      return { ok: true, ...r };
    } catch (e) {
      return {
        ok: false,
        deviceId: Number(row?.id),
        error: e?.message || String(e),
        code: e?.code || null,
      };
    }
  });

  const updates = [];
  for (const r of checks) {
    const deviceId = Number(r?.deviceId);
    if (!Number.isFinite(deviceId)) continue;

    const prev = statusByDeviceId.get(deviceId);
    const prevStatus = normalizeStatus(prev?.status);

    if (r.ok && r.nextStatus === "online") {
      const { nextStatus } = setStatus(deviceId, "online");
      if (prevStatus !== nextStatus) {
        updates.push({
          system: "device",
          sourceId: deviceId,
          deviceId,
          status: nextStatus,
        });
      }
      continue;
    }

    if (r.ok && r.nextStatus === "unknown") {
      const { nextStatus } = setStatus(deviceId, "unknown");
      if (prevStatus !== nextStatus) {
        updates.push({
          system: "device",
          sourceId: deviceId,
          deviceId,
          status: nextStatus,
        });
      }
      continue;
    }

    const bumped = bumpFail(deviceId);
    if (prevStatus !== bumped.nextStatus) {
      updates.push({
        system: "device",
        sourceId: deviceId,
        deviceId,
        status: bumped.nextStatus,
      });
    }
  }

  if (updates.length > 0) {
    websocketService.emitBatchDeviceStatus(updates);
  }

  return {
    checked: rows.length,
    updates: updates.length,
    results: checks.map((c) => ({
      device_id: Number(c?.deviceId),
      ok: Boolean(c?.ok),
      skipped: Boolean(c?.skipped),
      next_status: c?.nextStatus || null,
      error: c?.ok ? null : c?.error || null,
      code: c?.ok ? null : c?.code || null,
    })),
  };
}

async function getConnectivitySnapshot(params = {}) {
  const typeCode = params?.type_code
    ? String(params.type_code).trim().toLowerCase()
    : null;
  const deviceIdsRaw = Array.isArray(params?.device_ids)
    ? params.device_ids
    : typeof params?.device_ids === "string"
      ? params.device_ids.split(",")
      : [];
  const deviceIds = deviceIdsRaw
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isFinite(n));

  // 如果指定 type_code：直接查 DB 取 id 清單再回 snapshot（避免前端漏傳）
  if (typeCode) {
    const rows = await db.query(
      `SELECT id FROM devices WHERE LOWER(type_code) = ? ORDER BY id ASC`,
      [typeCode],
    );
    const ids = (rows || [])
      .map((r) => Number(r?.id))
      .filter((n) => Number.isFinite(n));
    return { items: ids.map(getSnapshotItem) };
  }

  if (deviceIds.length > 0) {
    return { items: deviceIds.map(getSnapshotItem) };
  }

  // default: all known in memory (fast)
  const ids = Array.from(statusByDeviceId.keys()).sort((a, b) => a - b);
  return { items: ids.map(getSnapshotItem) };
}

module.exports = {
  checkAndBroadcastConnectivity,
  checkAndBroadcastConnectivityByDeviceIds,
  getConnectivitySnapshot,
  _internal: {
    statusByDeviceId,
    rtspOptionsProbe,
  },
};
