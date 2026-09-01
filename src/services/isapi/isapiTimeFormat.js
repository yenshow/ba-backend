const { DateTime } = require("luxon");

/** 人員效期等 payload：UTC，YYYY-MM-DDTHH:mm:ss（無毫秒與 Z） */
function formatIsapiUtcTime(date = new Date()) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, "");
}

/** 設備校時 PUT：本地時間，YYYY-MM-DDTHH:mm:ss（無時區後綴） */
function formatIsapiLocalTime(date = new Date(), zone = "Asia/Taipei") {
  return DateTime.fromJSDate(new Date(date))
    .setZone(zone)
    .toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** IANA → ISAPI timeZone（目前僅支援 Asia/Taipei UTC+8 無 DST） */
function toIsapiTimeZone(ianaZone = "Asia/Taipei") {
  if (ianaZone === "Asia/Taipei") {
    return "CST-8:00:00";
  }
  const dt = DateTime.now().setZone(ianaZone);
  const offsetMinutes = dt.offset;
  const sign = offsetMinutes <= 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = "00";
  return `CST${sign}${hh}:${mm}:${ss}`;
}

module.exports = {
  formatIsapiUtcTime,
  formatIsapiLocalTime,
  toIsapiTimeZone,
};
