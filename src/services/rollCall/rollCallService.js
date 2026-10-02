/**
 * 時段簽到：地點規則、當日場次快照、門禁人臉成功比對、結場。
 * 時區 Asia/Taipei。時段不跨日。通知不在本模組。
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const logger = require("../../utils/logger").createLogger("rollCall");
const {
  extractSubEventType,
  extractAccessEventIdentity,
  shouldDisplayAccessEventPicture,
} = require("../peopleCounting/accessControlLogLabels");
const {
  UNGROUPED_GROUP_ID,
  UNGROUPED_GROUP_NAME,
  groupPersonsByPersonGroup,
} = require("../../utils/personGroupUtils");

const WEEKDAY_MAP = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

let reconcileChain = Promise.resolve();

const enqueueReconcile = (fn) => {
  const run = reconcileChain.then(fn, fn);
  reconcileChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const normalizeMediaPath = (raw) => {
  const value = raw != null ? String(raw).trim() : "";
  if (value === "") return undefined;
  return value.startsWith("/") ? value : `/${value}`;
};

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
    minutes: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
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

const normalizeIds = (list) => [
  ...new Set(
    (Array.isArray(list) ? list : [])
      .map((value) => Number(value))
      .filter((n) => Number.isFinite(n) && n > 0)
      .map((n) => Math.trunc(n)),
  ),
];

const normalizeWeekdays = (list) => {
  const days = [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((value) => Number(value))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7),
    ),
  ].sort((a, b) => a - b);
  return days;
};

const parseDeviceIds = (config) => {
  const raw = typeof config === "string" ? JSON.parse(config) : config || {};
  return normalizeIds(raw.device_ids);
};

const rangesOverlap = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

const weekdaysOverlap = (left, right) => {
  const set = new Set(left);
  return right.some((day) => set.has(day));
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

const mapRule = (row) => ({
  id: Number(row.id),
  locationId: Number(row.location_id),
  name: row.name,
  windowStart: formatTime(row.window_start),
  windowEnd: formatTime(row.window_end),
  weekdays: Array.isArray(row.weekdays)
    ? row.weekdays.map((day) => Number(day))
    : [],
  enabled: row.enabled !== false,
});

const assertLocationIsRollCall = async (locationId) => {
  const rows = await db.query(
    `SELECT ls.system_config
     FROM location_systems ls
     WHERE ls.location_id = ? AND ls.system_type = 'roll_call'
     LIMIT 1`,
    [locationId],
  );
  if (!rows?.length) {
    throwApiError(C.NOT_FOUND, "找不到時段簽到地點");
  }
  return parseDeviceIds(rows[0].system_config);
};

const assertNoOverlap = async ({
  locationId,
  weekdays,
  startMin,
  endMin,
  excludeRuleId,
}) => {
  const params = [locationId];
  let sql = `SELECT id, name, window_start, window_end, weekdays
     FROM roll_call_rules
     WHERE location_id = ? AND enabled = TRUE`;
  if (excludeRuleId) {
    params.push(excludeRuleId);
    sql += " AND id <> ?";
  }
  const rows = await db.query(sql, params);
  for (const row of rows || []) {
    const otherDays = Array.isArray(row.weekdays)
      ? row.weekdays.map((day) => Number(day))
      : [];
    if (!weekdaysOverlap(weekdays, otherDays)) continue;
    const otherStart = timeToMinutes(row.window_start);
    const otherEnd = timeToMinutes(row.window_end);
    if (otherStart == null || otherEnd == null) continue;
    if (rangesOverlap(startMin, endMin, otherStart, otherEnd)) {
      throwApiError(C.CONFLICT, `與啟用中的規則「${row.name}」時段重疊`);
    }
  }
};

const parseRuleInput = (body) => {
  const name = String(body?.name ?? "").trim();
  if (!name) throwApiError(C.VALIDATION_REQUIRED, "規則名稱不能為空");
  if (name.length > 100) {
    throwApiError(C.VALIDATION_REQUIRED, "規則名稱長度不能超過 100 字元");
  }
  const locationId = Number(body?.locationId ?? body?.location_id);
  if (!Number.isFinite(locationId) || locationId <= 0) {
    throwApiError(C.VALIDATION_REQUIRED, "地點不能為空");
  }
  const startMin = timeToMinutes(body?.windowStart ?? body?.window_start);
  const endMin = timeToMinutes(body?.windowEnd ?? body?.window_end);
  if (startMin == null || endMin == null) {
    throwApiError(C.VALIDATION_REQUIRED, "時段格式須為 HH:mm");
  }
  if (endMin <= startMin) {
    throwApiError(C.VALIDATION_REQUIRED, "結束時間須晚於開始時間，且不可跨日");
  }
  const weekdays = normalizeWeekdays(body?.weekdays);
  if (weekdays.length === 0) {
    throwApiError(C.VALIDATION_REQUIRED, "請至少選擇一個星期");
  }
  const enabled = body?.enabled !== false;
  const ruleIdRaw = body?.id;
  const ruleId =
    ruleIdRaw != null && Number.isFinite(Number(ruleIdRaw)) && Number(ruleIdRaw) > 0
      ? Math.trunc(Number(ruleIdRaw))
      : null;
  return {
    id: ruleId,
    name,
    locationId: Math.trunc(locationId),
    startMin,
    endMin,
    weekdays,
    enabled,
  };
};

const loadLocationMembers = async (locationId) => {
  const {
    getPersonsWithAccessByLocationId,
  } = require("../personnel/locationMemberService");
  return getPersonsWithAccessByLocationId(locationId);
};

const getRuleById = async (ruleId) => {
  const rows = await db.query(
    `SELECT * FROM roll_call_rules WHERE id = ? LIMIT 1`,
    [ruleId],
  );
  if (!rows?.length) throwApiError(C.NOT_FOUND, "找不到規則");
  return mapRule(rows[0]);
};

const listRules = async (locationId) => {
  const params = [];
  let sql = `SELECT * FROM roll_call_rules`;
  if (locationId) {
    params.push(locationId);
    sql += ` WHERE location_id = ?`;
  }
  sql += ` ORDER BY location_id, window_start, id`;
  const rows = await db.query(sql, params);
  return (rows || []).map((row) => mapRule(row));
};

const insertRuleRow = async (locationId, input) => {
  const rows = await db.query(
    `INSERT INTO roll_call_rules
      (location_id, name, window_start, window_end, weekdays, enabled)
     VALUES (?, ?, ?::time, ?::time, ?::smallint[], ?)
     RETURNING id`,
    [
      locationId,
      input.name,
      minutesToTime(input.startMin),
      minutesToTime(input.endMin),
      input.weekdays,
      input.enabled,
    ],
  );
  return Number(rows[0].id);
};

const updateRuleRow = async (ruleId, input) => {
  await db.query(
    `UPDATE roll_call_rules
     SET name = ?, window_start = ?::time, window_end = ?::time,
         weekdays = ?::smallint[], enabled = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      input.name,
      minutesToTime(input.startMin),
      minutesToTime(input.endMin),
      input.weekdays,
      input.enabled,
      ruleId,
    ],
  );
};

const createRule = async (body) => {
  const input = parseRuleInput(body);
  await assertLocationIsRollCall(input.locationId);
  if (input.enabled) {
    await assertNoOverlap({
      locationId: input.locationId,
      weekdays: input.weekdays,
      startMin: input.startMin,
      endMin: input.endMin,
    });
  }
  const ruleId = await insertRuleRow(input.locationId, input);
  return getRuleById(ruleId);
};

const updateRule = async (ruleId, body) => {
  const existing = await getRuleById(ruleId);
  const input = parseRuleInput({
    ...existing,
    locationId: existing.locationId,
    ...body,
    locationId: existing.locationId,
  });
  if (input.enabled) {
    await assertNoOverlap({
      locationId: existing.locationId,
      weekdays: input.weekdays,
      startMin: input.startMin,
      endMin: input.endMin,
      excludeRuleId: ruleId,
    });
  }
  await updateRuleRow(ruleId, input);
  return getRuleById(ruleId);
};

const deleteRule = async (ruleId) => {
  const rows = await db.query(
    `DELETE FROM roll_call_rules WHERE id = ? RETURNING id`,
    [ruleId],
  );
  if (!rows?.length) throwApiError(C.NOT_FOUND, "找不到規則");
  return { id: ruleId };
};

/**
 * 以完整清單取代某地點規則（地點表單草稿一次落庫；同一地點可多筆）。
 * body.rules: Array<{ id?, name, windowStart, windowEnd, weekdays, enabled }>
 */
