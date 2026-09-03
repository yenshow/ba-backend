/**
 * 特殊情形：歷史門禁附圖 FIFO 錯綁修復（非正式執行期；新事件靠單槽即可）
 *
 *   cd ba-backend
 *   node scripts/repairAccessEventPictures.js --fix-from-files
 *   node scripts/repairAccessEventPictures.js --fix-from-files --apply
 *   node scripts/repairAccessEventPictures.js --inspect --limit 500
 *
 * 流程：磁碟 …_{id}.jpg 掛回（含指紋列）→ pending 重排給人臉。報表在 uploads/repair-reports/。
 */
const fs = require("fs");
const path = require("path");
const {
  extractSubEventType,
  shouldQueueAccessEventPicture,
  shouldDisplayAccessEventPicture,
  extractAccessEventIdentity,
} = require("../src/services/peopleCounting/accessControlLogLabels");

const normPath = (p) => {
  const s = p != null ? String(p).trim() : "";
  return s || null;
};

const coercePayload = (raw) => {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
};

const toIso = (v) =>
  v instanceof Date ? v.toISOString() : v != null ? String(v) : "";

const eventTimeMs = (v) => {
  if (v instanceof Date) return v.getTime();
  const n = Date.parse(String(v || ""));
  return Number.isFinite(n) ? n : 0;
};

/** 非人臉有圖 → pending；人臉遇 pending 則改掛（人臉有圖且無 pending 則保留） */
const planReassignByOrder = (rows) => {
  const byDevice = new Map();
  for (const row of rows || []) {
    const ip = String(row.device_ip || "unknown");
    if (!byDevice.has(ip)) byDevice.set(ip, []);
    byDevice.get(ip).push(row);
  }

  const changes = [];
  for (const [deviceIp, list] of byDevice) {
    const sorted = [...list].sort((a, b) => {
      const dt = eventTimeMs(a.event_time) - eventTimeMs(b.event_time);
      return dt !== 0 ? dt : Number(a.id) - Number(b.id);
    });
    const newPathById = new Map();
    const pending = [];

    for (const r of sorted) {
      const payload = coercePayload(r.payload);
      const oldPath = normPath(r.picture_path);
      if (!shouldQueueAccessEventPicture(payload)) {
        if (oldPath) pending.push(oldPath);
        newPathById.set(r.id, null);
        continue;
      }
      if (pending.length === 0) {
        newPathById.set(r.id, oldPath);
        continue;
      }
      if (oldPath) pending.push(oldPath);
      newPathById.set(r.id, pending.shift());
    }

    for (const r of sorted) {
      if (pending.length === 0) break;
      if (!shouldQueueAccessEventPicture(coercePayload(r.payload))) continue;
      if (newPathById.get(r.id)) continue;
      newPathById.set(r.id, pending.shift());
    }

    for (const r of sorted) {
      const oldPath = normPath(r.picture_path);
      const newPath = newPathById.has(r.id) ? newPathById.get(r.id) : oldPath;
      if (oldPath === newPath) continue;
      const payload = coercePayload(r.payload);
      const identity = extractAccessEventIdentity(payload);
      changes.push({
        id: r.id,
        device_ip: deviceIp,
        sub: extractSubEventType(payload),
        employee: identity.employeeNo || "",
        name: identity.personName || "",
        event_time: toIso(r.event_time),
        old_path: oldPath || "",
        new_path: newPath || "",
        action: newPath ? (oldPath ? "reassign" : "assign") : "clear",
      });
    }
  }
  return changes;
};

module.exports = { planReassignByOrder, normPath, coercePayload };

