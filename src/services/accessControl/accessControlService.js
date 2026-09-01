/**
 * 門禁設備 ISAPI 服務層
 * 依設備與型號 config 組裝請求並呼叫 ISAPI。
 */
const deviceService = require("../devices/deviceService");
const { createIsapiClient } = require("./isapiClient");
const FormData = require("form-data");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrors");
const operationalEventService = require("../operationalEvents/operationalEventService");
const {
  summaryAccessDoorControlWrite,
} = require("../operationalEvents/operationalEventCopy");
const {
  loadPlaceContextByAccessDeviceId,
} = require("../operationalEvents/operationalEventPlaceContext");
const {
  emitAccessControlEventFromPlaceContext,
} = require("../peopleCounting/accessEventCameraResolver");

const ISAPI_PATHS = {
  userInfoSearch: "/ISAPI/AccessControl/UserInfo/Search?format=json",
  userInfoSetUp: "/ISAPI/AccessControl/UserInfo/SetUp?format=json",
  userInfoDetailDelete:
    "/ISAPI/AccessControl/UserInfoDetail/Delete?format=json",
  fdSetUp: "/ISAPI/Intelligent/FDLib/FDSetUp?format=json",
  captureFaceData: "/ISAPI/AccessControl/CaptureFaceData",
  captureCardInfo: "/ISAPI/AccessControl/CaptureCardInfo?format=json",
  cardInfoSetUp: "/ISAPI/AccessControl/CardInfo/SetUp?format=json",
  cardInfoSearch: "/ISAPI/AccessControl/CardInfo/Search?format=json",
  cardInfoDelete: "/ISAPI/AccessControl/CardInfo/Delete?format=json",
  fingerPrintSetUp: "/ISAPI/AccessControl/FingerPrint/SetUp?format=json",
  captureFingerPrint: "/ISAPI/AccessControl/CaptureFingerPrint",
};

const VALID_REMOTE_DOOR_CMDS = new Set([
  "open",
  "close",
  "alwaysOpen",
  "alwaysClose",
]);

function normalizeDoorNo(doorNo) {
  return Number.isFinite(Number(doorNo)) && Number(doorNo) > 0
    ? Math.trunc(Number(doorNo))
    : 1;
}

function buildRemoteControlDoorXml(cmd) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<RemoteControlDoor xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">
  <cmd>${cmd}</cmd>
