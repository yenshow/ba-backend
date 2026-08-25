const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const SftpClient = require("ssh2-sftp-client");
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { encryptSecret, decryptSecret } = require("../../utils/secretCrypto");
const { getAdapter, requireEventType } = require("./eventTypeRegistry");
const {
  normalizeScheduleFreq,
  normalizeScheduleDay,
  resolveExportWindow,
} = require("./exportSchedule");

const CSV_BOM = "\uFEFF";

function requireNonEmpty(value, name) {
  const v = String(value ?? "").trim();
  if (!v) {
    throwApiError(C.VALIDATION_CUSTOM, `${name} 為必填`, { statusCode: 400 });
  }
  return v;
}

function requireTimeHHmm(value, name) {
  const v = String(value ?? "").trim();
  if (!/^\d{2}:\d{2}$/.test(v)) {
    throwApiError(C.VALIDATION_CUSTOM, `${name} 格式必須為 HH:mm`, { statusCode: 400 });
  }
  return v;
}

function normalizeOutputFormat(raw) {
  return String(raw ?? "").trim().toLowerCase() === "txt" ? "txt" : "csv";
}

function normalizeStorageType(raw) {
  return String(raw ?? "").trim().toLowerCase() === "sftp" ? "sftp" : "local";
}

function safeCsvCell(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replaceAll("\"", "\"\"")}"`;
  return s;
}

function rowsToCsv(headers, rows) {
  let out = CSV_BOM + headers.map(safeCsvCell).join(",") + "\n";
  for (const r of rows) out += r.map(safeCsvCell).join(",") + "\n";
  return out;
}

function rowsToTxt(headers, rows) {
  const head = headers.join("\t");
  const lines = rows.map((r) => r.map((v) => (v == null ? "" : String(v))).join("\t"));
  return [head, ...lines].join("\n") + "\n";
}