if (require.main === module) {
  const db = require("../src/database/db");
  const {
    resolveUploadFilePath,
    getUploadsDir,
  } = require("../src/utils/baDataPaths");

  const parseArgs = (argv) => {
    const get = (flag) => {
      const i = argv.indexOf(flag);
      if (i < 0 || i + 1 >= argv.length) return null;
      return argv[i + 1];
    };
    const limitRaw = get("--limit");
    return {
      apply: argv.includes("--apply"),
      inspect: argv.includes("--inspect"),
      fixFromFiles: argv.includes("--fix-from-files"),
      deviceIp: get("--device-ip"),
      limit: limitRaw != null ? Math.max(1, Number(limitRaw) || 50) : 50,
    };
  };

  const escapeCsv = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const saveReport = (prefix, headers, rows) => {
    const outDir = path.join(__dirname, "..", "uploads", "repair-reports");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(outDir, `${prefix}-${stamp}.csv`);
    const lines = [
      headers.join(","),
      ...rows.map((r) => headers.map((h) => escapeCsv(r[h])).join(",")),
    ];
    fs.writeFileSync(outPath, `\uFEFF${lines.join("\n")}`, "utf8");
    return outPath;
  };

  const setPicturePath = async (id, picturePath) => {
    if (picturePath) {
      await db.query(
        `UPDATE isapi_access_events SET picture_path = ?, file_count = 1 WHERE id = ?`,
        [picturePath, id],
      );
    } else {
      await db.query(
        `UPDATE isapi_access_events SET picture_path = NULL, file_count = 0 WHERE id = ?`,
        [id],
      );
    }
  };

  const scanDiskById = () => {
    const dir = getUploadsDir("access-events");
    const byId = new Map();
    const idRe = /_(\d+)\.(jpe?g|png)$/i;
    if (!fs.existsSync(dir)) return byId;
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(idRe);
      if (!m || byId.has(m[1])) continue;
      byId.set(m[1], `/uploads/access-events/${name}`);
    }
    return byId;
  };

  const runInspect = async ({ limit, deviceIp }) => {
    const params = [];
    let where = "";
    if (deviceIp) {
      where = "WHERE device_ip = ?";
      params.push(deviceIp);
    }
    params.push(limit);
    const rows = await db.query(
      `SELECT id, device_ip, event_time, payload, picture_path
       FROM isapi_access_events ${where}
       ORDER BY event_time DESC, id DESC LIMIT ?`,
      params,
    );
    const report = (rows || []).map((r) => {
      const payload = coercePayload(r.payload);
      const identity = extractAccessEventIdentity(payload);
      const picturePath = normPath(r.picture_path);
      const abs = picturePath ? resolveUploadFilePath(picturePath) : null;
      const fileExists = Boolean(abs && fs.existsSync(abs));
      const display = shouldDisplayAccessEventPicture(payload, picturePath);
      return {
        id: r.id,
        device_ip: r.device_ip,
        event_time: toIso(r.event_time),
        sub: extractSubEventType(payload),
        is_face: shouldQueueAccessEventPicture(payload) ? "Y" : "N",
        employee: identity.employeeNo || "",
        name: identity.personName || "",
        picture_path: picturePath || "",
        file_exists: picturePath ? (fileExists ? "Y" : "N") : "",
        ui_would_show: display ? "Y" : "N",
      };
    });
    console.log(
      `[repair] inspect rows=${report.length} ui_show=${report.filter((r) => r.ui_would_show === "Y").length}`,
    );
    console.log(
      `[repair] report=${saveReport(
        "access-event-inspect",
        [
          "id",
          "device_ip",
          "event_time",
          "sub",
          "is_face",
          "employee",
          "name",
          "picture_path",
          "file_exists",
          "ui_would_show",
        ],
        report,
      )}`,
    );
  };

  const runFixFromFiles = async ({ apply, deviceIp }) => {
    const disk = scanDiskById();
    const relink = [];
    for (const [id, picturePath] of disk) {
      const rows = await db.query(
        `SELECT id, device_ip, payload, picture_path FROM isapi_access_events WHERE id = ?`,
        [id],
      );
      const row = rows?.[0];
      if (!row) continue;
      if (deviceIp && String(row.device_ip) !== String(deviceIp)) continue;
      if (normPath(row.picture_path)) continue;
      const payload = coercePayload(row.payload);
      const isFace = shouldQueueAccessEventPicture(payload);
      relink.push({
        action: apply ? "relink" : "would_relink",
        id: row.id,
        is_face: isFace ? "Y" : "N",
        new_path: picturePath,
      });
      if (apply) await setPicturePath(row.id, picturePath);
    }

    const sql = deviceIp
      ? `SELECT id, device_ip, event_time, payload, picture_path
         FROM isapi_access_events WHERE device_ip = ?
         ORDER BY device_ip ASC, event_time ASC, id ASC`
      : `SELECT id, device_ip, event_time, payload, picture_path
         FROM isapi_access_events
         ORDER BY device_ip ASC, event_time ASC, id ASC`;
    const raw = (await db.query(sql, deviceIp ? [deviceIp] : [])) || [];
    const overrides = new Map(relink.map((r) => [String(r.id), r.new_path]));
    const rows = raw.map((r) => {
      if (normPath(r.picture_path) || !overrides.has(String(r.id))) return r;
      return { ...r, picture_path: overrides.get(String(r.id)) };
    });
    const changes = planReassignByOrder(rows);

    console.log(
      `[repair] mode=${apply ? "APPLY" : "dry-run"} relink=${relink.length} reassign=${changes.length}`,
    );
    console.log(
      `[repair] relink=${saveReport(
        "access-event-relink",
        ["action", "id", "is_face", "new_path"],
        relink,
      )}`,
    );
    console.log(
      `[repair] reassign=${saveReport(
        "access-event-reassign",
        [
          "action",
          "id",
          "sub",
          "employee",
          "name",
          "event_time",
          "old_path",
          "new_path",
        ],
        changes.map((c) => ({
          ...c,
          action: apply ? c.action : `would_${c.action}`,
        })),
      )}`,
    );

    if (apply) {
      for (const c of changes) {
        await setPicturePath(c.id, normPath(c.new_path));
      }
    } else {
      console.log("[repair] 核對 CSV（764 的 new_path 應為 …_763.jpg 這類推移）後加 --apply");
    }
  };

  const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.inspect) {
      await runInspect(args);
      return;
    }
    if (args.fixFromFiles) {
      await runFixFromFiles(args);
      return;
    }
    console.log(`用法:
  node scripts/repairAccessEventPictures.js --fix-from-files
  node scripts/repairAccessEventPictures.js --fix-from-files --apply
  node scripts/repairAccessEventPictures.js --inspect --limit 500`);
  };

  main()
    .catch((err) => {
      console.error("[repair] 失敗:", err?.message || err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await db.close();
      } catch (_e) {}
    });
}
