#!/usr/bin/env node

/**
 * Windows 子程序執行輔助（UTF-8 日誌、彩色輸出）
 */

const { execSync } = require("child_process");

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
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

module.exports = { log, execWithUtf8OnWindows };
