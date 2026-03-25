/**
 * 門禁設備 ISAPI 服務層
 * 依設備與型號 config 組裝請求並呼叫 ISAPI。
 */
const deviceService = require("../devices/deviceService");
const { createIsapiClient } = require("./isapiClient");
const FormData = require("form-data");

const ISAPI_PATHS = {
  userInfoSearch: "/ISAPI/AccessControl/UserInfo/Search?format=json",
  userInfoSetUp: "/ISAPI/AccessControl/UserInfo/SetUp?format=json",
  userInfoDetailDelete:
    "/ISAPI/AccessControl/UserInfoDetail/Delete?format=json",
  fdSetUp: "/ISAPI/Intelligent/FDLib/FDSetUp?format=json",
  captureFaceData: "/ISAPI/AccessControl/CaptureFaceData",
};

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

function formatIsapiTime(date = new Date()) {
  // ISAPI 常見格式：YYYY-MM-DDTHH:mm:ss（不含毫秒與 Z）
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, "");
}

/**
 * 補齊設備常見必填欄位，避免僅送 employeeNo/name 導致設備回 400
 * 注意：僅在欄位缺失時填入預設，不覆蓋呼叫端提供的值。
 */
function applyUserInfoDefaults(userInfo) {
  const u = { ...(userInfo || {}) };
  if (u.employeeNo != null) u.employeeNo = String(u.employeeNo);

  if (!u.userType) u.userType = "normal";

  if (!u.Valid || typeof u.Valid !== "object") {
    u.Valid = {
      enable: true,
      beginTime: formatIsapiTime(new Date()),
      endTime: "2035-12-31T23:59:59",
    };
  } else {
    if (u.Valid.enable === undefined) u.Valid.enable = true;
    if (!u.Valid.beginTime) u.Valid.beginTime = formatIsapiTime(new Date());
    if (!u.Valid.endTime) u.Valid.endTime = "2035-12-31T23:59:59";
  }

  if (!u.doorRight) u.doorRight = "1";

  if (!Array.isArray(u.RightPlan) || u.RightPlan.length === 0) {
    u.RightPlan = [{ doorNo: 1, planTemplateNo: "1" }];
  }

  // 依文檔建議：讓設備接受最小可用值（如設備不需要，仍可忽略）
  if (!u.userVerifyMode) u.userVerifyMode = "faceOrFpOrCardOrPw";
  if (!u.password) u.password = "123456";

  return u;
}

/**
 * 取得門禁設備並建立 ISAPI 客戶端
 * @param {number} deviceId - 設備 ID
 * @returns {Promise<{ device, model, client }>}
 */
async function getDeviceAndClient(deviceId) {
  const { device } = await deviceService.getDeviceById(deviceId);
  if (
    !device.config?.host ||
    !device.config?.username ||
    !device.config?.password
  ) {
    const err = new Error(
      "設備連線設定不完整（缺少 host / username / password）",
    );
    err.statusCode = 400;
    throw err;
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
    throw new Error("設備回傳格式異常：缺少 UserInfoSearch");
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
    throw new Error("請提供 employeeNo 或 employeeNoList");
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
  const dataType = overrides.dataType ?? isapiConfig.dataType ?? "url";
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

  const responseType = dataType === "binary" ? "arraybuffer" : "text";
  const res = await client.request({
    method: "POST",
    path: ISAPI_PATHS.captureFaceData,
    data: xml,
    headers: { "Content-Type": "application/xml" },
    responseType,
  });
  return res.data;
}

module.exports = {
  getDeviceAndClient,
  searchUserInfo,
  updateUserInfo,
  deleteUserInfo,
  updateFace,
  captureFaceData,
};
