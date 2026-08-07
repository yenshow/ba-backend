/**
 * 人流 ISAPI 攝影機人臉庫（FDLib）客戶端
 * 協定：ensureFaceLib → pictureUpload → faceContrast；與門禁 UserInfo 分流。
 *
 * 僅操作本平台庫（name=BA_FaceLib / customFaceLibID=BA_PC_FACELIB）。
 * 刪除人員必須帶 FDID+PID；禁止無參數 DELETE /ISAPI/Intelligent/FDLib。
 */
const crypto = require("crypto");
const FormData = require("form-data");
const db = require("../../database/db");
const deviceService = require("../devices/deviceService");
const { createIsapiClient } = require("../accessControl/isapiClient");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrors");
const logger = require("../../utils/logger").createLogger("ISAPI Camera FDLib");

const DEFAULT_LIB_NAME = "BA_FaceLib";
const DEFAULT_FACE_LIB_TYPE = "ordinary";
const DEFAULT_SIMILARITY = 50;
const CUSTOM_FACE_LIB_ID = "BA_PC_FACELIB";
const XMLNS = "http://www.isapi.org/ver20/XMLSchema";

const PATHS = {
  fdLib: "/ISAPI/Intelligent/FDLib",
  fdLibCapabilities: "/ISAPI/Intelligent/FDLib/capabilities",
  pictureUpload: "/ISAPI/Intelligent/FDLib/pictureUpload",
  fdSearch: "/ISAPI/Intelligent/FDLib/FDSearch",
  faceContrast: (channelId) =>
    `/ISAPI/Intelligent/channels/${channelId}/faceContrast`,
};

function ensureInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function parseConfig(raw) {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? { ...raw } : {};
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlDoc(rootTag, inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag} version="2.0" xmlns="${XMLNS}">\n${inner}\n</${rootTag}>`;
}

function pickTag(xml, tag) {
  if (!xml || typeof xml !== "string") return null;
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? String(m[1]).trim() : null;
}

function pickBlocks(xml, tag) {
  if (!xml || typeof xml !== "string") return [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[0]);
  return out;
}

function pickStr(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function responseToText(data) {
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function errorText(err) {
  if (err == null) return "";
  if (typeof err === "string") return err;
  return String(err?.message || err?.detail || err);
}

function isFaceLibraryIdError(errOrText) {
  return /faceLibraryIDError|faceLibraryIDNotExis/i.test(errorText(errOrText));
}

function isCustomFaceLibIdRepeat(errOrText) {
  return /customFaceLibIDRepeat/i.test(errorText(errOrText));
}

/** 僅當錯誤明確指向 customFaceLibID 欄位時，才改送不含該欄位的建庫 XML */
function isCustomFaceLibIdFieldRejected(errOrText) {
  const text = errorText(errOrText);
  return /customFaceLibID/i.test(text) && !isCustomFaceLibIdRepeat(text);
}

function assertIsapiPayloadOk(data, context = "ISAPI") {
  const text = responseToText(data);
  if (!text) return;
  if (!/<ResponseStatus[\s>]/i.test(text) && !/<statusCode>/i.test(text)) {
    return;
  }
  const codeRaw = pickTag(text, "statusCode");
  const code = codeRaw != null ? Number(codeRaw) : null;
  if (code != null && Number.isFinite(code) && code !== 1) {
    const statusString = pickTag(text, "statusString") || "";
    const subStatusCode = pickTag(text, "subStatusCode") || "";
    throw createApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      `${context} 失敗：${statusString || `statusCode=${code}`}${
        subStatusCode ? ` (${subStatusCode})` : ""
      }`,
    );
  }
}

async function requestXml(client, { method, path, xml }) {
  const res = await client.request({
    method,
    path,
    ...(xml != null ? { data: xml } : {}),
    headers: { "Content-Type": "application/xml" },
  });
  assertIsapiPayloadOk(res.data, path);
  return res;
}

async function getCameraDeviceAndClient(deviceId) {
  const { device } = await deviceService.getDeviceById(deviceId);
  if (String(device?.type_code || "") !== "camera") {
    throw createApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      "該設備不是攝影機",
    );
  }
  if (
    !device.config?.host ||
    !device.config?.username ||
    !device.config?.password
  ) {
    throw createApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      "攝影機連線設定不完整（缺少 host / username / password）",
    );
  }
  return { device, client: createIsapiClient(device.config) };
}

async function persistFdLibMeta(deviceId, meta) {
  const { device } = await deviceService.getDeviceById(deviceId);
  const config = parseConfig(device.config);
  config.fdlib = {
    ...(config.fdlib && typeof config.fdlib === "object" ? config.fdlib : {}),
    ...meta,
    customFaceLibID: meta.customFaceLibID || CUSTOM_FACE_LIB_ID,
    updatedAt: new Date().toISOString(),
  };
  await db.query(
    `UPDATE devices SET config = ?::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [JSON.stringify(config), Number(deviceId)],
  );
  return config.fdlib;
}

