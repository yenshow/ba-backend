/**
 * 從門禁機事件紀錄（AcsEvent 短查詢）匯入平台。
 * 不建立 subscribeEvent，不會佔用佈防長連線。
 *
 * 只列出與即時訂閱相同的驗證事件（major=5：人臉／卡片／指紋／酒精）。
 * 相同設備、同一秒、同一人、同一種子類型已在庫則略過（含訂閱寫入但沒有 serialNo 的列）。
 * 人臉事件（sub 75／76）若設備有 pictureURL，會一併下載寫入；已入庫但沒有圖的列也會補圖。
 *
 *   cd ba-backend
 *   node scripts/importAccessEventsFromDevice.js
 *   node scripts/importAccessEventsFromDevice.js --device 1 --date 2026-09-23
 *   node scripts/importAccessEventsFromDevice.js --device 1 --date 2026-09-23 --indexes 1,3,5-8 --apply
 *   node scripts/importAccessEventsFromDevice.js --device 1 --date 2026-09-23 --all --apply
 */
/* eslint-disable no-console */

const readline = require("readline");
const db = require("../src/database/db");
const accessControlService = require("../src/services/accessControl/accessControlService");
const {
  persistIsapiEvent,
  isProcessableEvent,
  attachPictureToEvent,
} = require("../src/services/accessControl/isapiSubscribeService");
const {
  shouldQueueAccessEventPicture,
} = require("../src/services/peopleCounting/accessControlLogLabels");

const ACS_EVENT_PATH = "/ISAPI/AccessControl/AcsEvent?format=json";
const PAGE_SIZE = 30;
const MAX_PAGES = 200;

const SUB_LABEL = {
  1: "卡片成功",
  9: "卡片失敗",
  38: "指紋成功",
  39: "指紋失敗",
  75: "人臉成功",
  76: "人臉失敗",
  2077: "酒精正常",
  2078: "飲酒",
  2079: "醉酒",
};

const args = process.argv.slice(2);

const argValue = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value == null || value.startsWith("--")) return "";
  return value;
};

const hasFlag = (name) => args.includes(name);

const taipeiToday = () =>
  new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });

const ask = (rl, question) =>
  new Promise((resolve) => {
    rl.question(question, (answer) => resolve(String(answer ?? "").trim()));
  });

const asList = (value) => {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
};

const toPayload = (item) => {
  const employee = String(item.employeeNoString ?? item.employeeNo ?? "").trim();
  const name = String(item.name ?? item.personName ?? "").trim();
  const serialNo = item.serialNo != null ? item.serialNo : null;
  return {
    majorEventType: Number(item.major ?? item.majorEventType),
    subEventType: Number(item.minor ?? item.subEventType),
    employeeNoString: employee,
    employeeNo: employee,
    personName: name,
    cardNo: item.cardNo != null ? String(item.cardNo) : "",
    serialNo,
    doorNo: item.doorNo ?? null,
    cardReaderNo: item.cardReaderNo ?? null,
    currentVerifyMode: item.currentVerifyMode ?? "",
    userType: item.userType ?? "",
    cardType: item.cardType ?? null,
  };
};

const parseSelection = (text, max) => {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return [];
  if (raw === "all") {
    return Array.from({ length: max }, (_, index) => index + 1);
  }
  const picked = new Set();
  for (const part of raw.split(/[,，\s]+/)) {
    if (!part) continue;
    const bounds = part.split("-").map((piece) => Number(piece));
    if (bounds.length === 2 && bounds.every((n) => Number.isFinite(n))) {
      const lo = Math.min(bounds[0], bounds[1]);
      const hi = Math.max(bounds[0], bounds[1]);
      for (let n = lo; n <= hi; n += 1) {
        if (n >= 1 && n <= max) picked.add(n);
      }
      continue;
    }
    const n = Number(part);
    if (Number.isFinite(n) && n >= 1 && n <= max) picked.add(n);
  }
  return [...picked].sort((a, b) => a - b);
};

const listAccessDevices = async () => {
  const rows = await db.query(
    `SELECT id, name, config->>'host' AS host
     FROM devices
     WHERE LOWER(type_code) = 'access_control'
     ORDER BY id`,
  );
  return rows || [];
};

const extractPictureUrl = (item) => {
  const text = String(item?.pictureURL ?? "").trim();
  return text || null;
};

const isImageBuffer = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50) return true;
  return false;
};