const replaceLocationRules = async (locationId, rulesInput) => {
  const id = Number(locationId);
  if (!Number.isFinite(id) || id <= 0) {
    throwApiError(C.VALIDATION_REQUIRED, "地點不能為空");
  }
  await assertLocationIsRollCall(id);
  const list = Array.isArray(rulesInput) ? rulesInput : [];
  if (list.length === 0) {
    throwApiError(C.VALIDATION_REQUIRED, "至少需要一筆時段規則");
  }
  const parsed = list.map((item) =>
    parseRuleInput({ ...item, locationId: id }),
  );

  const enabledParsed = parsed.filter((item) => item.enabled);
  for (let i = 0; i < enabledParsed.length; i++) {
    const current = enabledParsed[i];
    for (let j = i + 1; j < enabledParsed.length; j++) {
      const other = enabledParsed[j];
      if (!weekdaysOverlap(current.weekdays, other.weekdays)) continue;
      if (
        rangesOverlap(
          current.startMin,
          current.endMin,
          other.startMin,
          other.endMin,
        )
      ) {
        throwApiError(
          C.CONFLICT,
          `啟用中的規則「${current.name}」與「${other.name}」時段重疊`,
        );
      }
    }
  }

  await db.transaction(async (tx) => {
    const existing = await tx(
      `SELECT id FROM roll_call_rules WHERE location_id = ?`,
      [id],
    );
    const existingIds = new Set(
      (existing || [])
        .map((row) => Number(row.id))
        .filter((n) => Number.isFinite(n)),
    );
    const keepIds = new Set();

    for (const input of parsed) {
      if (input.id && existingIds.has(input.id)) {
        await tx(
          `UPDATE roll_call_rules
           SET name = ?, window_start = ?::time, window_end = ?::time,
               weekdays = ?::smallint[], enabled = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND location_id = ?`,
          [
            input.name,
            minutesToTime(input.startMin),
            minutesToTime(input.endMin),
            input.weekdays,
            input.enabled,
            input.id,
            id,
          ],
        );
        keepIds.add(input.id);
      } else {
        const rows = await tx(
          `INSERT INTO roll_call_rules
            (location_id, name, window_start, window_end, weekdays, enabled)
           VALUES (?, ?, ?::time, ?::time, ?::smallint[], ?)
           RETURNING id`,
          [
            id,
            input.name,
            minutesToTime(input.startMin),
            minutesToTime(input.endMin),
            input.weekdays,
            input.enabled,
          ],
        );
        keepIds.add(Number(rows[0].id));
      }
    }

    const toDelete = [...existingIds].filter((ruleId) => !keepIds.has(ruleId));
    if (toDelete.length) {
      await tx(`DELETE FROM roll_call_rules WHERE id = ANY(?::int[])`, [toDelete]);
    }
  });

  return listRules(id);
};

