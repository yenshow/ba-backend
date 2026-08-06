#!/usr/bin/env node
/**
 * Portable PostgreSQL → Windows 服務（pg_ctl register）。
 *
 * Usage:
 *   node postgres-windows-service.js register --product YSOP
 *   node postgres-windows-service.js unregister --product YSOP
 *   node postgres-windows-service.js start|stop|status --product YSOP
 *
 * 須以系統管理員執行 register／unregister／start／stop。
 */

const { spawnSync } = require("child_process");
const path = require("path");
const {
  DATA_DIR,
  getBinPath,
  isPostgresDownloaded,
  isDatabaseInitialized,
} = require("./postgres-common");
const { resolveProductCode, serviceNames } = require("./windows-product-services");

const isWin = process.platform === "win32";

function run(file, args, opts = {}) {
  const r = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...opts,
  });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}

function parseArgs(argv) {
  const out = { cmd: "", product: null };
  const rest = argv.slice(2);
  out.cmd = (rest[0] || "").toLowerCase();
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === "--product" && rest[i + 1]) {
      out.product = rest[++i];
    } else if (rest[i] === "--install-root" && rest[i + 1]) {
      // product derived from folder if not set
      out.installRoot = rest[++i];
    }
  }
  if (!out.product && out.installRoot) {
    out.product = resolveProductCode(out.installRoot);
  }
  if (!out.product) {
    throw new Error("請指定 --product YSOP|YSOS 或 --install-root <path>");
  }
  return out;
}

function scQuery(serviceName) {
  const r = run("sc.exe", ["query", serviceName]);
  const text = `${r.stdout}\n${r.stderr}`;
  if (/FAILED\s+1060/i.test(text) || /does not exist/i.test(text)) {
    return { exists: false, running: false, stopPending: false, raw: text };
  }
  const running = /STATE\s*:\s*\d+\s+RUNNING/i.test(text);
  const stopPending = /STOP_PENDING/i.test(text);
  return {
    exists: r.status === 0 || /STATE\s*:/i.test(text),
    running,
    stopPending,
    raw: text,
  };
}

/** 剝除非 ASCII，避免 Windows 主控台輸出被當 UTF-8 解成亂碼。 */
function sanitizeConsoleText(text, maxLen = 240) {
  const ascii = String(text || "")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!ascii) {
    return "";
  }
  return ascii.length > maxLen ? `${ascii.slice(0, maxLen)}…` : ascii;
}

/** 避免 sc.exe 繁中主控台輸出被當 UTF-8 解成亂碼；改以錯誤碼對應說明。 */
function formatScFailure(action, r) {
  const text = `${r.stdout}\n${r.stderr}`;
  const known = {
    2: "找不到服務執行檔（路徑失效或 PostgreSQL／WinSW 尚未就緒；請先完成一鍵設定①～④）",
    1051: "尚有相依服務在執行，無法停止此服務（須先等 Backend／Frontend 完全停止）",
    1056: "服務已在執行",
    1060: "服務不存在",
    1062: "服務尚未啟動",
    1072: "服務已標記刪除",
  };
  // sc.exe 繁中：「StartService … 2:」；英文 FAILED 1051 等
  const m =
    text.match(/(?:FAILED|失敗|StartService|ControlService)[^\d]{0,40}\b(\d{1,4})\b/i) ||
    text.match(/\b(1051|1056|1060|1062|1072)\b/);
  const code = m ? m[1] : null;
  if (code && known[code]) {
    return `[SC] ${action} ${code}：${known[code]}`;
  }
  const ascii = sanitizeConsoleText(text);
  return ascii
    ? `[SC] ${action}：${ascii}`
    : `[SC] ${action} 失敗（exit ${r.status}）`;
}

function sleepSeconds(n) {
  spawnSync("ping", ["127.0.0.1", "-n", String(Math.max(1, n) + 1)], {
    windowsHide: true,
  });
}

