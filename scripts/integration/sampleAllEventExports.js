/**
 * 六種 eventType 實際匯出欄位取樣（對接／轉存同源 catalog）
 *
 *   cd ba-backend
 *   npm run test:data-export:sample-all
 *   npm run test:data-export:sample-all -- --event-type access_control
 *   npm run test:data-export:sample-all -- --days 30 --limit 200 --format txt
 *
 * 產出: tmp/data-export/<eventType>.csv|.txt + SUMMARY.md（單一類型時略過 SUMMARY）
 * 取樣語意：相對「現在」往回看 --days（預設 90，非僅今天），取時間最近的 --limit 筆（預設 500；CSV 內時間升序）。
 * energy／environment：先 hourly，近窗 0 筆則改 raw。
 * 不含完整報表統計區塊；僅 adapter 可映射欄位。
 * --limit 上限 50000（與 adapter clampLimit 一致）。
 */

const fs = require("fs");
const path = require("path");

process.chdir(path.resolve(__dirname, "../.."));

const db = require("../../src/database/db");
const {
  EVENT_TYPES,
  getAdapter,
} = require("../../src/services/externalIntegration/eventTypeRegistry");

/** @type {Record<string, string>} */
const EXPECTED = {
  access_control:
    "門禁管理模組全量：門禁設備＋人臉攝影機逐筆；含出入口 ID、進出方向／驗證方式；各類型另附可自訂表頭的空白欄。",
  vehicle: "過車逐筆（車牌／時間／地點）；非進出／群組統計表。",
  energy: "預設小時彙總（energy_usage_aggregated）；grain=raw 為原始讀數。",
  environment: "預設小時平均（environment_readings_aggregated）；grain=raw 為原始讀數。",
  operational: "營運事件時間軸逐筆。",
  alerts: "警報主表逐筆（非 alert_events 子表）。",
};

const DEFAULT_FORMATS = {
  datetime: "yyyy-MM-dd HH:mm:ss",
  date: "yyyy-MM-dd",
  time: "HH:mm:ss",
};

const takeFlag = (argv, name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};

const escapeCsv = (value) => {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
};

const resolveFormat = (field) => {
  if (!field.requiresFormat) return undefined;
  if (field.formatKind === "date") return DEFAULT_FORMATS.date;
  if (field.formatKind === "time") return DEFAULT_FORMATS.time;
  return DEFAULT_FORMATS.datetime;
};

const fetchEvents = async (adapter, { days, limit, accessGrain }) => {
  const endTime = new Date();
  const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const isEnergyEnv =
    adapter.eventType === "energy" || adapter.eventType === "environment";
  const isAccess = adapter.eventType === "access_control";

  let grains;
  if (isEnergyEnv) grains = ["hourly", "raw"];
  else if (isAccess && accessGrain) grains = [accessGrain];
  else grains = [null];

  let events = [];
  let grain = null;
  for (const tryGrain of grains) {
    const filter = tryGrain ? { grain: tryGrain } : {};
    const raw = await adapter.fetchForExport({
      filter,
      startTime,
      endTime,
      limit: 50000,
    });
    const all = Array.isArray(raw) ? raw : [];
    if (all.length === 0 && tryGrain === "hourly") continue;
    events = all.length > limit ? all.slice(all.length - limit) : all;
    grain = tryGrain;
    break;
  }
  return { events, grain };
};

const resolveSourceNote = (adapter, grain) => {
  if (adapter.eventType === "access_control") {
    const mode =
      grain === "daily_first_last"
        ? "daily_first_last（每人每日最早＋最晚）"
        : "逐筆 raw";
    return `isapi_access_events＋isapi_face_contrast_events（${mode}）`;
  }
  if (adapter.eventType === "energy") {
    return grain === "hourly"
      ? "energy_usage_aggregated（hour）"
      : "energy_readings";
  }
  if (adapter.eventType === "environment") {
    return grain === "hourly"
      ? "environment_readings_aggregated（hour）"
      : "environment_readings";
  }
  return adapter.sourceTable || "—";
};