const snapshotAttendance = async (sessionId, locationId) => {
  const persons = await loadLocationMembers(locationId);
  for (const person of persons) {
    const employeeNo =
      person.employee_no != null ? String(person.employee_no).trim() : "";
    if (!employeeNo) continue;
    await db.query(
      `INSERT INTO roll_call_attendance
        (session_id, person_id, employee_no, full_name, status)
       VALUES (?, ?, ?, ?, 'pending')
       ON CONFLICT (session_id, person_id) DO NOTHING`,
      [sessionId, person.id, employeeNo, person.full_name || null],
    );
  }
};

const applyFaceMatches = async (
  sessionId,
  deviceIds,
  startIso,
  endIso,
  statsResetAt = null,
) => {
  if (!deviceIds.length) return;
  let effectiveStart = startIso;
  if (statsResetAt) {
    const resetMs = new Date(statsResetAt).getTime();
    const startMs = Date.parse(startIso);
    if (Number.isFinite(resetMs) && Number.isFinite(startMs) && resetMs > startMs) {
      effectiveStart = new Date(statsResetAt).toISOString();
    }
  }
  const events = await db.query(
    `SELECT id, event_time, payload
     FROM isapi_access_events
     WHERE device_id = ANY(?::int[])
       AND event_time >= ?
       AND event_time < ?
     ORDER BY event_time ASC`,
    [deviceIds, effectiveStart, endIso],
  );
  const attendance = await db.query(
    `SELECT id, employee_no, status, source
     FROM roll_call_attendance
     WHERE session_id = ?`,
    [sessionId],
  );
  const byNo = new Map();
  for (const row of attendance || []) {
    const no = row.employee_no != null ? String(row.employee_no).trim() : "";
    if (no && !byNo.has(no)) byNo.set(no, row);
  }
  for (const event of events || []) {
    const payload =
      event.payload && typeof event.payload === "object" ? event.payload : {};
    if (extractSubEventType(payload) !== 75) continue;
    const employeeNo = extractAccessEventIdentity(payload).employeeNo;
    if (!employeeNo) continue;
    const row = byNo.get(employeeNo);
    if (!row || row.source === "manual" || row.status === "present") continue;
    const updated = await db.query(
      `UPDATE roll_call_attendance
       SET status = 'present', source = 'face', checked_in_at = ?, event_id = ?
       WHERE id = ?
         AND source IS DISTINCT FROM 'manual'
         AND status <> 'present'
       RETURNING id`,
      [event.event_time, event.id, row.id],
    );
    if (updated?.length) {
      row.status = "present";
      row.source = "face";
    }
  }
};