const downloadEventPicture = async (client, pictureUrl) => {
  const res = await client.request({
    method: "GET",
    path: pictureUrl,
    responseType: "arraybuffer",
  });
  const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data || []);
  return isImageBuffer(buf) ? buf : null;
};

const fetchAcsEvents = async (client, date) => {
  const searchID = `ba-${Date.now()}`;
  const startTime = `${date}T00:00:00+08:00`;
  const endTime = `${date}T23:59:59+08:00`;
  const events = [];
  let position = 0;
  let withPicture = true;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const cond = {
      searchID,
      searchResultPosition: position,
      maxResults: PAGE_SIZE,
      major: 5,
      minor: 0,
      startTime,
      endTime,
    };
    let res;
    try {
      res = await client.request({
        method: "POST",
        path: ACS_EVENT_PATH,
        data: {
          AcsEventCond: withPicture ? { ...cond, picEnable: true } : cond,
        },
      });
    } catch (error) {
      if (!withPicture) throw error;
      withPicture = false;
      console.warn("設備未支援查詢附圖，這次只匯入事件文字。");
      page -= 1;
      continue;
    }
    const body = res.data || {};
    const acs = body.AcsEvent || body.acsEvent || body;
    const infoList = asList(acs.InfoList || acs.infoList);
    events.push(...infoList);
    const status = String(acs.responseStatusStrg || acs.responseStatusString || "");
    const matched = Number(acs.numOfMatches) || infoList.length;
    if (infoList.length === 0 || status.toUpperCase() === "OK" || status.toUpperCase() === "NO MATCH") {
      break;
    }
    const next = position + (matched > 0 ? matched : infoList.length);
    if (next <= position) break;
    position = next;
  }

  return events;
};

const findExisting = async (deviceId, eventTime, payload) => {
  const serial = payload.serialNo != null ? String(payload.serialNo) : "";
  const who = String(
    payload.employeeNoString || payload.employeeNo || payload.personName || payload.cardNo || "",
  ).trim();
  const rows = await db.query(
    `SELECT id, picture_path
     FROM isapi_access_events
     WHERE device_id = ?
       AND date_trunc('second', event_time) = date_trunc('second', ?::timestamptz)
       AND COALESCE(payload->>'subEventType', '') = ?
       AND (
         COALESCE(payload->>'serialNo', '') = ?
         OR COALESCE(payload->>'serialNo', '') = ''
         OR ? = ''
       )
       AND (
         ? = ''
         OR COALESCE(
           NULLIF(payload->>'employeeNoString', ''),
           NULLIF(payload->>'employeeNo', ''),
           NULLIF(payload->>'personName', ''),
           NULLIF(payload->>'cardNo', ''),
           ''
         ) IN ('', ?)
       )
     ORDER BY id
     LIMIT 1`,
    [deviceId, eventTime, String(payload.subEventType), serial, serial, who, who],
  );
  const row = rows?.[0];
  if (!row) return { id: null, hasPicture: false };
  const path = row.picture_path != null ? String(row.picture_path).trim() : "";
  return { id: row.id, hasPicture: path !== "" };
};

const printTable = (rows) => {
  console.log("");
  console.log(
    ["#", "時間", "工號", "姓名", "事件", "序號", "狀態"].join("\t"),
  );
  for (const row of rows) {
    console.log(
      [
        row.index,
        row.timeLabel,
        row.payload.employeeNoString || "—",
        row.payload.personName || "—",
        SUB_LABEL[row.payload.subEventType] || String(row.payload.subEventType),
        row.payload.serialNo != null ? String(row.payload.serialNo) : "—",
        row.existingId == null
          ? "未入庫"
          : row.needsPicture
            ? `已入庫 #${row.existingId}、缺圖`
            : `已入庫 #${row.existingId}`,
      ].join("\t"),
    );
  }
  console.log("");
};