function parseFilterJson(raw) {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

async function listRules(eventType) {
  const params = [];
  let sql = "SELECT * FROM record_export_rules";
  if (eventType) {
    const type = requireEventType(eventType);
    sql += " WHERE event_type = ?";
    params.push(type);
  }
  sql += " ORDER BY id DESC";
  const rules = await db.query(sql, params);
  if (!rules?.length) return [];

  const ruleIds = rules.map((r) => r.id);
  const placeholders = ruleIds.map(() => "?").join(", ");

  const [groupRows, fieldRows] = await Promise.all([
    db.query(
      `SELECT rule_id, group_id FROM record_export_rule_groups WHERE rule_id IN (${placeholders}) ORDER BY rule_id ASC, group_id ASC`,
      ruleIds,
    ),
    db.query(
      `SELECT rule_id, field_key, header_label, format, sort_order FROM record_export_field_mappings WHERE rule_id IN (${placeholders}) ORDER BY rule_id ASC, sort_order ASC, id ASC`,
      ruleIds,
    ),
  ]);

  const groupIdsByRule = new Map();
  for (const row of groupRows || []) {
    if (!groupIdsByRule.has(row.rule_id)) groupIdsByRule.set(row.rule_id, []);
    groupIdsByRule.get(row.rule_id).push(row.group_id);
  }

  const fieldsByRule = new Map();
  for (const row of fieldRows || []) {
    if (!fieldsByRule.has(row.rule_id)) fieldsByRule.set(row.rule_id, []);
    fieldsByRule.get(row.rule_id).push({
      fieldKey: row.field_key,
      headerLabel: row.header_label ?? "",
      format: row.format ?? "",
    });
  }

  return rules.map((r) => {
    const filter = parseFilterJson(r.filter_json);
    const legacyGroups = groupIdsByRule.get(r.id) ?? [];
    if (
      r.event_type === "access_control" &&
      (!Array.isArray(filter.groupIds) || filter.groupIds.length === 0) &&
      legacyGroups.length
    ) {
      filter.groupIds = legacyGroups;
    }
    return {
      id: r.id,
      eventType: r.event_type,
      name: r.name,
      filenamePrefix: r.filename_prefix,
      dateFormat: r.date_format,
      timeFormat: r.time_format,
      outputFormat: r.output_format,
      exportTime: String(r.export_time).slice(0, 5),
      scheduleFreq: normalizeScheduleFreq(r.schedule_freq) || "daily",
      scheduleDay: r.schedule_day != null ? Number(r.schedule_day) : null,
      storageType: r.storage_type,
      localDir: r.local_dir ?? "",
      sftp:
        r.storage_type === "sftp"
          ? {
              host: r.sftp_host ?? "",
              port: r.sftp_port ?? 22,
              username: r.sftp_username ?? "",
              remoteDir: r.sftp_remote_dir ?? "",
            }
          : null,
      filter,
      groupIds: filter.groupIds || legacyGroups,
      fields: fieldsByRule.get(r.id) ?? [],
    };
  });
}

function validateRulePayload(payload, options = {}) {
  const ruleId = options.ruleId ? Number(options.ruleId) : null;
  const isUpdate = Number.isFinite(ruleId) && ruleId > 0;
  const eventType = requireEventType(payload.eventType || "access_control");
  const adapter = getAdapter(eventType);

  const name = requireNonEmpty(payload.name, "規則名稱");
  const filenamePrefix = requireNonEmpty(payload.filenamePrefix, "檔案名稱前綴");
  const dateFormat = requireNonEmpty(payload.dateFormat, "檔名日期格式");
  const timeFormat = requireNonEmpty(payload.timeFormat, "檔名時間格式");
  const exportTime = requireTimeHHmm(payload.exportTime, "匯出時間");
  const scheduleFreq = normalizeScheduleFreq(payload.scheduleFreq ?? "daily");
  if (!scheduleFreq) {
    throwApiError(C.VALIDATION_CUSTOM, "排程頻率必須為 daily／weekly／monthly", {
      statusCode: 400,
    });
  }
  const scheduleDay = normalizeScheduleDay(scheduleFreq, payload.scheduleDay);
  if (scheduleFreq === "weekly" && scheduleDay == null) {
    throwApiError(C.VALIDATION_CUSTOM, "每週排程須指定星期（1=一…7=日）", {
      statusCode: 400,
    });
  }
  if (scheduleFreq === "monthly" && scheduleDay == null) {
    throwApiError(C.VALIDATION_CUSTOM, "每月排程須指定日期（1–31）", {
      statusCode: 400,
    });
  }
  const outputFormat = normalizeOutputFormat(payload.outputFormat);
  const storageType = normalizeStorageType(payload.storageType);

  const rawFilter =
    payload.filter && typeof payload.filter === "object"
      ? payload.filter
      : payload.groupIds
        ? { groupIds: payload.groupIds }
        : {};
  const filter = adapter.validateFilter(rawFilter);

  const fields = Array.isArray(payload.fields) ? payload.fields : [];
  if (fields.length === 0) {
    throwApiError(C.VALIDATION_CUSTOM, "內容至少需選擇一個欄位", { statusCode: 400 });
  }
  for (const f of fields) {
    const fieldKey = String(f?.fieldKey ?? "").trim();
    const catalog = adapter.getFieldByKey(fieldKey);
    if (!catalog) {
      throwApiError(C.VALIDATION_CUSTOM, `不支援的欄位: ${fieldKey}`, { statusCode: 400 });
    }
    requireNonEmpty(f?.headerLabel, `欄位「${catalog.label}」輸出表頭`);
    if (catalog.requiresFormat) {
      requireNonEmpty(f?.format, `欄位「${catalog.label}」格式`);
    }
  }

  const localDir = storageType === "local" ? requireNonEmpty(payload.localDir, "儲存路徑") : "";
  const sftpPasswordRaw =
    storageType === "sftp" ? String(payload?.sftp?.password ?? "").trim() : "";
  const sftp =
    storageType === "sftp"
      ? {
          host: requireNonEmpty(payload?.sftp?.host, "SFTP 主機"),
          port: Number(payload?.sftp?.port ?? 22),
          username: requireNonEmpty(payload?.sftp?.username, "SFTP 使用者名稱"),
          password: sftpPasswordRaw,
          remoteDir: requireNonEmpty(payload?.sftp?.remoteDir, "SFTP 儲存路徑"),
        }
      : null;
  if (sftp && !isUpdate && !sftp.password) {
    throwApiError(C.VALIDATION_CUSTOM, "SFTP 密碼為必填", { statusCode: 400 });
  }
  if (sftp && (!Number.isFinite(sftp.port) || sftp.port < 1 || sftp.port > 65535)) {
    throwApiError(C.VALIDATION_CUSTOM, "SFTP Port 必須為 1–65535", { statusCode: 400 });
  }

  return {
    eventType,
    name,
    enabled: payload.enabled !== false,
    filenamePrefix,
    dateFormat,
    timeFormat,
    outputFormat,
    exportTime,
    scheduleFreq,
    scheduleDay,
    storageType,
    localDir,
    sftp,
    filter,
    fields,
  };
}

async function upsertRule(ruleId, payload) {
  let id = ruleId ? Number(ruleId) : null;
  if (id && !Number.isFinite(id)) id = null;

  const normalized = validateRulePayload(payload, { ruleId: id });

  let sftpPasswordEnc = null;
  if (normalized.storageType === "sftp") {
    if (normalized.sftp.password) {
      sftpPasswordEnc = encryptSecret(normalized.sftp.password);
    } else if (id) {
      const rows = await db.query(
        "SELECT sftp_password_enc FROM record_export_rules WHERE id = ? LIMIT 1",
        [id],
      );
      sftpPasswordEnc = rows?.[0]?.sftp_password_enc ?? null;
    }
  }

  return db.transaction(async (q) => {
    const params = [
      normalized.eventType,
      normalized.name,
      normalized.enabled,
      normalized.filenamePrefix,
      normalized.dateFormat,
      normalized.timeFormat,
      normalized.outputFormat,
      normalized.exportTime,
      normalized.scheduleFreq,
      normalized.scheduleDay,
      normalized.storageType,
      normalized.storageType === "local" ? normalized.localDir : null,
      normalized.storageType === "sftp" ? normalized.sftp.host : null,
      normalized.storageType === "sftp" ? Math.trunc(normalized.sftp.port) : null,
      normalized.storageType === "sftp" ? normalized.sftp.username : null,
      normalized.storageType === "sftp" ? sftpPasswordEnc : null,
      normalized.storageType === "sftp" ? normalized.sftp.remoteDir : null,
      JSON.stringify(normalized.filter || {}),
    ];

    if (!id) {
      const rows = await q(
        `
          INSERT INTO record_export_rules
            (event_type, name, enabled, filename_prefix, date_format, time_format, output_format, export_time, schedule_freq, schedule_day, storage_type, local_dir, sftp_host, sftp_port, sftp_username, sftp_password_enc, sftp_remote_dir, filter_json)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?::time, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
          RETURNING id
        `,
        params,
      );
      id = rows?.[0]?.id ?? null;
    } else {
      params.push(id);
      await q(
        `
          UPDATE record_export_rules
          SET event_type = ?, name = ?, enabled = ?, filename_prefix = ?, date_format = ?, time_format = ?, output_format = ?, export_time = ?::time,
              schedule_freq = ?, schedule_day = ?,
              storage_type = ?, local_dir = ?, sftp_host = ?, sftp_port = ?, sftp_username = ?, sftp_password_enc = ?, sftp_remote_dir = ?,
              filter_json = ?::jsonb, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        params,
      );
    }

    if (!id) {
      throwApiError(C.INTERNAL_ERROR, "儲存規則失敗", { statusCode: 500 });
    }

    await q("DELETE FROM record_export_field_mappings WHERE rule_id = ?", [id]);
    let sortOrder = 0;
    for (const f of normalized.fields) {
      sortOrder += 1;
      await q(
        `INSERT INTO record_export_field_mappings
           (rule_id, field_key, header_label, format, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
        [
          id,
          String(f.fieldKey).trim(),
          f.headerLabel != null ? String(f.headerLabel).trim() : null,
          f.format != null ? String(f.format).trim() : null,
          sortOrder,
        ],
      );
    }

    return { id };
  });
}

async function deleteRule(ruleId) {
  const id = Number(ruleId);
  if (!Number.isFinite(id) || id <= 0) return;
  await db.query("DELETE FROM record_export_rules WHERE id = ?", [id]);
}

function buildExportFilename(rule, now) {
  const dt = DateTime.fromJSDate(now).setZone("Asia/Taipei");
  const dateToken = dt.toFormat(rule.date_format);
  const timeToken = dt.toFormat(rule.time_format);
  const ext = rule.output_format === "txt" ? "txt" : "csv";
  return `${rule.filename_prefix}_${dateToken}_${timeToken}.${ext}`;
}

async function writeRuleOutputLocal(rule, filename, content) {
  const dir = rule.local_dir;
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  if (fs.existsSync(fullPath)) {
    const parsed = path.parse(fullPath);
    let i = 1;
    while (true) {
      const next = path.join(parsed.dir, `${parsed.name}_${i}${parsed.ext}`);
      if (!fs.existsSync(next)) {
        fs.writeFileSync(next, content, "utf8");
        return next;
      }
      i += 1;
    }
  }
  fs.writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

async function writeRuleOutputSftp(rule, filename, content, password) {
  const client = new SftpClient();
  await client.connect({
    host: rule.sftp_host,
    port: rule.sftp_port || 22,
    username: rule.sftp_username,
    password,
    readyTimeout: 10000,
  });
  try {
    const remoteDir = String(rule.sftp_remote_dir || "").trim() || "/";
    const remotePath = remoteDir.endsWith("/")
      ? `${remoteDir}${filename}`
      : `${remoteDir}/${filename}`;
    await client.mkdir(remoteDir, true).catch(() => {});
    const exists = await client.exists(remotePath);
    if (exists) {
      const parsed = path.parse(remotePath);
      let i = 1;
      while (true) {
        const next = `${parsed.dir}/${parsed.name}_${i}${parsed.ext}`;
        if (!(await client.exists(next))) {
          await client.put(Buffer.from(content, "utf8"), next);
          return next;
        }
        i += 1;
      }
    }
    await client.put(Buffer.from(content, "utf8"), remotePath);
    return remotePath;
  } finally {
    await client.end().catch(() => {});
  }
}

async function getRuleSftpPassword(ruleId) {
  const rows = await db.query(
    "SELECT sftp_password_enc FROM record_export_rules WHERE id = ? LIMIT 1",
    [ruleId],
  );
  const enc = rows?.[0]?.sftp_password_enc ?? "";
  return enc ? decryptSecret(enc) : "";
}

async function runRecordExportRule(ruleId) {
  const rules = await db.query("SELECT * FROM record_export_rules WHERE id = ? LIMIT 1", [
    ruleId,
  ]);
  const rule = rules?.[0];
  if (!rule || !rule.enabled) return { skipped: true };

  const adapter = getAdapter(rule.event_type);
  let filter = parseFilterJson(rule.filter_json);
  if (rule.event_type === "access_control" && !filter.groupIds?.length) {
    const groupRows = await db.query(
      "SELECT group_id FROM record_export_rule_groups WHERE rule_id = ?",
      [ruleId],
    );
    filter = { groupIds: (groupRows || []).map((r) => r.group_id).filter(Boolean) };
  }

  const fieldRows = await db.query(
    "SELECT field_key, header_label, format FROM record_export_field_mappings WHERE rule_id = ? ORDER BY sort_order ASC, id ASC",
    [ruleId],
  );
  const fieldConfigs = (fieldRows || []).map((r) => ({
    fieldKey: r.field_key,
    headerLabel: (r.header_label ?? "").toString().trim(),
    format: r.format ?? "",
  }));
  if (fieldConfigs.length === 0) {
    throwApiError(C.VALIDATION_CUSTOM, "規則未設定任何輸出欄位", { statusCode: 400 });
  }

  const now = new Date();
  const { start, end } = resolveExportWindow({
    scheduleFreq: rule.schedule_freq,
    scheduleDay: rule.schedule_day,
    now,
  });

  const logRows = await db.query(
    "INSERT INTO record_export_run_logs (rule_id, success, row_count, file_paths) VALUES (?, FALSE, 0, ARRAY[]::TEXT[]) RETURNING id",
    [ruleId],
  );
  const logId = logRows?.[0]?.id;

  try {
    const events = await adapter.fetchForExport({
      filter,
      startTime: start,
      endTime: end,
    });

    const headers = fieldConfigs.map(
      (f) => f.headerLabel || adapter.getFieldByKey(f.fieldKey)?.label || f.fieldKey,
    );
    const rows = events.map((evt) =>
      fieldConfigs.map((f) => adapter.mapValue(evt, f.fieldKey, f)),
    );

    const content =
      rule.output_format === "txt" ? rowsToTxt(headers, rows) : rowsToCsv(headers, rows);
    const filename = buildExportFilename(rule, now);

    let filePath = "";
    if (rule.storage_type === "sftp") {
      const password = await getRuleSftpPassword(ruleId);
      filePath = await writeRuleOutputSftp(rule, filename, content, password);
    } else {
      filePath = await writeRuleOutputLocal(rule, filename, content);
    }

    await db.query(
      "UPDATE record_export_run_logs SET finished_at = ?, success = TRUE, row_count = ?, file_paths = ?::TEXT[], error_message = NULL WHERE id = ?",
      [new Date(), rows.length, [filePath], logId],
    );
    return { ok: true, rowCount: rows.length, filePath };
  } catch (err) {
    await db.query(
      "UPDATE record_export_run_logs SET finished_at = ?, success = FALSE, error_message = ? WHERE id = ?",
      [new Date(), err?.message || String(err), logId],
    );
    throw err;
  }
}

module.exports = {
  listRules,
  upsertRule,
  deleteRule,
  runRecordExportRule,
};
