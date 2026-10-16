/**
 * Windows 服務命名（YSOP／YSOS 並存）— 出貨 SCM 路徑 SSOT。
 * 解析順序：services/manifest.json → 安裝根資料夾名；皆無則拋錯（不再默認 YSOP）。
 */

const fs = require("fs");
const path = require("path");

const PRODUCT_CODES = ["YSOP", "YSOS"];

function normalizeProductCode(raw) {
  const upper = String(raw || "")
    .trim()
    .toUpperCase();
  return PRODUCT_CODES.includes(upper) ? upper : null;
}

function readManifestProductCode(installRoot) {
  const manifestPath = path.join(
    String(installRoot || ""),
    "services",
    "manifest.json",
  );
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return normalizeProductCode(m.productCode);
  } catch {
    return null;
  }
}

function readFolderProductCode(installRoot) {
  const folder = path.basename(
    String(installRoot || "").replace(/[\\/]+$/, ""),
  );
  return normalizeProductCode(folder);
}

/**
 * @param {string} installRoot
 * @param {{ product?: string }} [opts] — 顯式覆寫（打包 --product）
 * @returns {string} YSOP|YSOS
 */
function resolveProductCode(installRoot, opts = {}) {
  const fromOpt = normalizeProductCode(opts.product);
  if (fromOpt) {
    return fromOpt;
  }
  const fromManifest = readManifestProductCode(installRoot);
  if (fromManifest) {
    return fromManifest;
  }
  const fromFolder = readFolderProductCode(installRoot);
  if (fromFolder) {
    return fromFolder;
  }
  throw new Error(
    `無法解析產品碼（YSOP／YSOS）。請確認安裝目錄名為 YSOP 或 YSOS，或 services/manifest.json 含 productCode。installRoot=${installRoot}`,
  );
}

function tryResolveProductCode(installRoot, opts = {}) {
  try {
    return resolveProductCode(installRoot, opts);
  } catch {
    return null;
  }
}

function serviceNames(productCode) {
  const p = normalizeProductCode(productCode);
  if (!p) {
    throw new Error(`無效產品碼：${productCode}`);
  }
  return {
    productCode: p,
    postgresql: `${p}-PostgreSQL`,
    backend: `${p}-Backend`,
    frontend: `${p}-Frontend`,
    mediamtx: `${p}-MediaMTX`,
  };
}

function allServiceNames(productCode) {
  const n = serviceNames(productCode);
  return [n.postgresql, n.backend, n.frontend, n.mediamtx];
}

module.exports = {
  PRODUCT_CODES,
  resolveProductCode,
  tryResolveProductCode,
  normalizeProductCode,
  serviceNames,
  allServiceNames,
};
