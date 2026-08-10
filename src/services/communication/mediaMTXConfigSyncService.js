/**
 * MediaMTX 設定同步（SSOT = devices(camera)）
 *
 * 目標：
 * - 觀看時不做 /v3/config/paths/add|delete（避免「每次開畫面都 reload」造成 WebRTC 不穩）
 * - 新增/更新/刪除攝影機時，自動同步：
 *   1) 產生 mediamtx.generated.yml（供下次啟動）
 *   2) 立即透過 Control API 更新單一路徑（只在 CRUD 時發生，頻率低）
 */
const path = require("path");
const fs = require("fs");
const db = require("../../database/db");
const mediaMTXService = require("./mediaMTXService");
const logger = require("../../utils/logger").createLogger("MediaMTX Sync");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const {
  getMediamtxDir,
  getMediamtxGeneratedConfigPath,
} = require("../../utils/baDataPaths");

const mediamtxDir = getMediamtxDir();
const baseConfigPath = path.join(mediamtxDir, "mediamtx.yml");
const generatedConfigPath = getMediamtxGeneratedConfigPath();

const toRtspUrl = (config) => {
  if (!config) return "";
  const raw = typeof config === "string" ? config : config.rtsp_url;
  const v = String(raw || "").replace(/\r?\n/g, "").trim();
  return v.toLowerCase().startsWith("rtsp://") ? v : "";
};

const yamlQuote = (v) => {
  const s = String(v ?? "");
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
};

const buildPathsYaml = (items) => {
  const lines = ["paths:"];
  for (const it of items) {
    // sourceOnDemand / rtspTransport 由 base pathDefaults 繼承，勿在此重複
    lines.push(`  ${it.pathName}:`);
    lines.push(`    source: ${yamlQuote(it.rtspUrl)}`);
  }
  if (items.length === 0) lines.push("  {}");
  return lines.join("\n");
};

const replacePathsBlock = (baseText, pathsYaml) => {
  const t = String(baseText || "");
  const replacedInline = t.replace(/^\s*paths:\s*\{\s*\}\s*$/m, pathsYaml);
  if (replacedInline !== t) return replacedInline;

  const idx = t.search(/^\s*paths:\s*$/m);
  if (idx >= 0) {
    const before = t.slice(0, idx).replace(/\s*$/, "");
    return `${before}\n\n${pathsYaml}\n`;
  }
  return `${t.replace(/\s*$/, "")}\n\n${pathsYaml}\n`;
};

const listCameraRtspItems = async () => {
  const rows = await db.query(
    `
    SELECT d.id, d.config
    FROM devices d
    WHERE LOWER(COALESCE(d.type_code, '')) = 'camera'
    ORDER BY d.id ASC
    `,
    []
  );

  const items = (rows || [])
    .map((r) => {
      let cfg = r.config;
      if (typeof cfg === "string") {
        try {
          cfg = JSON.parse(cfg);
        } catch {
          cfg = null;
        }
      }
      const rtspUrl = toRtspUrl(cfg);
      const deviceId = Number(r.id);
      return {
        deviceId,
        pathName: mediaMTXService.pathNameFromDeviceId(deviceId),
        rtspUrl,
      };
    })
    .filter((x) => Number.isFinite(x.deviceId) && x.deviceId > 0 && Boolean(x.rtspUrl));

  return items;
};

async function generateConfigFile() {
  if (!fs.existsSync(baseConfigPath)) {
    throwApiError(C.MEDIAMTX_CONFIG_NOT_FOUND, `找不到 base config: ${baseConfigPath}`);
  }

  const baseText = fs.readFileSync(baseConfigPath, "utf8");
  const items = await listCameraRtspItems();
  const pathsYaml = buildPathsYaml(items);
  const nextText = replacePathsBlock(baseText, pathsYaml);
  fs.writeFileSync(generatedConfigPath, nextText, "utf8");
  logger.info("已產生 mediamtx.generated.yml", { paths: items.length });
  return { pathsCount: items.length, generatedConfigPath };
}

async function syncSingleCameraPath(deviceId, rtspUrl) {
  const id = Number(deviceId);
  const url = String(rtspUrl || "").trim();
  if (!Number.isFinite(id) || id <= 0) return;
  if (!url || !url.toLowerCase().startsWith("rtsp://")) return;
  const pathName = mediaMTXService.pathNameFromDeviceId(id);
  await mediaMTXService.addPath(pathName, url);
}

module.exports = {
  generateConfigFile,
  syncSingleCameraPath,
};

