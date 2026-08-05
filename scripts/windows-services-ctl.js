#!/usr/bin/env node
/**
 * 安裝／啟動／停止／移除本產品 Windows 服務（WinSW + PostgreSQL）。
 *
 * Usage:
 *   node windows-services-ctl.js <install|start|stop|restart|uninstall|status> --target <installRoot>
 *
 * install：產生 XML、複製 WinSW exe、pg_ctl register、winsw install
 * start／stop／restart：依序操作
 * uninstall：stop + winsw uninstall + pg_ctl unregister
 * status：JSON 列表
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  resolveProductCode,
  serviceNames,
} = require("./windows-product-services");
const pgSvc = require("./postgres-windows-service");

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
  const out = { cmd: (argv[2] || "").toLowerCase(), target: null };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--target" && argv[i + 1]) {
      out.target = path.resolve(argv[++i]);
    }
  }
  return out;
}

function findWinswTemplate(installRoot) {
  const candidates = [
    path.join(installRoot, "tools", "winsw", "WinSW-x64.exe"),
    path.join(installRoot, "tools", "winsw", "winsw.exe"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function ensureGenerated(installRoot, nodeExe) {
  const staged = path.join(installRoot, "tools", "generate-windows-services.cjs");
  const repoGen = path.join(
    __dirname,
    "..",
    "..",
    "scripts",
    "generate-windows-services.cjs",
  );
  const use = fs.existsSync(staged) ? staged : repoGen;
  if (!fs.existsSync(use)) {
    throw new Error("找不到 generate-windows-services.cjs");
  }
  const product = resolveProductCode(installRoot);
  const r = run(nodeExe, [use, "--target", installRoot, "--product", product]);
  if (r.status !== 0) {
    const detail = pgSvc.sanitizeConsoleText(`${r.stderr}\n${r.stdout}`) || `exit ${r.status}`;
    console.error(`[services] generate-windows-services 失敗：${detail}`);
    throw new Error("generate-windows-services failed");
  }
}

function winswServiceIds(installRoot) {
  const servicesDir = path.join(installRoot, "services");
  const manifestPath = path.join(servicesDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return m.winswServices || [];
  }
  return fs
    .readdirSync(servicesDir)
    .filter((f) => f.endsWith(".xml"))
    .map((f) => path.basename(f, ".xml"));
}

function scQuery(name) {
  return pgSvc.scQuery(name);
}

function copyWinswExes(installRoot, ids) {
  const template = findWinswTemplate(installRoot);
  if (!template) {
    throw new Error(
      "找不到 tools/winsw/WinSW-x64.exe（請重新打包或放置 WinSW）",
    );
  }
  const servicesDir = path.join(installRoot, "services");
  for (const id of ids) {
    const dest = path.join(servicesDir, `${id}.exe`);
    fs.copyFileSync(template, dest);
  }
}

function winswInstall(installRoot, id) {
  const exe = path.join(installRoot, "services", `${id}.exe`);
  const r = run(exe, ["install"]);
  // 已安裝時 WinSW 可能非 0 — 檢查服務是否存在
  const q = scQuery(id);
  if (!q.exists) {
    const detail =
      pgSvc.sanitizeConsoleText(`${r.stderr}\n${r.stdout}`) || `exit ${r.status}`;
    console.error(`[services] install ${id} 失敗（服務未出現於 SCM）：${detail}`);
    return false;
  }
  // LocalSystem + auto（WinSW XML 已設；再保險）
  run("sc.exe", ["config", id, "obj=", "LocalSystem"]);
  run("sc.exe", ["config", id, "start=", "auto"]);
  console.log(`[services] installed ${id}`);
  return true;
}

function winswUninstall(installRoot, id) {
  const exe = path.join(installRoot, "services", `${id}.exe`);
  if (fs.existsSync(exe)) {
    run(exe, ["stop"]);
    run(exe, ["uninstall"]);
  }
  const q = scQuery(id);
  if (q.exists) {
    run("sc.exe", ["stop", id]);
    run("sc.exe", ["delete", id]);
  }
  console.log(`[services] uninstalled ${id}`);
  return true;
}

function startOne(name) {
  const q = scQuery(name);
  if (!q.exists) {
    console.error(`[services] missing ${name}`);
    return false;
  }
  if (q.running) return true;
  const r = run("sc.exe", ["start", name]);
  if (r.status !== 0 && !/already been started/i.test(r.stdout + r.stderr)) {
    console.error(`[services] start ${name}: ${pgSvc.formatScFailure("start", r)}`);
    return false;
  }
  return true;
}

function stopOne(name) {
  const q = scQuery(name);
  if (!q.exists || (!q.running && !q.stopPending)) return true;
  const r = run("sc.exe", ["stop", name]);
  if (
    r.status !== 0 &&
    !/\b1062\b/.test(`${r.stdout}\n${r.stderr}`) &&
    !/already been stopped/i.test(`${r.stdout}\n${r.stderr}`)
  ) {
    console.log(`[services] stop ${name}：${pgSvc.formatScFailure("stop", r)}`);
  }
  if (!pgSvc.waitServiceNotRunning(name, 90_000)) {
    console.error(`[services] stop ${name} 逾時（仍在執行）`);
    return false;
  }
  return true;
}

/** 先停相依端（MediaMTX → Frontend → Backend），再停 PostgreSQL。 */
function orderedWinswStopIds(installRoot) {
  const names = serviceNames(resolveProductCode(installRoot));
  const ids = winswServiceIds(installRoot);
  const prefer = [names.mediamtx, names.frontend, names.backend];
  const ordered = prefer.filter((id) => ids.includes(id));
  for (const id of ids) {
    if (!ordered.includes(id)) {
      ordered.push(id);
    }
  }
  return ordered;
}