function waitServiceNotRunning(name, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const q = scQuery(name);
    if (!q.exists || (!q.running && !q.stopPending)) {
      return true;
    }
    sleepSeconds(1);
  }
  const q = scQuery(name);
  return !q.exists || (!q.running && !q.stopPending);
}

function register(productCode) {
  if (!isWin) {
    console.error("[postgres-svc] Windows only");
    return 1;
  }
  if (!isPostgresDownloaded() || !isDatabaseInitialized()) {
    console.error("[postgres-svc] PostgreSQL 尚未安裝或未 initdb（請先完成精靈①）");
    return 1;
  }

  const { postgresql: name } = serviceNames(productCode);
  const existing = scQuery(name);
  if (existing.exists) {
    console.log(`[postgres-svc] 服務已存在：${name}（略過 register）`);
    ensureLocalSystemAccount(name);
    ensureAutoStart(name);
    configureServiceRecovery(name);
    return 0;
  }

  // ① 留下的手動 postmaster 不影響 register，但避免立刻 start 衝突
  stopOrphanPostmaster(productCode);

  const pgCtl = getBinPath("pg_ctl");
  // -U LocalSystem：避免預設跑在 Local Service／Network Service，導致 role "LOCAL SERVICE" 不存在
  const r = run(pgCtl, [
    "register",
    "-N",
    name,
    "-U",
    "LocalSystem",
    "-D",
    DATA_DIR,
    "-S",
    "auto",
  ]);
  if (r.status !== 0) {
    const detail = sanitizeConsoleText(`${r.stderr}\n${r.stdout}`) || `exit ${r.status}`;
    console.error(`[postgres-svc] register 失敗：${detail}`);
    return r.status || 1;
  }
  console.log(`[postgres-svc] 已登錄服務：${name}（LocalSystem, Automatic）`);
  // Display name
  run("sc.exe", ["config", name, "DisplayName=", `${productCode} PostgreSQL`]);
  ensureLocalSystemAccount(name);
  ensureAutoStart(name);
  configureServiceRecovery(name);
  return 0;
}

function ensureLocalSystemAccount(name) {
  run("sc.exe", ["config", name, "obj=", "LocalSystem"]);
}

function ensureAutoStart(name) {
  run("sc.exe", ["config", name, "start=", "auto"]);
}

/** 開機若 PG 啟動失敗，SCM 自動重試（pg_ctl 服務預設無 onfailure）。 */
function configureServiceRecovery(name) {
  const q = scQuery(name);
  if (!q.exists) {
    return;
  }
  run("sc.exe", [
    "failure",
    name,
    "reset=",
    "86400",
    "actions=",
    "restart/60000/restart/60000/restart/60000",
  ]);
}

function unregister(productCode) {
  if (!isWin) {
    return 0;
  }
  const { postgresql: name } = serviceNames(productCode);
  const existing = scQuery(name);
  if (!existing.exists) {
    console.log(`[postgres-svc] 服務不存在：${name}`);
    return 0;
  }
  if (existing.running) {
    run("sc.exe", ["stop", name]);
    // brief wait
    spawnSync("ping", ["127.0.0.1", "-n", "3"], { windowsHide: true });
  }

  const pgCtl = getBinPath("pg_ctl");
  if (isPostgresDownloaded()) {
    const r = run(pgCtl, ["unregister", "-N", name]);
    if (r.status === 0) {
      console.log(`[postgres-svc] 已解除登錄：${name}`);
      return 0;
    }
  }
  // fallback
  const d = run("sc.exe", ["delete", name]);
  console.log(
    d.status === 0
      ? `[postgres-svc] 已 sc delete：${name}`
      : `[postgres-svc] 刪除失敗：${formatScFailure("delete", d)}`,
  );
  return d.status === 0 ? 0 : 1;
}

