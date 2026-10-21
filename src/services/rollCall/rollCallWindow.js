/**
 * 時段簽到時間窗：台北曆日、跨日展開、每週重疊、解析目前場次。
 */
const WEEKDAY_MAP = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const MINUTES_PER_DAY = 24 * 60;
const WEEK_MINUTES = 7 * MINUTES_PER_DAY;

const taipeiParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes:
      (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
    weekday: WEEKDAY_MAP[get("weekday")] || 1,
  };
};

const timeToMinutes = (value) => {
  const text = String(value ?? "").trim();
  const match = /^(\d{1,2}):(\d{2})/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
};

const minutesToTime = (minutes) => {
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `${hour}:${minute}:00`;
};

const taipeiInstant = (dateStr, minutes) => {
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `${dateStr}T${hour}:${minute}:00+08:00`;
};

const formatPgDate = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const text = String(value ?? "");
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : text.slice(0, 10);
};

const formatTime = (value) => {
  const minutes = timeToMinutes(value);
  if (minutes == null) return String(value ?? "");
  return minutesToTime(minutes).slice(0, 5);
};

const addDaysYmd = (dateStr, delta) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || "").trim());
  if (!match) return String(dateStr || "");
  const utc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + Number(delta || 0),
  );
  const date = new Date(utc);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const prevWeekday = (day) => {
  const n = Number(day);
  if (n === 1) return 7;
  return n - 1;
};

const isOvernightWindow = (startMin, endMin) =>
  Number.isFinite(startMin) && Number.isFinite(endMin) && endMin < startMin;

const rangesOverlap = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

const normalizeWeekdays = (list) =>
  [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((value) => Number(value))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7),
    ),
  ].sort((a, b) => a - b);

const weekdaysOverlap = (left, right) => {
  const set = new Set(left);
  return right.some((day) => set.has(day));
};

const collectWeekSpans = (startMin, endMin, weekdays) => {
  const overnight = isOvernightWindow(startMin, endMin);
  const spans = [];
  for (const day of normalizeWeekdays(weekdays)) {
    const dayOffset = (day - 1) * MINUTES_PER_DAY;
    const start = dayOffset + startMin;
    const end = overnight
      ? dayOffset + MINUTES_PER_DAY + endMin
      : dayOffset + endMin;
    if (end <= WEEK_MINUTES) {
      spans.push({ start, end });
    } else {
      spans.push({ start, end: WEEK_MINUTES });
      spans.push({ start: 0, end: end - WEEK_MINUTES });
    }
  }
  return spans;
};

const windowsOverlapOnWeek = (aStart, aEnd, aDays, bStart, bEnd, bDays) => {
  const left = collectWeekSpans(aStart, aEnd, aDays);
  const right = collectWeekSpans(bStart, bEnd, bDays);
  for (const a of left) {
    for (const b of right) {
      if (rangesOverlap(a.start, a.end, b.start, b.end)) return true;
    }
  }
  return false;
};

const ruleWindowMinutes = (rule) => {
  const startMin = timeToMinutes(rule?.window_start ?? rule?.windowStart);
  const endMin = timeToMinutes(rule?.window_end ?? rule?.windowEnd);
  return { startMin, endMin };
};

const ruleWeekdays = (rule) => {
  const raw = rule?.weekdays;
  return Array.isArray(raw) ? raw.map((day) => Number(day)) : [];
};

/**
 * 現在落在規則的哪個場次窗。跨日場次日＝開始日。
 * @returns {{ sessionDate: string, startIso: string, endIso: string } | null}
 */
const resolveActiveWindow = (rule, now = new Date()) => {
  if (!rule || rule.enabled === false) return null;
  const { startMin, endMin } = ruleWindowMinutes(rule);
  if (startMin == null || endMin == null || startMin === endMin) return null;
  const weekdays = ruleWeekdays(rule);
  const parts = taipeiParts(now);
  const overnight = isOvernightWindow(startMin, endMin);

  if (!overnight) {
    if (!weekdays.includes(parts.weekday) || parts.minutes < startMin) return null;
    return {
      sessionDate: parts.date,
      startIso: taipeiInstant(parts.date, startMin),
      endIso: taipeiInstant(parts.date, endMin),
    };
  }

  if (weekdays.includes(parts.weekday) && parts.minutes >= startMin) {
    const tomorrow = addDaysYmd(parts.date, 1);
    return {
      sessionDate: parts.date,
      startIso: taipeiInstant(parts.date, startMin),
      endIso: taipeiInstant(tomorrow, endMin),
    };
  }

  const yesterday = addDaysYmd(parts.date, -1);
  const yesterdayWeekday = prevWeekday(parts.weekday);
  if (weekdays.includes(yesterdayWeekday) && parts.minutes < endMin) {
    return {
      sessionDate: yesterday,
      startIso: taipeiInstant(yesterday, startMin),
      endIso: taipeiInstant(parts.date, endMin),
    };
  }

  return null;
};

const pickPrimarySession = (sessions) => {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  return (
    sessions.find((item) => item.status === "open") ||
    sessions.find((item) => item.status === "closed") ||
    sessions[0] ||
    null
  );
};

module.exports = {
  MINUTES_PER_DAY,
  taipeiParts,
  timeToMinutes,
  minutesToTime,
  taipeiInstant,
  formatPgDate,
  formatTime,
  addDaysYmd,
  prevWeekday,
  isOvernightWindow,
  rangesOverlap,
  normalizeWeekdays,
  weekdaysOverlap,
  collectWeekSpans,
  windowsOverlapOnWeek,
  ruleWindowMinutes,
  resolveActiveWindow,
  pickPrimarySession,
};
