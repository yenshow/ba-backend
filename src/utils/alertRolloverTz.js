/**
 * 警報日界線：曆日比對（不依賴額外套件，供忽視「僅當曆日有效」使用）
 * @param {Date|string|number} date
 * @param {string} timeZone IANA 名稱，例如 Asia/Taipei
 * @returns {string} YYYY-MM-DD
 */
function getCalendarDateKeyInTimeZone(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

module.exports = {
  getCalendarDateKeyInTimeZone,
};