const closeSession = async (sessionId) => {
  await db.query(
    `UPDATE roll_call_attendance
     SET status = 'absent'
     WHERE session_id = ? AND status = 'pending'`,
    [sessionId],
  );
  await db.query(
    `UPDATE roll_call_sessions
     SET status = 'closed', closed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'open'`,
    [sessionId],
  );
};

const ensureSession = async (rule, dateStr) => {
  const inserted = await db.query(
    `INSERT INTO roll_call_sessions (rule_id, session_date, status)
     VALUES (?, ?::date, 'open')
     ON CONFLICT (rule_id, session_date) DO NOTHING
     RETURNING id`,
    [rule.id, dateStr],
  );
  if (inserted?.length) {
    await snapshotAttendance(Number(inserted[0].id), Number(rule.location_id));
    return Number(inserted[0].id);
  }
  const existing = await db.query(
    `SELECT id FROM roll_call_sessions WHERE rule_id = ? AND session_date = ?::date LIMIT 1`,
    [rule.id, dateStr],
  );
  return existing?.[0]?.id != null ? Number(existing[0].id) : null;
};

const reconcileRule = async (rule, deviceIds, now = new Date()) => {
  const parts = taipeiParts(now);
  const weekdays = Array.isArray(rule.weekdays)
    ? rule.weekdays.map((day) => Number(day))
    : [];
  if (!rule.enabled || !weekdays.includes(parts.weekday)) return;
  const startMin = timeToMinutes(rule.window_start ?? rule.windowStart);
  const endMin = timeToMinutes(rule.window_end ?? rule.windowEnd);
  if (startMin == null || endMin == null) return;
  if (parts.minutes < startMin) return;
  const sessionId = await ensureSession(rule, parts.date);
  if (!sessionId) return;
  // 開場後補齊後來才加入地點名單的應到人員
  await snapshotAttendance(sessionId, Number(rule.location_id));
  const sessionMeta = await db.query(
    `SELECT stats_reset_at FROM roll_call_sessions WHERE id = ? LIMIT 1`,
    [sessionId],
  );
  const startIso = taipeiInstant(parts.date, startMin);
  const endIso = taipeiInstant(parts.date, endMin);
  await applyFaceMatches(
    sessionId,
    deviceIds,
    startIso,
    endIso,
    sessionMeta?.[0]?.stats_reset_at || null,
  );
  if (Date.now() >= Date.parse(endIso)) {
    await closeSession(sessionId);
  }
};

const loadEnabledRules = async () => {
  const rows = await db.query(
    `SELECT r.*, ls.system_config
     FROM roll_call_rules r
     INNER JOIN location_systems ls
       ON ls.location_id = r.location_id AND ls.system_type = 'roll_call'
     WHERE r.enabled = TRUE`,
    [],
  );
  return rows || [];
};

const reconcileToday = async () => {
  const rules = await loadEnabledRules();
  for (const rule of rules) {
    try {
      await reconcileRule(rule, parseDeviceIds(rule.system_config));
    } catch (error) {
      logger.warn("時段簽到補跑失敗", {
        ruleId: rule.id,
        error: error?.message || String(error),
      });
    }
  }
};

const reconcileTodayQueued = () => enqueueReconcile(() => reconcileToday());