function waitServiceRunning(name, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (scQuery(name).running) return true;
    spawnSync("ping", ["127.0.0.1", "-n", "2"], { windowsHide: true });
  }
  return scQuery(name).running;
}

function resolveNode(installRoot) {
  const p = path.join(installRoot, "tools", "nodejs", "node.exe");
  if (!fs.existsSync(p)) {
    throw new Error(`找不到 ${p}`);
  }
  return p;
}

function cmdInstall(installRoot) {
  const product = resolveProductCode(installRoot);
  const names = serviceNames(product);
  const nodeExe = resolveNode(installRoot);

  ensureGenerated(installRoot, nodeExe);
  const ids = winswServiceIds(installRoot);
  copyWinswExes(installRoot, ids);

  if (pgSvc.register(product) !== 0) {
    return 1;
  }

  for (const id of ids) {
    if (!winswInstall(installRoot, id)) {
      return 1;
    }
  }

  // Backend depend already in XML; reinforce
  if (ids.includes(names.backend)) {
    run("sc.exe", [
      "config",
      names.backend,
      "depend=",
      names.postgresql,
    ]);
  }

  console.log(`[services] install OK for ${product}`);
  return 0;
}

function cmdStart(installRoot) {
  const product = resolveProductCode(installRoot);
  const names = serviceNames(product);
  if (pgSvc.start(product) !== 0) return 1;
  if (!waitServiceRunning(names.postgresql, 90_000)) {
    console.error(`[services] PostgreSQL 未進入 RUNNING`);
    return 1;
  }
  const ids = winswServiceIds(installRoot);
  // backend first if present
  const ordered = [
    ...ids.filter((id) => id === names.backend),
    ...ids.filter((id) => id !== names.backend),
  ];
  for (const id of ordered) {
    if (!startOne(id)) return 1;
  }
  console.log(`[services] start OK`);
  return 0;
}

function cmdStop(installRoot) {
  const product = resolveProductCode(installRoot);
  for (const id of orderedWinswStopIds(installRoot)) {
    if (!stopOne(id)) {
      return 1;
    }
  }
  // Backend depend=PostgreSQL：確保相依端已停後再停 PG
  pgSvc.sleepSeconds(2);
  if (pgSvc.stop(product) !== 0) {
    return 1;
  }
  console.log(`[services] stop OK (${product})`);
  return 0;
}

function cmdRestart(installRoot) {
  // 重產 WinSW XML（套用 .env 埠等）後再重啟
  const nodeExe = resolveNode(installRoot);
  if (cmdStop(installRoot) !== 0) {
    console.error(`[services] restart：停止階段失敗`);
    return 1;
  }
  pgSvc.sleepSeconds(2);
  ensureGenerated(installRoot, nodeExe);
  const ids = winswServiceIds(installRoot);
  copyWinswExes(installRoot, ids);
  return cmdStart(installRoot);
}

function cmdUninstall(installRoot) {
  const product = resolveProductCode(installRoot);
  const ids = winswServiceIds(installRoot);
  for (const id of [...ids].reverse()) {
    winswUninstall(installRoot, id);
  }
  pgSvc.unregister(product);
  console.log(`[services] uninstall OK`);
  return 0;
}

function cmdStatus(installRoot) {
  const product = resolveProductCode(installRoot);
  const names = serviceNames(product);
  const rows = [];
  const pg = scQuery(names.postgresql);
  rows.push({
    id: names.postgresql,
    kind: "postgresql",
    exists: pg.exists,
    running: pg.running,
  });
  for (const id of winswServiceIds(installRoot)) {
    const q = scQuery(id);
    rows.push({
      id,
      kind: "winsw",
      exists: q.exists,
      running: q.running,
    });
  }
  console.log(JSON.stringify({ productCode: product, services: rows }, null, 2));
  return 0;
}

function main() {
  if (process.platform !== "win32") {
    console.error("Windows only");
    process.exit(1);
  }
  const { cmd, target } = parseArgs(process.argv);
  if (!target || !cmd) {
    console.error(
      "Usage: windows-services-ctl.js <install|start|stop|restart|uninstall|status> --target <installRoot>",
    );
    process.exit(1);
  }
  if (!fs.existsSync(target)) {
    console.error(`target not found: ${target}`);
    process.exit(1);
  }

  const map = {
    install: cmdInstall,
    start: cmdStart,
    stop: cmdStop,
    restart: cmdRestart,
    uninstall: cmdUninstall,
    status: cmdStatus,
  };
  const fn = map[cmd];
  if (!fn) {
    console.error(`unknown cmd: ${cmd}`);
    process.exit(1);
  }
  try {
    process.exit(fn(target) || 0);
  } catch (e) {
    console.error(`[services] ${e.message || e}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  cmdInstall,
  cmdStart,
  cmdStop,
  cmdRestart,
  cmdUninstall,
  cmdStatus,
  scQuery,
};
