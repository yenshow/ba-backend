#!/usr/bin/env node

/**
 * Windows 子程序執行輔助（UTF-8 日誌、執行期資料目錄 ACL）
 */

const fs = require("fs");
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

/** initdb 在 Windows 須設定資料目錄 ACL（含 PM2 LocalService）。 */
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

function prepareWindowsPostgresDataLayout({ dataDir, logDir }) {
  if (process.platform !== "win32") {
    return;
  }
  prepareWindowsDirAcl(dataDir);
  if (logDir && logDir !== dataDir) {
    prepareWindowsDirAcl(logDir);
  }
}

module.exports = {
  log,
  execWithUtf8OnWindows,
  prepareWindowsDirAcl,
  prepareWindowsPostgresDataLayout,
};