const main = async () => {
  const devices = await listAccessDevices();
  if (devices.length === 0) {
    throw new Error("資料庫沒有門禁設備");
  }

  console.log("門禁設備：");
  for (const device of devices) {
    console.log(`  ${device.id}  ${device.name}  ${device.host || ""}`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    let deviceId = Number(argValue("--device"));
    if (!Number.isFinite(deviceId) || deviceId <= 0) {
      deviceId = Number(await ask(rl, "設備 ID："));
    }
    if (!devices.some((device) => Number(device.id) === deviceId)) {
      throw new Error(`找不到門禁設備 ${deviceId}`);
    }

    let date = argValue("--date") || "";
    if (!date) date = await ask(rl, `日期 YYYY-MM-DD（預設 ${taipeiToday()}）：`);
    if (!date) date = taipeiToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("日期格式須為 YYYY-MM-DD");
    }

    const { device, client } = await accessControlService.getDeviceAndClient(deviceId);
    const host = device.config?.host || "";
    console.log(`讀取 ${device.name}（${host}）${date} 的驗證事件…`);

    const rawEvents = await fetchAcsEvents(client, date);
    const candidates = [];
    for (const item of rawEvents) {
      const payload = toPayload(item);
      if (!isProcessableEvent(payload)) continue;
      const eventTime = String(item.time || item.dateTime || "").trim();
      if (!eventTime) continue;
      const existing = await findExisting(deviceId, eventTime, payload);
      const pictureUrl = extractPictureUrl(item);
      candidates.push({
        index: candidates.length + 1,
        eventTime,
        timeLabel: eventTime.replace("T", " ").replace(/\+\d{2}:\d{2}$/, ""),
        payload,
        pictureUrl,
        existingId: existing.id,
        needsPicture:
          shouldQueueAccessEventPicture(payload) &&
          !existing.hasPicture &&
          pictureUrl != null,
      });
    }

    console.log(
      `設備回傳 ${rawEvents.length} 筆（major=5），可匯入驗證事件 ${candidates.length} 筆。`,
    );
    if (candidates.length === 0) {
      console.log("沒有可匯入的人臉／卡片／指紋／酒精事件。");
      return;
    }
    printTable(candidates);

    let selectionText = argValue("--indexes");
    if (hasFlag("--all")) selectionText = "all";
    if (selectionText == null) {
      selectionText = await ask(rl, "要匯入的編號（例 1,3,5-8 或 all，空白取消）：");
    }
    const indexes = parseSelection(selectionText, candidates.length);
    const chosen = indexes
      .map((index) => candidates[index - 1])
      .filter(Boolean);
    const pending = chosen.filter((row) => row.existingId == null || row.needsPicture);
    const alreadyDone = chosen.length - pending.length;
    if (pending.length === 0) {
      console.log(chosen.length === 0 ? "未選擇事件。" : "選擇的事件都已入庫，且人臉圖已有或設備沒有抓拍。");
      return;
    }

    const insertCount = pending.filter((row) => row.existingId == null).length;
    const pictureCount = pending.filter((row) => row.needsPicture).length;
    console.log(
      `將處理 ${pending.length} 筆（新寫入 ${insertCount}，補圖 ${pictureCount}）` +
        `${alreadyDone > 0 ? `，略過 ${alreadyDone} 筆` : ""}。`,
    );
    const apply = hasFlag("--apply");
    if (!apply) {
      const confirm = (await ask(rl, "寫入平台？(y/N)：")).toLowerCase();
      if (confirm !== "y" && confirm !== "yes") {
        console.log("已取消，未寫入。");
        return;
      }
    }

    let inserted = 0;
    let pictures = 0;
    for (const row of pending) {
      let eventId = row.existingId;
      if (eventId == null) {
        const result = await persistIsapiEvent({
          deviceId,
          deviceIp: host,
          eventTime: row.eventTime,
          eventType: "AccessControllerEvent",
          payload: row.payload,
        });
        if (!result.inserted) continue;
        eventId = result.id;
        inserted += 1;
        console.log(
          `已寫入 #${eventId}  ${row.timeLabel}  ${row.payload.personName || row.payload.employeeNoString || ""}`,
        );
      }
      if (!row.needsPicture) continue;
      try {
        const picture = await downloadEventPicture(client, row.pictureUrl);
        if (!picture) {
          console.log(`  無抓拍  ${row.timeLabel}`);
          continue;
        }
        await attachPictureToEvent(eventId, picture);
        pictures += 1;
        console.log(`  已補圖  #${eventId}`);
      } catch (error) {
        console.log(`  抓拍失敗  ${row.timeLabel}  ${error?.message || error}`);
      }
    }
    console.log(`完成，新寫入 ${inserted} 筆，補上人臉圖 ${pictures} 張。人流頁重新整理即可看到。`);
  } finally {
    rl.close();
  }
};

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error?.message || String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await db.close();
      } catch (_error) {
        /* 連線池可能尚未建立 */
      }
    });
}

module.exports = {
  parseSelection,
  toPayload,
  extractPictureUrl,
  isImageBuffer,
};