function stopOrphanPostmaster(productCode) {
  // 精靈①會 pg_ctl start（非 SCM）；④ sc start 前須先停掉，否則同 DATA_DIR 衝突。
  // 若 SCM 服務已 RUNNING，不要對同一 DATA_DIR 下 pg_ctl stop。
  if (!isPostgresDownloaded() || !isDatabaseInitialized()) {
    return;
  }
  if (productCode) {
    const { postgresql: name } = serviceNames(productCode);
    if (scQuery(name).running) {
      return;
    }
  }
  const pgCtl = getBinPath("pg_ctl");
  const status = run(pgCtl, ["-D", DATA_DIR, "status"]);
  const text = `${status.stdout}\n${status.stderr}`;
  if (!/server is running/i.test(text)) {
    return;
  }
  console.log("[postgres-svc] 偵測到非 SCM 的 postmaster，先 pg_ctl stop…");
  run(pgCtl, ["stop", "-D", DATA_DIR, "-m", "fast"]);
  spawnSync("ping", ["127.0.0.1", "-n", "3"], { windowsHide: true });
}

function start(productCode) {
  const { postgresql: name } = serviceNames(productCode);
  const q = scQuery(name);
  if (!q.exists) {
    console.error(`[postgres-svc] 服務不存在：${name}（請先 register）`);
    return 1;
  }
  if (q.running) {
    console.log(`[postgres-svc] 已在執行：${name}`);
    return 0;
  }
  stopOrphanPostmaster(productCode);
  const r = run("sc.exe", ["start", name]);
  if (r.status !== 0 && !/already been started/i.test(r.stderr + r.stdout)) {
    console.error(`[postgres-svc] start 失敗：${formatScFailure("start", r)}`);
    return 1;
  }
  console.log(`[postgres-svc] 已啟動：${name}`);
  return 0;
}

function stop(productCode) {
  const { postgresql: name } = serviceNames(productCode);
  const q = scQuery(name);
  if (!q.exists) {
    return 0;
  }
  if (!q.running && !q.stopPending) {
    return 0;
  }

  let r = run("sc.exe", ["stop", name]);
  const out = `${r.stdout}\n${r.stderr}`;
  // 1051：Backend 等仍相依／尚未完全停止 → 等待後重試
  if (r.status !== 0 && /\b1051\b/.test(out)) {
    console.log(
      `[postgres-svc] ${name} 仍有相依服務，等待後重試停止…`,
    );
    sleepSeconds(4);
    r = run("sc.exe", ["stop", name]);
  }

  if (
    r.status !== 0 &&
    !/\b1062\b/.test(`${r.stdout}\n${r.stderr}`) &&
    !/already been stopped/i.test(`${r.stdout}\n${r.stderr}`)
  ) {
    console.log(`[postgres-svc] stop：${formatScFailure("stop", r)}`);
  }

  if (!waitServiceNotRunning(name, 90_000)) {
    console.error(`[postgres-svc] 停止逾時：${name} 仍在執行`);
    return 1;
  }

  console.log(`[postgres-svc] 已停止：${name}`);
  return 0;
}

function statusCmd(productCode) {
  const { postgresql: name } = serviceNames(productCode);
  const q = scQuery(name);
  console.log(
    JSON.stringify({
      name,
      exists: q.exists,
      running: q.running,
    }),
  );
  return 0;
}

function main() {
  let cmd;
  let product;
  try {
    ({ cmd, product } = parseArgs(process.argv));
  } catch (e) {
    console.error(e.message || e);
    console.error(
      "Usage: postgres-windows-service.js <register|unregister|start|stop|status> [--product YSOP|YSOS] [--install-root <path>]",
    );
    process.exit(1);
  }
  const map = {
    register,
    unregister,
    start,
    stop,
    status: statusCmd,
  };
  const fn = map[cmd];
  if (!fn) {
    console.error(
      "Usage: postgres-windows-service.js <register|unregister|start|stop|status> [--product YSOP|YSOS] [--install-root <path>]",
    );
    process.exit(1);
  }
  process.exit(fn(product) || 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  register,
  unregister,
  start,
  stop,
  statusCmd,
  scQuery,
  stopOrphanPostmaster,
  formatScFailure,
  sanitizeConsoleText,
  waitServiceNotRunning,
  sleepSeconds,
  ensureAutoStart,
  configureServiceRecovery,
  ensureLocalSystemAccount,
};