const writeCsv = (filePath, headers, rows) => {
  const body = [
    headers.map(escapeCsv).join(","),
    ...rows.map((r) => r.map(escapeCsv).join(",")),
  ].join("\r\n");
  fs.writeFileSync(filePath, `\uFEFF${body}\r\n`, "utf8");
};

/** 與 recordExportService.rowsToTxt 相同：表頭＋資料列以 Tab 分隔 */
const writeTxt = (filePath, headers, rows) => {
  const head = headers.join("\t");
  const lines = rows.map((r) => r.map((v) => (v == null ? "" : String(v))).join("\t"));
  fs.writeFileSync(filePath, `${head}\n${lines.join("\n")}\n`, "utf8");
};

const sampleOne = async (eventType, { days, limit, outDir, format, accessGrain }) => {
  const adapter = getAdapter(eventType);
  const catalog = adapter.catalog || [];
  const headers = catalog.map((f) => f.label || f.key);
  const keys = catalog.map((f) => f.key);

  let events = [];
  let grain = null;
  let error = null;
  try {
    const fetched = await fetchEvents(adapter, { days, limit, accessGrain });
    events = fetched.events;
    grain = fetched.grain;
  } catch (err) {
    error = err?.message || String(err);
  }

  const rows = events.map((evt) =>
    catalog.map((f) => adapter.mapValue(evt, f.key, { format: resolveFormat(f) })),
  );

  const ext = format === "txt" ? "txt" : "csv";
  const outName = `${eventType}.${ext}`;
  const outPath = path.join(outDir, outName);
  if (!error) {
    if (format === "txt") writeTxt(outPath, headers, rows);
    else writeCsv(outPath, headers, rows);
  }

  const dtoExtra =
    events[0] != null
      ? Object.keys(events[0]).filter(
          (k) =>
            !keys.includes(k) &&
            k !== "id" &&
            k !== "timestamp" &&
            k !== "locationId",
        )
      : [];

  return {
    eventType,
    label: adapter.label,
    sourceTable: resolveSourceNote(adapter, grain),
    grain,
    catalogKeys: keys,
    catalogLabels: headers,
    rowCount: rows.length,
    csvName: error ? null : outName,
    error,
    dtoExtra,
    expected: EXPECTED[eventType] || "",
    samplePreview: rows.slice(0, 2),
  };
};

const writeSummary = (outDir, results, { days, limit }) => {
  const lines = [
    "# 資料匯出取樣摘要",
    "",
    `- 產生時間: ${new Date().toISOString()}`,
    `- 視窗: 近 ${days} 天內、相對現在最近最多 ${limit} 筆（CSV 時間升序）`,
    `- 通道: adapter.fetchForExport（升序）＋腳本裁成最近 N 筆`,
    `- 能源／環境：優先小時彙總；近窗 0 筆則改原始讀數`,
    `- **不含** 完整報表進出統計／群組統計等彙總`,
    `- 列舉欄位（狀態／來源／類型等）已中文化；人名、地點、設備名、JSON、路徑維持原文`,
    "",
    "## 總覽",
    "",
    "| 事件類型 | 標籤 | 實際來源 | 筆數 | 檔案 | 狀態 |",
    "|-----------|------|----------|------|------|------|",
  ];

  for (const r of results) {
    const status = r.error ? `錯誤: ${r.error}` : r.rowCount > 0 ? "正常" : "無資料";
    lines.push(
      `| \`${r.eventType}\` | ${r.label} | \`${r.sourceTable}\` | ${r.rowCount} | ${r.csvName || "—"} | ${status} |`,
    );
  }

  lines.push("", "## 各類型欄位與預期", "");

  for (const r of results) {
    lines.push(`### ${r.eventType}（${r.label}）`);
    lines.push("");
    lines.push(`- 預期: ${r.expected}`);
    lines.push(`- 實際來源: \`${r.sourceTable}\``);
    lines.push(
      `- 欄位目錄: ${r.catalogKeys.map((k, i) => `${k}「${r.catalogLabels[i]}」`).join("、")}`,
    );
    if (r.dtoExtra.length) {
      lines.push(
        `- 內部欄位有但匯出目錄未映射: ${r.dtoExtra.join(", ")}（正式對接／轉存介面無法勾選）`,
      );
    }
    if (r.rowCount === 0 && !r.error) {
      lines.push("- 本機近窗無列：屬環境資料量問題，不代表 adapter 壞掉。");
    }
    if (r.error) {
      lines.push(`- 錯誤: ${r.error}`);
    }
    lines.push("");
  }

  lines.push("## 與完整報表對照（簡）", "");
  lines.push("| 系統 | 完整報表常有 | 本取樣／對接轉存 |");
  lines.push("|------|--------------|------------------|");
  lines.push("| 門禁／人流介面 | 進出統計＋群組統計＋明細 | 門禁＋人臉明細用 `access_control` |");
  lines.push("| 車輛 | 統計＋群組＋過車紀錄 | 僅過車明細 `vehicle` |");
  lines.push("| 能源 | 小時／日彙總＋原始 | 預設小時彙總；`grain=raw` 才讀原始讀數 |");
  lines.push("| 環境 | 時間桶平均＋明細 | 預設小時平均；`grain=raw` 才讀原始讀數 |");
  lines.push("");

  const summaryPath = path.join(outDir, "SUMMARY.md");
  fs.writeFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
  return summaryPath;
};