</RemoteControlDoor>`;
}

/** 從 UserInfo 中只保留文檔指定欄位 */
const USER_INFO_FIELDS = [
  "employeeNo",
  "name",
  "userType",
  "Valid",
  "doorRight",
  "RightPlan",
  "faceURL",
];

const CRLF = Buffer.from("\r\n");
const CRLFCRLF = Buffer.from("\r\n\r\n");

/**
 * 部分 ISAPI 端點（如 CaptureFaceData）會回傳 multipart，內含 JSON + 圖片。
 * 這裡僅取第一個 image/* part，避免把整包 multipart 當成 jpg 寫入。
 */
function extractFirstImageFromMultipart(buffer, contentTypeHeader) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const ct = String(contentTypeHeader || "");
  const boundaryMatch = ct.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  const boundaryRaw = boundaryMatch
    ? (boundaryMatch[1] || boundaryMatch[2] || "").trim()
    : "";
  const boundary = boundaryRaw.replace(/^["']|["']$/g, "");
  if (!boundary) return null;

  const sep = Buffer.from(`--${boundary}`, "utf8");
  const sepWithCRLF = Buffer.from(`\r\n--${boundary}`, "utf8");

  let offset = 0;
  const findNextBoundary = (from) => {
    const a = buffer.indexOf(sepWithCRLF, from);
    const b = buffer.indexOf(sep, from);
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
  };

  while (offset < buffer.length) {
    let start = buffer.indexOf(sepWithCRLF, offset);
    let boundaryLen = sepWithCRLF.length;
    if (start === -1) {
      start = buffer.indexOf(sep, offset);
      boundaryLen = sep.length;
    }
    if (start === -1) break;

    const after = start + boundaryLen;
    // 結束 boundary: --boundary--
    if (buffer.slice(after, after + 2).equals(Buffer.from("--"))) break;

    // part 可能緊接 CRLF
    let partStart = after;
    if (buffer.slice(partStart, partStart + CRLF.length).equals(CRLF)) {
      partStart += CRLF.length;
    }

    const headEnd = buffer.indexOf(CRLFCRLF, partStart);
    if (headEnd === -1) break;
    const headerStr = buffer.slice(partStart, headEnd).toString("utf8");
    const ctPart =
      (headerStr.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || "";

    const bodyStart = headEnd + CRLFCRLF.length;
    const lenMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
    const contentLength = lenMatch ? parseInt(lenMatch[1], 10) : 0;
    let bodyEnd = 0;

    if (contentLength > 0) {
      bodyEnd = bodyStart + contentLength;
      if (bodyEnd > buffer.length) break;
    } else {
      const next = findNextBoundary(bodyStart);
      if (next === -1) break;
      bodyEnd = next;
      // 去掉 part 結尾的 CRLF
      if (
        bodyEnd - 2 >= bodyStart &&
        buffer[bodyEnd - 2] === 0x0d &&
        buffer[bodyEnd - 1] === 0x0a
      ) {
        bodyEnd -= 2;
      }
    }

    if (/^image\//i.test(ctPart.trim())) {
      const img = buffer.slice(bodyStart, bodyEnd);
      if (img.length > 0) return { buffer: img, contentType: ctPart.trim() };
    }

    offset = bodyEnd;
  }

  return null;
}

/**
 * 補齊設備常見必填欄位，避免僅送 employeeNo/name 導致設備回 400
 * 注意：僅在欄位缺失時填入預設，不覆蓋呼叫端提供的值。
 */
function applyUserInfoDefaults(userInfo) {
  const u = { ...(userInfo || {}) };
  if (u.employeeNo != null) u.employeeNo = String(u.employeeNo);

  if (!u.userType) u.userType = "normal";

  if (!u.doorRight) u.doorRight = "1";

  // ISAPI 的 Valid.enable 在多數型號為 boolean（true/false）。
  // 若送入的是字串/數字，這裡僅做安全正規化，避免 badJsonContent / wrong.enable。
  if (
    u.Valid &&
    typeof u.Valid === "object" &&
    Object.prototype.hasOwnProperty.call(u.Valid, "enable")
  ) {
    const raw = u.Valid.enable;
    const enabled =
      raw === true ||
      raw === "true" ||
      raw === "TRUE" ||
      raw === 1 ||
      raw === "1";
    u.Valid.enable = Boolean(enabled);
  }

  if (!Array.isArray(u.RightPlan) || u.RightPlan.length === 0) {
    u.RightPlan = [{ doorNo: 1, planTemplateNo: "1" }];
  }

  return u;
}

/**
 * 取得門禁設備並建立 ISAPI 客戶端
 * @param {number} deviceId - 設備 ID
 * @returns {Promise<{ device, model, client }>}
 */
async function getDeviceAndClient(deviceId) {
  const { device } = await deviceService.getDeviceById(deviceId);
  if (device.type_code !== "access_control") {
    throw createApiError(C.ACCESS_CONTROL_NOT_DEVICE, "該設備不是門禁設備");
  }
  if (
    !device.config?.host ||
    !device.config?.username ||
    !device.config?.password
  ) {
    throw createApiError(
      C.ACCESS_CONTROL_CONFIG_INCOMPLETE,
      "門禁設備連線設定不完整（缺少 host / username / password）",
    );
  }
  const client = createIsapiClient(device.config);
  const model = device.model || {};
  return { device, model, client };
}

/**
 * 取得設備上所有人員資料（分頁由設備端處理）
 * @param {number} deviceId
 * @param {object} options - { searchResultPosition = 0, maxResults = 50 }
 * @returns {Promise<{ list, totalMatches, numOfMatches }>} - list 為簡化欄位
 */
async function searchUserInfo(deviceId, options = {}) {
  const { client } = await getDeviceAndClient(deviceId);
  const searchResultPosition = options.searchResultPosition ?? 0;
  const maxResults = options.maxResults ?? 50;
  const body = {
    UserInfoSearchCond: {
      searchID: "1",
      searchResultPosition,
      maxResults,
    },
  };
  const res = await client.request({
    method: "POST",
    path: ISAPI_PATHS.userInfoSearch,
    data: body,
  });
  const search = res.data?.UserInfoSearch;
  if (!search) {
    throw createApiError(
      C.ACCESS_CONTROL_ISAPI_INVALID_RESPONSE,
      "設備回傳格式異常：缺少 UserInfoSearch",
    );
  }
  const rawList = search.UserInfo || [];
  const list = rawList.map((u) => {
    const out = {};
    for (const key of USER_INFO_FIELDS) {
      if (u[key] !== undefined) out[key] = u[key];
    }
    return out;
  });
  return {
    list,
    totalMatches: search.totalMatches ?? list.length,
    numOfMatches: search.numOfMatches ?? list.length,
  };
}

/**
 * 修改單一人員資料
 * @param {number} deviceId
 * @param {object} userInfo - ISAPI UserInfo 物件
 */
async function updateUserInfo(deviceId, userInfo) {
  const { client } = await getDeviceAndClient(deviceId);
  const payload = applyUserInfoDefaults(userInfo);
  await client.request({
    method: "PUT",
    path: ISAPI_PATHS.userInfoSetUp,
    data: { UserInfo: payload },
  });
  return { success: true };
}

/**
 * 刪除單一或多筆人員（依員工編號）
 * @param {number} deviceId
 * @param {object} payload - { employeeNo } 或 { employeeNoList: string[] }
 */
async function deleteUserInfo(deviceId, payload) {
  const { client } = await getDeviceAndClient(deviceId);
  const rawList = Array.isArray(payload.employeeNoList)
    ? payload.employeeNoList
    : payload.employeeNo != null
      ? [payload.employeeNo]
      : [];
  if (rawList.length === 0) {
    throw createApiError(C.ACCESS_CONTROL_EMPLOYEE_NO_REQUIRED, "請提供 employeeNo 或 employeeNoList");
  }
  const employeeNoList = rawList.map((no) => ({ employeeNo: String(no) }));
  const body = {
    UserInfoDetail: {
      mode: "byEmployeeNo",
      EmployeeNoList: employeeNoList,
    },
  };
  await client.request({
    method: "PUT",
    path: ISAPI_PATHS.userInfoDetailDelete,
    data: body,
  });
  return { success: true };
}

/**
 * 修改單一人臉配對（上傳人臉圖）
 * @param {number} deviceId
 * @param {string} employeeNo - 人員編號（FPID）
 * @param {Buffer} imageBuffer - 人臉圖片
 * @param {object} options - { faceLibType = "blackFD", FDID = "1", faceType = "normalFace" }
 */
async function updateFace(deviceId, employeeNo, imageBuffer, options = {}) {
  const { client } = await getDeviceAndClient(deviceId);
  const faceLibType = options.faceLibType ?? "blackFD";
  const FDID = options.FDID ?? "1";
  const faceType = options.faceType ?? "normalFace";
  const faceURL = JSON.stringify({
    faceLibType,
    FDID,
    FPID: employeeNo,
    faceType,
  });
  const form = new FormData();
  form.append("faceURL", faceURL, { contentType: "application/json" });
  form.append("img", imageBuffer, { filename: "face.jpg" });

  await client.request({
    method: "PUT",
    path: ISAPI_PATHS.fdSetUp,
    data: form,
    headers: form.getHeaders(),
  });
  return { success: true };
}

/**
 * 呼叫設備截圖（捕獲人臉資料）
 * 依設備型號 config.isapi.captureFaceData 組裝 XML（dataType 等），若無則使用預設。
 * @param {number} deviceId
 * @param {object} overrides - 可覆寫 { dataType, captureInfrared, readerID }
 * @returns {Promise<object>} - 設備回傳內容（依 dataType 可能為 binary 或 url 等）
 */
async function captureFaceData(deviceId, overrides = {}) {
  const { client, model } = await getDeviceAndClient(deviceId);
  const isapiConfig = model.config?.isapi?.captureFaceData || {};
  // 平台僅支援 binary 截圖（回傳 base64，供前端儲存/預覽/後續人臉同步使用）
  const dataType = "binary";
  const captureInfrared =
    overrides.captureInfrared ?? isapiConfig.captureInfrared ?? true;
  const readerID = overrides.readerID ?? isapiConfig.readerID ?? 1;

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CaptureFaceDataCond xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">',
    `  <captureInfrared>${captureInfrared}</captureInfrared>`,
    `  <dataType>${dataType}</dataType>`,
    `  <readerID>${readerID}</readerID>`,
    "</CaptureFaceDataCond>",
  ].join("\n");

  const responseType = "arraybuffer";
  const res = await client.request({
    method: "POST",
    path: ISAPI_PATHS.captureFaceData,
    data: xml,
    headers: { "Content-Type": "application/xml" },
    responseType,
  });
  const rawContentType =
    res.headers?.["content-type"] ||
    res.headers?.["Content-Type"] ||
    "image/jpeg";
  const normalizedContentType = String(rawContentType)
    .split(";")[0]
    .trim()
    .toLowerCase();
  const isMultipart = normalizedContentType.startsWith("multipart/");
  const fallbackContentType = normalizedContentType.startsWith("image/")
    ? normalizedContentType
    : "image/jpeg";
  const rawBuffer = Buffer.isBuffer(res.data)
    ? res.data
    : Buffer.from(res.data);
  const extracted = isMultipart
    ? extractFirstImageFromMultipart(rawBuffer, rawContentType)
    : null;
  const buffer = extracted?.buffer || rawBuffer;
  const contentType = extracted?.contentType || fallbackContentType;
  return {
    dataType: "binary",
    contentType,
    base64: buffer.toString("base64"),
    size: buffer.length,
  };
}

/**
 * 讀取卡片資訊（CaptureCardInfo）
 * 由設備端讀卡後回傳卡號等資訊（JSON）。
 * @param {number} deviceId
 * @returns {Promise<object>}
 */
async function captureCardInfo(deviceId) {
  const { client } = await getDeviceAndClient(deviceId);
  const res = await client.request({
    method: "GET",
    path: ISAPI_PATHS.captureCardInfo,
  });
  return res.data;
}

/**
 * 設定卡片資料（CardInfo/SetUp）
 * 目的：把 employeeNo 綁定到 cardNo，讓刷卡能通行。
 * @param {number} deviceId
 * @param {object} cardInfo - { employeeNo, cardNo, cardType? }
 */
async function setCardInfo(deviceId, cardInfo) {
  const { client } = await getDeviceAndClient(deviceId);
  const employeeNo =
    cardInfo?.employeeNo != null ? String(cardInfo.employeeNo) : "";
  const cardNo = cardInfo?.cardNo != null ? String(cardInfo.cardNo) : "";
  const cardType = cardInfo?.cardType || "normalCard";

  if (!employeeNo.trim()) {
    throw createApiError(C.ACCESS_CONTROL_EMPLOYEE_NO_REQUIRED, "請提供 employeeNo");
  }
  if (!cardNo.trim()) {
    throw createApiError(C.ACCESS_CONTROL_CARD_NO_REQUIRED, "請提供 cardNo");
  }

  await client.request({
    method: "PUT",
    path: ISAPI_PATHS.cardInfoSetUp,
    data: {
      CardInfo: {
        employeeNo,
        cardNo,
        cardType,
      },
    },
  });
  return { success: true };
}

/**
 * 讀取指紋模板（CaptureFingerPrint）
 * @param {number} deviceId
 * @param {object} options - { fingerNo }
 * @returns {Promise<{ contentType: string, bodyText: string, base64: string, size: number }>}
 */
async function captureFingerPrint(deviceId, options = {}) {
  const { client } = await getDeviceAndClient(deviceId);
  const fingerNoRaw = options.fingerNo ?? options.fingerPrintID ?? 1;
  const fingerNo = Number(fingerNoRaw) || 1;

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CaptureFingerPrintCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">',
    `  <fingerNo>${fingerNo}</fingerNo>`,
    "</CaptureFingerPrintCond>",
  ].join("\n");

  const res = await client.request({
    method: "POST",
    path: ISAPI_PATHS.captureFingerPrint,
    data: xml,
    headers: { "Content-Type": "application/xml" },
    responseType: "arraybuffer",
  });

  const rawContentType =
    res.headers?.["content-type"] ||
    res.headers?.["Content-Type"] ||
    "application/xml";
  const contentType = String(rawContentType).split(";")[0].trim().toLowerCase();
  const buffer = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
  const bodyText = buffer.toString("utf8");

  return {
    contentType: contentType || "application/xml",
    bodyText,
    base64: buffer.toString("base64"),
    size: buffer.length,
  };
}

/**
 * 上傳指紋模板並綁定 employeeNo（FingerPrint/SetUp）
 * @param {number} deviceId
 * @param {object} fingerPrintCfg - { employeeNo, fingerPrintID, fingerType, fingerData, enableCardReader? }
 */
async function setFingerPrint(deviceId, fingerPrintCfg) {
  const { client } = await getDeviceAndClient(deviceId);
  const employeeNo =
    fingerPrintCfg?.employeeNo != null ? String(fingerPrintCfg.employeeNo) : "";
  const fingerPrintID =
    fingerPrintCfg?.fingerPrintID != null
      ? Number(fingerPrintCfg.fingerPrintID)
      : 1;
  const fingerType = fingerPrintCfg?.fingerType || "normalFP";
  const fingerData =
    fingerPrintCfg?.fingerData != null ? String(fingerPrintCfg.fingerData) : "";
  const enableCardReader = Array.isArray(fingerPrintCfg?.enableCardReader)
    ? fingerPrintCfg.enableCardReader
    : undefined;

  if (!employeeNo.trim()) {
    throw createApiError(C.ACCESS_CONTROL_EMPLOYEE_NO_REQUIRED, "請提供 employeeNo");
  }
  if (!fingerData.trim()) {
    throw createApiError(C.ACCESS_CONTROL_FINGER_DATA_REQUIRED, "請提供 fingerData");
  }

  await client.request({
    method: "POST",
    path: ISAPI_PATHS.fingerPrintSetUp,
    data: {
      FingerPrintCfg: {
        employeeNo,
        fingerPrintID: Number.isFinite(fingerPrintID) ? fingerPrintID : 1,
        fingerType,
        fingerData,
        ...(enableCardReader ? { enableCardReader } : {}),
      },
    },
  });
  return { success: true };
}

const extractCardNosFromSearchResponse = (data) => {
  const out = [];
  const push = (raw) => {
    const c = raw?.cardNo ?? raw?.CardNo;
    if (c != null) {
      const s = String(c).trim();
      if (s) out.push(s);
    }
  };
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object") return;
    if (node.cardNo != null || node.CardNo != null) push(node);
    if (node.CardInfo) walk(node.CardInfo);
    if (node.CardInfoList) walk(node.CardInfoList);
    if (node.MatchList) walk(node.MatchList);
  };
  walk(data);
  return [...new Set(out)];
};

/**
 * 查詢設備上指定工號的卡片卡號列表
 * @param {number} deviceId
 * @param {string} employeeNo
 */
async function searchCardInfoByEmployee(deviceId, employeeNo) {
  const { client } = await getDeviceAndClient(deviceId);
  const eno = employeeNo != null ? String(employeeNo).trim() : "";
  if (!eno) return [];

  const res = await client.request({
    method: "POST",
    path: ISAPI_PATHS.cardInfoSearch,
    data: {
      CardInfoSearchCond: {
        searchID: String(Date.now()),
        searchResultPosition: 0,
        maxResults: 50,
        EmployeeNoList: [{ employeeNo: eno }],
      },
    },
  });
  return extractCardNosFromSearchResponse(res?.data ?? res);
}

/**
 * 刪除設備上的卡片綁定
 * @param {number} deviceId
 * @param {string} cardNo
 */
async function deleteCardInfo(deviceId, cardNo) {
  const { client } = await getDeviceAndClient(deviceId);
  const normalized = cardNo != null ? String(cardNo).trim() : "";
  if (!normalized) {
    throw createApiError(C.ACCESS_CONTROL_CARD_NO_REQUIRED, "請提供 cardNo");
  }

  await client.request({
    method: "PUT",
    path: ISAPI_PATHS.cardInfoDelete,
    data: {
      CardInfoDelCond: {
        CardNoList: [{ cardNo: normalized }],
      },
    },
  });
  return { success: true };
}

/**
 * 遠端門控（RemoteControlDoor）；成功／失敗皆寫營運事件。
 * @param {number} deviceId
 * @param {object} options
 * @param {'open'|'close'|'alwaysOpen'|'alwaysClose'} options.cmd
 * @param {number} [options.doorNo=1]
 * @param {object} [options.operationalEvent]
 * @param {number|null} [options.operationalEvent.actorUserId]
 * @param {boolean} [options.operationalEvent.fromAlertLinkage]
 * @param {number|null} [options.operationalEvent.alertId]
 * @param {number|null} [options.operationalEvent.ruleId]
 */
async function controlRemoteDoor(deviceId, options = {}) {
  const cmd = String(options.cmd || "").trim();
  if (!VALID_REMOTE_DOOR_CMDS.has(cmd)) {
    throw createApiError(
      C.BAD_REQUEST,
      "cmd 須為 open、close、alwaysOpen 或 alwaysClose",
    );
  }
  const doorNo = normalizeDoorNo(options.doorNo);
  const { device, client } = await getDeviceAndClient(deviceId);
  const oe = options.operationalEvent || {};
  const fromAlertLinkage = Boolean(oe.fromAlertLinkage);
  const deviceName = device?.name || `設備 #${deviceId}`;
  const placeCtx = await loadPlaceContextByAccessDeviceId(deviceId);

  const recordOe = (success, errorMessage = null) => {
    void operationalEventService.recordEvent({
      // 與門禁管理模組一致（人流事件同源 people_counting）
      source: fromAlertLinkage ? "alert_linkage" : "people_counting",
      event_kind: "control_write",
      location_id: placeCtx.locationId,
      system_id: placeCtx.systemId,
      device_id: deviceId,
      bit_key: `access_door:${cmd}`,
      new_value: success ? true : null,
      actor_user_id: oe.actorUserId ?? null,
      message: summaryAccessDoorControlWrite({
        deviceName,
        cmd,
        success,
        errorMessage,
        fromAlertLinkage,
        placeLabel: placeCtx.placeLabel,
      }),
      ref_table: fromAlertLinkage ? "alerts" : "devices",
      ref_id: fromAlertLinkage
        ? oe.alertId != null
          ? Number(oe.alertId)
          : null
        : deviceId,
      payload: {
        cmd,
        success,
        accessDeviceId: deviceId,
        doorNo,
        ...(fromAlertLinkage
          ? {
              fromAlertLinkage: true,
              linkageKind: "access_door",
              alertId: oe.alertId != null ? Number(oe.alertId) : null,
              ruleId: oe.ruleId != null ? Number(oe.ruleId) : null,
            }
          : {}),
        ...(errorMessage
          ? { errorMessage: String(errorMessage).slice(0, 500) }
          : {}),
      },
    });
  };

  try {
    await client.request({
      method: "PUT",
      path: `/ISAPI/AccessControl/RemoteControl/door/${doorNo}`,
      data: buildRemoteControlDoorXml(cmd),
      headers: { "Content-Type": "application/xml" },
      responseType: "text",
    });
    recordOe(true);
    if (!fromAlertLinkage && (cmd === "open" || cmd === "alwaysOpen")) {
      emitAccessControlEventFromPlaceContext(placeCtx, {
        source: "manual",
        deviceId,
      });
    }
    return { success: true, doorNo, cmd };
  } catch (err) {
    recordOe(false, err?.message || String(err));
    throw err;
  }
}

module.exports = {
  getDeviceAndClient,
  searchUserInfo,
  updateUserInfo,
  deleteUserInfo,
  updateFace,
  captureFaceData,
  captureCardInfo,
  setCardInfo,
  searchCardInfoByEmployee,
  deleteCardInfo,
  captureFingerPrint,
  setFingerPrint,
  controlRemoteDoor,
};