async function clearFdLibCache(deviceId) {
  const { device } = await deviceService.getDeviceById(deviceId);
  const config = parseConfig(device.config);
  if (!config.fdlib || typeof config.fdlib !== "object") return;
  config.fdlib = {
    ...config.fdlib,
    FDID: null,
    updatedAt: new Date().toISOString(),
  };
  await db.query(
    `UPDATE devices SET config = ?::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [JSON.stringify(config), Number(deviceId)],
  );
}

function parseFaceLibListXml(xmlText) {
  const text = responseToText(xmlText);
  const blocks = [
    ...pickBlocks(text, "FDLibBaseCfg"),
    ...pickBlocks(text, "FDLibInfo"),
  ];
  return blocks
    .map((block) => {
      const FDID = pickStr(pickTag(block, "FDID"), pickTag(block, "fdid"));
      if (!FDID) return null;
      return {
        FDID,
        name: pickTag(block, "name") || "",
        faceLibType: pickTag(block, "faceLibType") || DEFAULT_FACE_LIB_TYPE,
        customFaceLibID: pickTag(block, "customFaceLibID") || null,
      };
    })
    .filter(Boolean);
}

/** 只認本平台庫；禁止 libs[0]／任意 FDID=1 */
function findOwnLib(libs, preferredName = DEFAULT_LIB_NAME) {
  const list = Array.isArray(libs) ? libs : [];
  return (
    list.find(
      (l) => String(l.customFaceLibID || "").trim() === CUSTOM_FACE_LIB_ID,
    ) ||
    list.find((l) => String(l.name || "").trim() === preferredName) ||
    null
  );
}

function toLibMeta(lib, fallbacks = {}) {
  return {
    FDID: String(lib.FDID),
    name: String(lib.name || fallbacks.name || DEFAULT_LIB_NAME),
    faceLibType: String(
      lib.faceLibType || fallbacks.faceLibType || DEFAULT_FACE_LIB_TYPE,
    ),
    customFaceLibID: String(
      lib.customFaceLibID || fallbacks.customFaceLibID || CUSTOM_FACE_LIB_ID,
    ),
  };
}

async function listFaceLibs(deviceId) {
  const { client } = await getCameraDeviceAndClient(deviceId);
  const res = await requestXml(client, { method: "GET", path: PATHS.fdLib });
  return parseFaceLibListXml(res.data);
}

/** 解析失敗回 null（不阻斷建庫） */
async function getMaxFdLibNum(deviceId) {
  try {
    const { client } = await getCameraDeviceAndClient(deviceId);
    const res = await requestXml(client, {
      method: "GET",
      path: PATHS.fdLibCapabilities,
    });
    const text = responseToText(res.data);
    const raw = pickStr(
      pickTag(text, "maxFDLibNum"),
      pickTag(text, "maxFaceLibNum"),
    );
    const n = raw != null ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    logger.warn("讀取 FDLib capabilities 失敗（略過）", {
      deviceId,
      error: err?.message || String(err),
    });
    return null;
  }
}

function buildCreateFdLibListXml({ name, includeCustomFaceLibId }) {
  const customLine = includeCustomFaceLibId
    ? `\n    <customFaceLibID>${escapeXml(CUSTOM_FACE_LIB_ID)}</customFaceLibID>`
    : "";
  return xmlDoc(
    "CreateFDLibList",
    `  <CreateFDLib>
    <id>1</id>
    <name>${escapeXml(name)}</name>
    <thresholdValue>${DEFAULT_SIMILARITY}</thresholdValue>
    <faceLibType>${escapeXml(DEFAULT_FACE_LIB_TYPE)}</faceLibType>${customLine}
  </CreateFDLib>`,
  );
}

async function resolveCreatedLibMeta(deviceId, { name, res }) {
  const FDID = pickStr(
    pickTag(responseToText(res?.data), "FDID"),
    pickTag(responseToText(res?.data), "fdid"),
  );
  if (FDID) {
    return {
      FDID: String(FDID),
      name,
      faceLibType: DEFAULT_FACE_LIB_TYPE,
      customFaceLibID: CUSTOM_FACE_LIB_ID,
    };
  }
  const hit = findOwnLib(await listFaceLibs(deviceId), name);
  if (hit?.FDID) return toLibMeta(hit, { name });
  throw createApiError(
    C.PEOPLE_COUNTING_VALIDATION_FAILED,
    "設備建庫成功但未回傳 FDID",
  );
}

async function createFaceLib(deviceId, options = {}) {
  const { client } = await getCameraDeviceAndClient(deviceId);
  const name = String(options.name || DEFAULT_LIB_NAME).slice(0, 32);

  const postCreate = (includeCustomFaceLibId) =>
    requestXml(client, {
      method: "POST",
      path: PATHS.fdLib,
      xml: buildCreateFdLibListXml({ name, includeCustomFaceLibId }),
    });

  let res;
  try {
    res = await postCreate(true);
  } catch (err) {
    if (isCustomFaceLibIdRepeat(err)) {
      const hit = findOwnLib(await listFaceLibs(deviceId), name);
      if (hit?.FDID) return toLibMeta(hit, { name });
      throw createApiError(
        C.PEOPLE_COUNTING_VALIDATION_FAILED,
        "customFaceLibID 重複但找不到既有本平台人臉庫",
      );
    }
    if (!isCustomFaceLibIdFieldRejected(err)) throw err;
    logger.warn("CreateFDLib 拒收 customFaceLibID，改送不含該欄位", {
      deviceId,
      error: err?.message || String(err),
    });
    res = await postCreate(false);
  }

  return resolveCreatedLibMeta(deviceId, { name, res });
}

/**
 * 確保本平台人臉庫存在；驗證 cache FDID，失效則重選／建庫。
 */
async function ensureFaceLib(deviceId, options = {}) {
  const preferredName = options.name || DEFAULT_LIB_NAME;
  const forceRefresh = Boolean(options.forceRefresh);

  const { device } = await getCameraDeviceAndClient(deviceId);
  const cached = parseConfig(device.config).fdlib;
  const cachedObj = cached && typeof cached === "object" ? cached : null;

  let libs = [];
  try {
    libs = await listFaceLibs(deviceId);
  } catch (err) {
    logger.warn("列出人臉庫失敗", {
      deviceId,
      error: err?.message || String(err),
    });
    throw createApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      `無法列出設備人臉庫：${err?.message || String(err)}`,
    );
  }

  if (forceRefresh && cachedObj?.FDID) {
    await clearFdLibCache(deviceId);
  } else if (!forceRefresh && cachedObj?.FDID) {
    const stillThere = libs.find(
      (l) => String(l.FDID) === String(cachedObj.FDID),
    );
    if (stillThere) {
      return toLibMeta(stillThere, {
        name: cachedObj.name || preferredName,
        faceLibType: cachedObj.faceLibType || DEFAULT_FACE_LIB_TYPE,
        customFaceLibID: cachedObj.customFaceLibID || CUSTOM_FACE_LIB_ID,
      });
    }
    logger.warn("快取 FDID 在設備上不存在，清除後重選／建庫", {
      deviceId,
      cachedFDID: cachedObj.FDID,
    });
    await clearFdLibCache(deviceId);
  }

  const existing = findOwnLib(libs, preferredName);
  if (existing) {
    const meta = toLibMeta(existing, { name: preferredName });
    await persistFdLibMeta(deviceId, meta);
    return meta;
  }

  const maxLibNum = await getMaxFdLibNum(deviceId);
  if (maxLibNum != null && libs.length >= maxLibNum) {
    throw createApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      `設備人臉庫數量已達上限（${maxLibNum}），且找不到本平台庫（${preferredName}／${CUSTOM_FACE_LIB_ID}），請先於設備釋放庫位`,
    );
  }

  const created = await createFaceLib(deviceId, { name: preferredName });
  await persistFdLibMeta(deviceId, created);
  return created;
}

function buildPictureUploadDataXml({ FDID, name, employeeNo }) {
  const safeName = String(name || employeeNo || "").trim().slice(0, 32);
  return xmlDoc(
    "PictureUploadData",
    `  <FDID>${escapeXml(FDID)}</FDID>
  <FaceAppendData>
    <name>${escapeXml(safeName)}</name>
    <customHumanID>${escapeXml(String(employeeNo || "").trim())}</customHumanID>
  </FaceAppendData>`,
  );
}

async function pictureUploadOnce(deviceId, params, lib) {
  const { client } = await getCameraDeviceAndClient(deviceId);
  const employeeNo = String(params.employeeNo || "").trim();
  const name = String(params.name || employeeNo).trim();

  const form = new FormData();
  form.append(
    "PictureUploadData",
    buildPictureUploadDataXml({ FDID: lib.FDID, name, employeeNo }),
    { contentType: "application/xml" },
  );
  form.append("importImage", params.imageBuffer, {
    filename: "face.jpg",
    contentType: "image/jpeg",
  });

  const res = await client.request({
    method: "POST",
    path: PATHS.pictureUpload,
    data: form,
    headers: form.getHeaders(),
  });
  assertIsapiPayloadOk(res.data, PATHS.pictureUpload);

  const text = responseToText(res.data);
  return {
    success: true,
    FDID: String(lib.FDID),
    PID: pickStr(pickTag(text, "PID"), pickTag(text, "pid")),
    raw: text || res.data,
  };
}

/**
 * 上傳人員＋人臉圖。遇 faceLibraryIDError 時 forceRefresh 後重試一次。
 */
async function pictureUpload(deviceId, params) {
  const employeeNo = String(params.employeeNo || "").trim();
  const imageBuffer = params.imageBuffer;
  if (!employeeNo) {
    throw createApiError(C.PEOPLE_COUNTING_VALIDATION_FAILED, "缺少工號");
  }
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw createApiError(C.PEOPLE_COUNTING_VALIDATION_FAILED, "缺少人臉圖片");
  }
  if (imageBuffer.length < 1024 || imageBuffer.length > 300 * 1024) {
    logger.warn("人臉圖片大小可能超出設備能力（建議 1KB～300KB）", {
      deviceId,
      employeeNo,
      bytes: imageBuffer.length,
    });
  }

  // sync job 已 ensureFaceLib；仍允許帶 FDID。失效時走重試。
  let lib =
    params.FDID != null
      ? {
          FDID: String(params.FDID),
          faceLibType: params.faceLibType || DEFAULT_FACE_LIB_TYPE,
          name: DEFAULT_LIB_NAME,
          customFaceLibID: CUSTOM_FACE_LIB_ID,
        }
      : await ensureFaceLib(deviceId);

  try {
    return await pictureUploadOnce(deviceId, params, lib);
  } catch (err) {
    if (!isFaceLibraryIdError(err)) throw err;
    logger.warn("pictureUpload faceLibraryIDError，forceRefresh 後重試一次", {
      deviceId,
      employeeNo,
      staleFDID: lib.FDID,
      error: err?.message || String(err),
    });
    lib = await ensureFaceLib(deviceId, { forceRefresh: true });
    return pictureUploadOnce(deviceId, params, lib);
  }
}

async function searchByCustomHumanId(deviceId, employeeNo, libMeta = null) {
  const { client } = await getCameraDeviceAndClient(deviceId);
  const lib = libMeta || (await ensureFaceLib(deviceId));
  const searchID = `S${crypto.randomBytes(6).toString("hex")}`;
  const xml = xmlDoc(
    "FDSearchDescription",
    `  <searchID>${escapeXml(searchID)}</searchID>
  <searchResultPosition>1</searchResultPosition>
  <maxResults>30</maxResults>
  <FDID>${escapeXml(String(lib.FDID))}</FDID>
  <customHumanID>${escapeXml(String(employeeNo))}</customHumanID>`,
  );

  try {
    const res = await requestXml(client, {
      method: "POST",
      path: PATHS.fdSearch,
      xml,
    });
    const text = responseToText(res.data);
    return [...pickBlocks(text, "MatchElement"), ...pickBlocks(text, "element")]
      .map((block) => {
        const PID = pickStr(
          pickTag(block, "PID"),
          pickTag(block, "pid"),
          pickTag(block, "FPID"),
        );
        return PID
          ? { PID, customHumanID: pickTag(block, "customHumanID"), raw: block }
          : null;
      })
      .filter(Boolean);
  } catch (err) {
    logger.warn("FDSearch 失敗", {
      deviceId,
      employeeNo,
      error: err?.message || String(err),
    });
    return [];
  }
}

/** 依工號搜尋 PID 後刪除；僅 PUT FDDeleteData byPID（必須帶 FDID） */
async function deleteByCustomHumanId(deviceId, employeeNo, libMeta = null) {
  const lib = libMeta || (await ensureFaceLib(deviceId));
  const fdid = String(lib.FDID || "").trim();
  if (!fdid) {
    throw createApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      "缺少 FDID，拒絕刪除以免清空人臉庫",
    );
  }

  const matches = await searchByCustomHumanId(deviceId, employeeNo, lib);
  if (!matches.length) return { success: true, deleted: 0 };

  const { client } = await getCameraDeviceAndClient(deviceId);
  let deleted = 0;
  for (const m of matches) {
    const deleteXml = xmlDoc(
      "FDDeleteData",
      `  <FDID>${escapeXml(fdid)}</FDID>
  <deleteMode>byPID</deleteMode>
  <PID>${escapeXml(String(m.PID))}</PID>`,
    );
    await requestXml(client, {
      method: "PUT",
      path: PATHS.fdLib,
      xml: deleteXml,
    });
    deleted += 1;
  }
  return { success: true, deleted };
}

async function ensureFaceContrast(deviceId, options = {}) {
  const channelId = ensureInt(options.channelId) || 1;
  const lib = options.FDID
    ? {
        FDID: String(options.FDID),
        faceLibType: options.faceLibType || DEFAULT_FACE_LIB_TYPE,
      }
    : await ensureFaceLib(deviceId);
  const thresholdRaw =
    options.similarityThreshold != null
      ? Number(options.similarityThreshold)
      : DEFAULT_SIMILARITY;
  const threshold = Math.min(
    100,
    Math.max(
      0,
      Math.trunc(Number.isFinite(thresholdRaw) ? thresholdRaw : DEFAULT_SIMILARITY),
    ),
  );
  const fdid = String(lib.FDID);
  const { client } = await getCameraDeviceAndClient(deviceId);

  await requestXml(client, {
    method: "PUT",
    path: PATHS.faceContrast(channelId),
    xml: xmlDoc(
      "FaceContrastList",
      `  <FaceContrast>
    <id>1</id>
    <enable>true</enable>
    <faceContrastType>faceContrast</faceContrastType>
    <thresholdValue>${escapeXml(threshold)}</thresholdValue>
    <FDLibList>
      <FDLib>
        <id>1</id>
        <FDID>${escapeXml(fdid)}</FDID>
        <thresholdValue>${escapeXml(threshold)}</thresholdValue>
      </FDLib>
    </FDLibList>
    <faceSnapDataUpload>true</faceSnapDataUpload>
  </FaceContrast>`,
    ),
  });

  await persistFdLibMeta(deviceId, {
    FDID: fdid,
    faceLibType: lib.faceLibType || DEFAULT_FACE_LIB_TYPE,
    customFaceLibID: CUSTOM_FACE_LIB_ID,
    faceContrastChannelId: channelId,
    similarityThreshold: threshold,
  });

  return { success: true, FDID: fdid, channelId };
}

module.exports = {
  ensureFaceLib,
  pictureUpload,
  deleteByCustomHumanId,
  ensureFaceContrast,
};