const main = async () => {
  const argv = process.argv.slice(2);
  const days = Math.min(
    Math.max(Number.parseInt(takeFlag(argv, "--days") || "90", 10) || 90, 1),
    365,
  );
  const limit = Math.min(
    Math.max(Number.parseInt(takeFlag(argv, "--limit") || "500", 10) || 500, 1),
    50000,
  );
  const formatRaw = String(takeFlag(argv, "--format") || "csv").trim().toLowerCase();
  const format = formatRaw === "txt" ? "txt" : "csv";
  const grainArg = takeFlag(argv, "--grain");
  const accessGrain =
    grainArg && ["raw", "daily_first_last"].includes(String(grainArg).trim())
      ? String(grainArg).trim()
      : null;
  const eventTypeFilter = takeFlag(argv, "--event-type");
  const types = eventTypeFilter
    ? (() => {
        const v = String(eventTypeFilter).trim();
        if (!EVENT_TYPES.includes(v)) throw new Error(`未知 eventType: ${v}`);
        return [v];
      })()
    : [...EVENT_TYPES];
  const outDir = path.resolve(
    takeFlag(argv, "--out-dir") || path.join("tmp", "data-export"),
  );
  fs.mkdirSync(outDir, { recursive: true });
  if (types.length === EVENT_TYPES.length) {
    for (const name of fs.readdirSync(outDir)) {
      const full = path.join(outDir, name);
      if (!fs.statSync(full).isFile()) continue;
      if (name.endsWith(".csv") || name === "SUMMARY.md") fs.unlinkSync(full);
    }
  } else {
    const target = path.join(outDir, `${types[0]}.${format}`);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }

  console.log(`取樣目錄: ${outDir}`);
  console.log(`格式: ${format.toUpperCase()}（Tab 分隔＝正式轉存 txt）`);
  if (accessGrain) console.log(`門禁粒度: ${accessGrain}`);
  console.log(`近 ${days} 天內、相對現在最近最多 ${limit} 筆（時間升序輸出）\n`);

  const results = [];
  for (const eventType of types) {
    process.stdout.write(`… ${eventType} `);
    const r = await sampleOne(eventType, {
      days,
      limit,
      outDir,
      format,
      accessGrain: eventType === "access_control" ? accessGrain : null,
    });
    results.push(r);
    console.log(
      r.error ? `FAIL ${r.error}` : r.rowCount > 0 ? `${r.rowCount} 筆 → ${r.csvName}` : "0 筆",
    );
  }

  if (types.length === EVENT_TYPES.length) {
    const summaryPath = writeSummary(outDir, results, { days, limit });
    console.log(`\nSUMMARY → ${summaryPath}`);
  }
};

main()
  .then(async () => {
    await db.close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("失敗:", err?.message || err);
    try {
      await db.close();
    } catch (_e) {
      /* ignore */
    }
    process.exit(1);
  });