const countBySession = async (sessionIds) => {
  const map = new Map();
  if (!sessionIds.length) return map;
  const rows = await db.query(
    `SELECT session_id,
            COUNT(*)::int AS expected,
            COUNT(*) FILTER (WHERE status = 'present')::int AS present
     FROM roll_call_attendance
     WHERE session_id = ANY(?::int[])
     GROUP BY session_id`,
    [sessionIds],
  );
  for (const row of rows || []) {
    const expected = Number(row.expected) || 0;
    const present = Number(row.present) || 0;
    map.set(Number(row.session_id), {
      expectedCount: expected,
      presentCount: present,
      absentCount: Math.max(0, expected - present),
    });
  }
  return map;
};

/** 場次應到 → 單位格（群組即時 JOIN persons，對齊人流） */
const unitsBySession = async (sessionIds) => {
  const map = new Map();
  if (!sessionIds.length) return map;
  const rows = await db.query(
    `SELECT a.session_id,
            COALESCE(p.person_group_id, 0)::int AS group_id,
            COALESCE(NULLIF(BTRIM(MAX(pg.name)), ''), ?) AS group_name,
            COUNT(*)::int AS expected,
            COUNT(*) FILTER (WHERE a.status = 'present')::int AS present
     FROM roll_call_attendance a
     INNER JOIN persons p ON p.id = a.person_id
     LEFT JOIN person_groups pg ON pg.id = p.person_group_id
     WHERE a.session_id = ANY(?::int[])
     GROUP BY a.session_id, COALESCE(p.person_group_id, 0)`,
    [UNGROUPED_GROUP_NAME, sessionIds],
  );
  for (const row of rows || []) {
    const sid = Number(row.session_id);
    const groupId = Number(row.group_id) || UNGROUPED_GROUP_ID;
    const list = map.get(sid) || [];
    list.push({
      id: groupId,
      name:
        groupId === UNGROUPED_GROUP_ID
          ? UNGROUPED_GROUP_NAME
          : row.group_name && String(row.group_name).trim()
            ? String(row.group_name).trim()
            : UNGROUPED_GROUP_NAME,
      currentCount: Number(row.present) || 0,
      totalCount: Number(row.expected) || 0,
    });
    map.set(sid, list);
  }
  for (const [sid, list] of map.entries()) {
    list.sort((a, b) => {
      if (a.id === UNGROUPED_GROUP_ID) return 1;
      if (b.id === UNGROUPED_GROUP_ID) return -1;
      return String(a.name).localeCompare(String(b.name), "zh-Hant");
    });
    map.set(sid, list);
  }
  return map;
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

/** 地點應到名單 → 單位格（時段尚未開始預覽，同人流 groupPersonsByPersonGroup） */
const buildRosterUnits = (members) =>
  groupPersonsByPersonGroup(members).map((group) => ({
    id: group.id,
    name: group.name,
    currentCount: 0,
    totalCount: group.list.filter((person) => {
      const employeeNo =
        person.employee_no != null ? String(person.employee_no).trim() : "";
      return Boolean(employeeNo);
    }).length,
  }));

const countRosterExpected = (members) => {
  let n = 0;
  for (const person of members || []) {
    const employeeNo =
      person.employee_no != null ? String(person.employee_no).trim() : "";
    if (employeeNo) n += 1;
  }
  return n;
};

const getToday = async () => {
  await reconcileTodayQueued();
  const parts = taipeiParts();
  const locations = await db.query(
    `SELECT l.id, l.name, z.name AS zone_name, ls.system_config
     FROM locations l
     INNER JOIN zones z ON z.id = l.zone_id
     INNER JOIN location_systems ls
       ON ls.location_id = l.id AND ls.system_type = 'roll_call'
     ORDER BY z.sort_order NULLS LAST, z.name, l.sort_order NULLS LAST, l.name`,
    [],
  );
  const rules = await listRules();
  const sessions = await db.query(
    `SELECT s.*, r.name AS rule_name, r.location_id,
            r.window_start, r.window_end, r.weekdays
     FROM roll_call_sessions s
     INNER JOIN roll_call_rules r ON r.id = s.rule_id
     WHERE s.session_date = ?::date`,
    [parts.date],
  );
  const sessionIds = (sessions || []).map((row) => Number(row.id));
  const counts = await countBySession(sessionIds);
  const unitsMap = await unitsBySession(sessionIds);
  const sessionByRule = new Map(
    (sessions || []).map((row) => [Number(row.rule_id), row]),
  );

  const locationPayloads = [];
  for (const location of locations || []) {
    const locationId = Number(location.id);
    const members = await loadLocationMembers(locationId);
    const rosterExpected = countRosterExpected(members);
    const rosterUnits = buildRosterUnits(members);
    const locationRules = rules.filter(
      (rule) => rule.locationId === locationId,
    );
    const todayRules = locationRules.filter(
      (rule) => rule.enabled && rule.weekdays.includes(parts.weekday),
    );
    const sessionSummaries = todayRules.map((rule) => {
      const session = sessionByRule.get(rule.id);
      const tally = session ? counts.get(Number(session.id)) : null;
      const hasSession = Boolean(session);
      return {
        id: hasSession ? Number(session.id) : null,
        ruleId: rule.id,
        ruleName: rule.name,
        windowStart: rule.windowStart,
        windowEnd: rule.windowEnd,
        status: hasSession ? session.status : "not_started",
        sessionDate: parts.date,
        expectedCount: hasSession
          ? (tally?.expectedCount ?? 0)
          : rosterExpected,
        presentCount: hasSession ? (tally?.presentCount ?? 0) : 0,
        absentCount: hasSession
          ? (tally?.absentCount ?? 0)
          : rosterExpected,
      };
    });
    const primary = pickPrimarySession(sessionSummaries);
    const sessionUnits =
      primary?.id != null ? unitsMap.get(primary.id) || [] : [];
    const units = sessionUnits.length > 0 ? sessionUnits : rosterUnits;
    locationPayloads.push({
      locationId,
      name: location.name,
      zoneName: location.zone_name,
      deviceIds: parseDeviceIds(location.system_config),
      sessions: sessionSummaries,
      /** 對齊人流 units：id／name／currentCount／totalCount */
      units,
    });
  }

  return {
    date: parts.date,
    locations: locationPayloads,
  };
};

const resetLocationToday = async (locationId) => {
  const id = Number(locationId);
  if (!Number.isFinite(id) || id <= 0) {
    throwApiError(C.VALIDATION_REQUIRED, "地點無效");
  }
  await assertLocationIsRollCall(id);
  await reconcileTodayQueued();
  const parts = taipeiParts();
  const sessions = await db.query(
    `SELECT s.id
     FROM roll_call_sessions s
     INNER JOIN roll_call_rules r ON r.id = s.rule_id
     WHERE r.location_id = ? AND s.session_date = ?::date`,
    [id, parts.date],
  );
  const resetAt = new Date();
  for (const row of sessions || []) {
    const sessionId = Number(row.id);
    await db.query(
      `UPDATE roll_call_attendance
       SET status = 'pending', source = NULL, checked_in_at = NULL, event_id = NULL
       WHERE session_id = ?`,
      [sessionId],
    );
    await db.query(
      `UPDATE roll_call_sessions
       SET status = 'open', closed_at = NULL, stats_reset_at = ?
       WHERE id = ?`,
      [resetAt, sessionId],
    );
    await snapshotAttendance(sessionId, id);
  }
  const rules = await db.query(
    `SELECT r.*, ls.system_config
     FROM roll_call_rules r
     INNER JOIN location_systems ls
       ON ls.location_id = r.location_id AND ls.system_type = 'roll_call'
     WHERE r.location_id = ? AND r.enabled = TRUE`,
    [id],
  );
  for (const rule of rules || []) {
    try {
      await reconcileRule(rule, parseDeviceIds(rule.system_config));
    } catch (error) {
      logger.warn("時段簽到重置後補跑失敗", {
        ruleId: rule.id,
        error: error?.message || String(error),
      });
    }
  }
  return {
    resetSessionCount: (sessions || []).length,
    statsResetAt: resetAt.toISOString(),
  };
};

const getSession = async (sessionId) => {
  await reconcileTodayQueued();
  const rows = await db.query(
    `SELECT s.*, r.name AS rule_name, r.location_id,
            r.window_start, r.window_end,
            l.name AS location_name, z.name AS zone_name
     FROM roll_call_sessions s
     INNER JOIN roll_call_rules r ON r.id = s.rule_id
     INNER JOIN locations l ON l.id = r.location_id
     INNER JOIN zones z ON z.id = l.zone_id
     WHERE s.id = ?
     LIMIT 1`,
    [sessionId],
  );
  if (!rows?.length) throwApiError(C.NOT_FOUND, "找不到場次");
  const session = rows[0];
  const counts = await countBySession([Number(session.id)]);
  const tally = counts.get(Number(session.id)) || {
    expectedCount: 0,
    presentCount: 0,
    absentCount: 0,
  };
  const attendance = await db.query(
    `SELECT a.person_id, a.employee_no, a.full_name,
            p.person_group_id, pg.name AS group_name, p.face_url,
            a.status, a.source, a.checked_in_at,
            e.picture_path AS event_picture_path, e.payload AS event_payload
     FROM roll_call_attendance a
     INNER JOIN persons p ON p.id = a.person_id
     LEFT JOIN person_groups pg ON pg.id = p.person_group_id
     LEFT JOIN isapi_access_events e ON e.id = a.event_id
     WHERE a.session_id = ?
     ORDER BY
       CASE WHEN p.person_group_id IS NULL THEN 1 ELSE 0 END,
       pg.name NULLS LAST,
       a.employee_no`,
    [sessionId],
  );
  const parts = taipeiParts();
  const sessionDate = formatPgDate(session.session_date);
  return {
    id: Number(session.id),
    ruleId: Number(session.rule_id),
    ruleName: session.rule_name,
    locationId: Number(session.location_id),
    locationName: session.location_name,
    zoneName: session.zone_name,
    sessionDate,
    windowStart: formatTime(session.window_start),
    windowEnd: formatTime(session.window_end),
    status: session.status,
    canMark: sessionDate === parts.date,
    ...tally,
    attendance: (attendance || []).map((row) => {
      const groupId =
        row.person_group_id != null && Number.isFinite(Number(row.person_group_id))
          ? Number(row.person_group_id)
          : UNGROUPED_GROUP_ID;
      const photoUrl = normalizeMediaPath(row.face_url);
      const eventPayload =
        row.event_payload && typeof row.event_payload === "object" ? row.event_payload : {};
      const eventPhotoUrl = shouldDisplayAccessEventPicture(
        eventPayload,
        row.event_picture_path,
      )
        ? normalizeMediaPath(row.event_picture_path)
        : undefined;
      return {
        personId: Number(row.person_id),
        employeeNo: row.employee_no,
        fullName: row.full_name || "",
        groupId,
        groupName:
          groupId === UNGROUPED_GROUP_ID
            ? UNGROUPED_GROUP_NAME
            : row.group_name || UNGROUPED_GROUP_NAME,
        status: row.status,
        source: row.source,
        checkedInAt: row.checked_in_at,
        /** 與人流單位人員名單 photoUrl 同語意（persons.face_url） */
        photoUrl,
        /** 簽到當次門禁事件抓拍（isapi_access_events.picture_path） */
        eventPhotoUrl,
      };
    }),
  };
};

const markAttendance = async (sessionId, personId, status) => {
  if (status !== "present" && status !== "absent") {
    throwApiError(C.VALIDATION_REQUIRED, "狀態須為已簽到或未到");
  }
  const session = await getSession(sessionId);
  if (!session.canMark) {
    throwApiError(C.VALIDATION_REQUIRED, "只能更正當日名單");
  }
  const updated = await db.query(
    `UPDATE roll_call_attendance
     SET status = ?,
         source = 'manual',
         checked_in_at = CASE WHEN ? = 'present' THEN CURRENT_TIMESTAMP ELSE NULL END
     WHERE session_id = ? AND person_id = ?
     RETURNING person_id`,
    [status, status, sessionId, personId],
  );
  if (!updated?.length) throwApiError(C.NOT_FOUND, "名單中沒有這個人");
  return getSession(sessionId);
};

const getHistory = async ({ limit = 50, offset = 0, startDate, endDate, locationId } = {}) => {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const parts = taipeiParts();
  const start =
    startDate != null && String(startDate).trim() !== ""
      ? formatPgDate(startDate)
      : parts.date;
  const end =
    endDate != null && String(endDate).trim() !== ""
      ? formatPgDate(endDate)
      : parts.date;
  const locId =
    locationId != null && Number.isFinite(Number(locationId)) && Number(locationId) > 0
      ? Math.trunc(Number(locationId))
      : null;

  const params = [start, end];
  let where = `s.session_date >= ?::date AND s.session_date <= ?::date`;
  if (locId != null) {
    where += ` AND r.location_id = ?`;
    params.push(locId);
  }

  const countRows = await db.query(
    `SELECT COUNT(*)::int AS cnt
     FROM roll_call_sessions s
     INNER JOIN roll_call_rules r ON r.id = s.rule_id
     WHERE ${where}`,
    params,
  );
  const rows = await db.query(
    `SELECT s.id, s.session_date, s.status, r.name AS rule_name, r.location_id,
            l.name AS location_name, z.name AS zone_name
     FROM roll_call_sessions s
     INNER JOIN roll_call_rules r ON r.id = s.rule_id
     INNER JOIN locations l ON l.id = r.location_id
     INNER JOIN zones z ON z.id = l.zone_id
     WHERE ${where}
     ORDER BY s.session_date DESC, s.id DESC
     LIMIT ? OFFSET ?`,
    [...params, safeLimit, safeOffset],
  );
  const counts = await countBySession((rows || []).map((row) => Number(row.id)));
  return {
    total: Number(countRows?.[0]?.cnt) || 0,
    limit: safeLimit,
    offset: safeOffset,
    startDate: start,
    endDate: end,
    sessions: (rows || []).map((row) => ({
      id: Number(row.id),
      sessionDate: formatPgDate(row.session_date),
      status: row.status,
      ruleName: row.rule_name,
      locationId: Number(row.location_id),
      locationName: row.location_name,
      zoneName: row.zone_name,
      ...(counts.get(Number(row.id)) || {
        expectedCount: 0,
        presentCount: 0,
        absentCount: 0,
      }),
    })),
  };
};

/** 完整報表：區間內場次摘要＋名單列（對齊人流 Simulation 資料形狀） */
const getReport = async ({ startDate, endDate, locationId } = {}) => {
  const history = await getHistory({
    limit: 200,
    offset: 0,
    startDate,
    endDate,
    locationId,
  });
  const sessions = history.sessions || [];
  const sessionIds = sessions.map((s) => s.id);
  if (sessionIds.length === 0) {
    return { startDate: history.startDate, endDate: history.endDate, sessions: [], attendance: [] };
  }

  const sessionMeta = new Map(sessions.map((s) => [s.id, s]));
  const attendanceRows = await db.query(
    `SELECT a.session_id, a.person_id, a.employee_no, a.full_name,
            p.person_group_id, pg.name AS group_name, p.face_url,
            a.status, a.source, a.checked_in_at,
            e.picture_path AS event_picture_path, e.payload AS event_payload
     FROM roll_call_attendance a
     INNER JOIN persons p ON p.id = a.person_id
     LEFT JOIN person_groups pg ON pg.id = p.person_group_id
     LEFT JOIN isapi_access_events e ON e.id = a.event_id
     WHERE a.session_id = ANY(?::int[])
     ORDER BY a.session_id, a.employee_no`,
    [sessionIds],
  );

  const attendance = (attendanceRows || []).map((row) => {
    const sessionId = Number(row.session_id);
    const meta = sessionMeta.get(sessionId);
    const groupId =
      row.person_group_id != null && Number.isFinite(Number(row.person_group_id))
        ? Number(row.person_group_id)
        : UNGROUPED_GROUP_ID;
    const photoUrl = normalizeMediaPath(row.face_url);
    const eventPayload =
      row.event_payload && typeof row.event_payload === "object" ? row.event_payload : {};
    const eventPhotoUrl = shouldDisplayAccessEventPicture(
      eventPayload,
      row.event_picture_path,
    )
      ? normalizeMediaPath(row.event_picture_path)
      : undefined;
    return {
      sessionId,
      sessionDate: meta?.sessionDate || "",
      locationId: meta?.locationId ?? 0,
      zoneName: meta?.zoneName || "",
      locationName: meta?.locationName || "",
      ruleName: meta?.ruleName || "",
      personId: Number(row.person_id),
      employeeNo: row.employee_no || "",
      fullName: row.full_name || "",
      groupId,
      groupName:
        groupId === UNGROUPED_GROUP_ID
          ? UNGROUPED_GROUP_NAME
          : row.group_name || UNGROUPED_GROUP_NAME,
      status: row.status,
      source: row.source,
      checkedInAt: row.checked_in_at,
      photoUrl,
      eventPhotoUrl,
    };
  });

  return {
    startDate: history.startDate,
    endDate: history.endDate,
    sessions,
    attendance,
  };
};

module.exports = {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  replaceLocationRules,
  getToday,
  resetLocationToday,
  getSession,
  markAttendance,
  getHistory,
  getReport,
  reconcileTodayQueued,
};
