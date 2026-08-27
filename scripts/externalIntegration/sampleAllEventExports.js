/**
 * 六種 eventType 實際匯出欄位取樣（對接／轉存同源 catalog）
 *
 *   cd ba-backend
 *   npm run test:data-export:sample-all
 *   npm run test:data-export:sample-all -- --days 90 --limit 10
 *   npm run test:data-export:sample-all -- --days 365 --limit 100
 *
 * 產出: tmp/data-export-samples/<eventType>.csv + SUMMARY.md
 * 取樣語意：相對「現在」往回看 --days，取時間最近的 --limit 筆（CSV 內時間升序）。
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

const fetchEvents = async (adapter, { days, limit }) => {
  const endTime = new Date();
  const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // 腳本專用：多取再裁成「相對現在最近 N 筆」（production adapter 僅 ASC，無 newestFirst）
  const raw = await adapter.fetchForExport({
    filter: {},
    startTime,
    endTime,
    limit: 50000,
  });
  const all = Array.isArray(raw) ? raw : [];
  const events = all.length > limit ? all.slice(all.length - limit) : all;
  const grain =
    adapter.eventType === "energy" || adapter.eventType === "environment"
      ? "hourly"
      : null;
  return { events, grain };
};

const resolveSourceNote = (adapter, grain) => {
  if (adapter.eventType === "access_control") {
    return "isapi_access_events＋isapi_face_contrast_events";
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

const sampleOne = async (eventType, { days, limit, outDir }) => {
  const adapter = getAdapter(eventType);
  const catalog = adapter.catalog || [];
  const headers = catalog.map((f) => f.label || f.key);
  const keys = catalog.map((f) => f.key);

  let events = [];
  let grain = null;
  let error = null;
  try {
    const fetched = await fetchEvents(adapter, { days, limit });
    events = fetched.events;
    grain = fetched.grain;
  } catch (err) {
    error = err?.message || String(err);
  }

  const rows = events.map((evt) =>
    catalog.map((f) => adapter.mapValue(evt, f.key, { format: resolveFormat(f) })),
  );

  const csvName = `${eventType}.csv`;
  const csvPath = path.join(outDir, csvName);
  if (!error) {
    writeCsv(csvPath, headers, rows);
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
    csvName: error ? null : csvName,
    error,
    dtoExtra,
    expected: EXPECTED[eventType] || "",
    samplePreview: rows.slice(0, 2),
  };
};

const writeSummary = (outDir, results, { days, limit }) => {
  const lines = [
    "# 資料匯出取樣 SUMMARY",
    "",
    `- 產生時間: ${new Date().toISOString()}`,
    `- 視窗: 近 ${days} 天內、相對現在最近最多 ${limit} 筆（CSV 時間升序）`,
    `- 通道: adapter.fetchForExport（ASC）＋腳本裁成最近 N 筆`,
    `- energy／environment：本取樣固定 grain=hourly（raw 需另行指定）`,
    `- **不含** 完整報表進出統計／群組統計等彙總`,
    "",
    "## 總覽",
    "",
    "| eventType | 標籤 | 實際來源 | 筆數 | 檔案 | 狀態 |",
    "|-----------|------|----------|------|------|------|",
  ];

  for (const r of results) {
    const status = r.error ? `錯誤: ${r.error}` : r.rowCount > 0 ? "OK" : "無資料";
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
    lines.push(`- catalog: ${r.catalogKeys.map((k, i) => `${k}「${r.catalogLabels[i]}」`).join("、")}`);
    if (r.dtoExtra.length) {
      lines.push(
        `- DTO 有但 catalog 未映射: ${r.dtoExtra.join(", ")}（正式對接／轉存 UI 無法勾這些欄）`,
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
  lines.push("| 門禁／人流 UI | 進出統計＋群組統計＋明細 | 門禁＋人臉明細用 `access_control` |");
  lines.push("| 車輛 | 統計＋群組＋過車紀錄 | 僅過車明細 `vehicle` |");
  lines.push("| 能源 | 小時／日彙總＋原始 | 預設小時彙總；`grain=raw` 才讀 `energy_readings` |");
  lines.push("| 環境 | 時間桶平均＋明細 | 預設小時平均；`grain=raw` 才讀 `environment_readings` |");
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
    Math.max(Number.parseInt(takeFlag(argv, "--limit") || "10", 10) || 10, 1),
    50000,
  );
  const outDir = path.resolve(
    takeFlag(argv, "--out-dir") || path.join("tmp", "data-export-samples"),
  );
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`取樣目錄: ${outDir}`);
  console.log(`近 ${days} 天內、相對現在最近最多 ${limit} 筆（時間升序輸出）\n`);

  const results = [];
  for (const eventType of EVENT_TYPES) {
    process.stdout.write(`… ${eventType} `);
    const r = await sampleOne(eventType, { days, limit, outDir });
    results.push(r);
    console.log(
      r.error ? `FAIL ${r.error}` : r.rowCount > 0 ? `${r.rowCount} 筆 → ${r.csvName}` : "0 筆",
    );
  }

  const summaryPath = writeSummary(outDir, results, { days, limit });
  console.log(`\nSUMMARY → ${summaryPath}`);
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
