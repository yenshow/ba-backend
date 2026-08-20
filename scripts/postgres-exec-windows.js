/**
 * Windows 子程序執行輔助（UTF-8 日誌、執行期資料目錄 ACL）
 */

const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

const WIN_ACL_BUILTIN = {
  administrators: "*S-1-5-32-544",
  system: "*S-1-5-18",
  localService: "*S-1-5-19",
};

function log(message, color = "reset") {
  if (process.stdout.isTTY) {
    console.log(`${colors[color]}${message}${colors.reset}`);
  } else {
    console.log(message);
  }
}

function execWithUtf8OnWindows(innerCommand, options) {
  const wrapped = `cmd.exe /d /s /c "chcp 65001>nul & ${innerCommand}"`;
  return execSync(wrapped, { ...options, shell: true });
}

function quoteCmdPath(dirPath) {
  return `"${dirPath.replace(/"/g, "")}"`;
}

function runWindowsAclStep(innerCommand, label) {
  try {
    execWithUtf8OnWindows(innerCommand, { stdio: "pipe", encoding: "utf8" });
  } catch (error) {
    const detail = (error.stderr || error.stdout || error.message || "")
      .toString()
      .trim();
    throw new Error(
      `無法設定執行期資料目錄權限（需以系統管理員執行安裝精靈）: ${label}` +
        (detail ? `\n${detail}` : ""),
    );
  }
}

/**
 * initdb 前：設定目錄 ACL（空目錄，不含 /T）。
 * 順序：takeown → 先授 Administrators → 再切斷繼承 → 其餘主體
 * （先 /inheritance:r 在既有鎖定 DACL 上常會 Access is denied）
 */
function prepareWindowsDirAcl(dirPath) {
  if (process.platform !== "win32" || !dirPath) {
    return;
  }

  fs.mkdirSync(dirPath, { recursive: true });
  const quoted = quoteCmdPath(dirPath);
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME;
  const userPrincipal =
    domain && user ? `${domain}\\${user}` : user || null;

  log(`🔐 設定執行期資料目錄權限: ${dirPath}`, "yellow");

  // /A：Administrators 取得擁有權；/R /D Y：子項亦接管（空目錄亦安全）
  runWindowsAclStep(`takeown /F ${quoted} /A /R /D Y`, "takeown /A");
  runWindowsAclStep(
    `icacls ${quoted} /grant:r ${WIN_ACL_BUILTIN.administrators}:(OI)(CI)F`,
    "icacls Administrators (pre)",
  );
  runWindowsAclStep(`icacls ${quoted} /inheritance:r`, "icacls /inheritance:r");
  runWindowsAclStep(
    `icacls ${quoted} /grant:r ${WIN_ACL_BUILTIN.administrators}:(OI)(CI)F`,
    "icacls Administrators",
  );
  runWindowsAclStep(
    `icacls ${quoted} /grant:r ${WIN_ACL_BUILTIN.system}:(OI)(CI)F`,
    "icacls SYSTEM",
  );
  runWindowsAclStep(
    `icacls ${quoted} /grant:r ${WIN_ACL_BUILTIN.localService}:(OI)(CI)M`,
    "icacls LocalService",
  );

  if (userPrincipal) {
    runWindowsAclStep(
      `icacls ${quoted} /grant:r "${userPrincipal}:(OI)(CI)F"`,
      `icacls ${userPrincipal}`,
    );
  }
}

/** 套用至目錄與既有子檔（服務帳號 LocalSystem／LocalService 須能讀取 PG_VERSION 等）。 */
function applyWindowsDirAclRecursive(dirPath) {
  if (process.platform !== "win32" || !dirPath || !fs.existsSync(dirPath)) {
    return;
  }

  prepareWindowsDirAcl(dirPath);
  const quoted = quoteCmdPath(dirPath);
  runWindowsAclStep(
    `icacls ${quoted} /grant ${WIN_ACL_BUILTIN.localService}:(OI)(CI)M /T`,
    "icacls LocalService /T",
  );
  runWindowsAclStep(
    `icacls ${quoted} /grant ${WIN_ACL_BUILTIN.system}:(OI)(CI)F /T`,
    "icacls SYSTEM /T",
  );
}

function prepareWindowsPostgresDataLayout({ dataDir, logDir }) {
  if (process.platform !== "win32") {
    return;
  }
  applyWindowsDirAclRecursive(dataDir);
  if (logDir && logDir !== dataDir) {
    applyWindowsDirAclRecursive(logDir);
  }
}

/** 確保本機 trust 規則置頂（避免 Windows SSPI 把服務帳號當 PG 角色，如 LOCAL SERVICE）。 */
function ensurePgHbaTrustRules(pgHbaConfPath) {
  if (!pgHbaConfPath || !fs.existsSync(pgHbaConfPath)) {
    return;
  }

  const beginMarker = "# BA_SYSTEM_MANAGED_BEGIN";
  const endMarker = "# BA_SYSTEM_MANAGED_END";
  const managedBlock = [
    beginMarker,
    "local all all trust",
    "host all all 127.0.0.1/32 trust",
    "host all all ::1/128 trust",
    endMarker,
    "",
  ].join("\n");

  const original = fs.readFileSync(pgHbaConfPath, "utf8");
  let content = original.replace(/\r\n/g, "\n");

  const blockRegex = new RegExp(
    `${beginMarker}[\\s\\S]*?${endMarker}\\n?`,
    "g",
  );
  content = content.replace(blockRegex, "");

  const lines = content.split("\n");
  let insertAt = 0;
  while (insertAt < lines.length) {
    const line = lines[insertAt].trim();
    if (line === "" || line.startsWith("#")) {
      insertAt += 1;
      continue;
    }
    break;
  }

  lines.splice(insertAt, 0, managedBlock.trimEnd());
  const next = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  if (next !== content) {
    fs.writeFileSync(pgHbaConfPath, next.replace(/\n/g, os.EOL), "utf8");
  }
}

module.exports = {
  log,
  execWithUtf8OnWindows,
  prepareWindowsDirAcl,
  prepareWindowsPostgresDataLayout,
  ensurePgHbaTrustRules,
};
