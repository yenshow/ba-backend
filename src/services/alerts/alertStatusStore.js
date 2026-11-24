const db = require("../../database/db");

async function transitionAlerts(alertIds, expectedStatus, newStatus, { userId = null, reason } = {}) {
  const eventType = newStatus === "active" ? "unignored" : newStatus;
  return db.query(
    `WITH changed AS (
       UPDATE alerts a
       SET status = next.status,
           ignored_at = CASE WHEN next.status = 'ignored' THEN CURRENT_TIMESTAMP END,
           ignored_by = CASE WHEN next.status = 'ignored' THEN next.actor_id END,
           updated_at = CURRENT_TIMESTAMP
       FROM (SELECT ?::alert_status AS status, ?::integer AS actor_id) next
       WHERE a.id = ANY(?::integer[]) AND a.status = ?::alert_status
       RETURNING a.*
     ), events AS (
       INSERT INTO alert_events (alert_id, event_type, old_status, new_status, payload, actor_user_id)
       SELECT id, ?, ?::alert_status, status,
              jsonb_build_object(
                'source', source, 'source_id', source_id,
                'alert_type', alert_type, 'dimension_key', dimension_key
              ) || ?::jsonb,
              ?
       FROM changed
       RETURNING alert_id
     )
     SELECT changed.*, u.username AS ignored_by_username
     FROM changed
     JOIN events ON events.alert_id = changed.id
     LEFT JOIN users u ON changed.ignored_by = u.id`,
    [
      newStatus, userId, alertIds, expectedStatus, eventType, expectedStatus,
      JSON.stringify(reason ? { reason } : {}), userId,
    ],
  );
}

async function reopenAlert(id, userId = null) {
  const [alert] = await db.query(
    `WITH target AS (
       SELECT id, status AS previous_status
       FROM alerts WHERE id = ?
       FOR UPDATE
     ), changed AS (
       UPDATE alerts a
       SET status = 'active', ignored_at = NULL, ignored_by = NULL
       FROM target t
       WHERE a.id = t.id
       RETURNING a.*, t.previous_status
     ), events AS (
       INSERT INTO alert_events (alert_id, event_type, old_status, new_status, payload, actor_user_id)
       SELECT id, 'unresolved', previous_status, status,
              jsonb_build_object('reason', 'manual_unresolve'), ?
       FROM changed
       WHERE previous_status <> 'active'
     )
     SELECT * FROM changed`,
    [id, userId],
  );
  if (!alert) return null;
  const { previous_status: previousStatus, ...row } = alert;
  return { alert: row, previousStatus };
}

async function closeAlertsForDailyRollover() {
  return db.transaction(async (query) => {
    const [counts] = await query(
      `WITH targets AS (
         SELECT id, status AS old_status
         FROM alerts
         WHERE status IN ('active', 'ignored')
         ORDER BY id
         FOR UPDATE
       ), closing AS (
         UPDATE alerts a
         SET status = 'resolved',
             ignored_at = NULL,
             ignored_by = NULL,
             updated_at = CURRENT_TIMESTAMP
         FROM targets t
         WHERE a.id = t.id AND a.status = t.old_status
         RETURNING a.id, t.old_status
       ), events AS (
         INSERT INTO alert_events (alert_id, event_type, old_status, new_status, payload)
         SELECT id, 'resolved', old_status, 'resolved',
                jsonb_build_object('reason', CASE WHEN old_status = 'active'
                  THEN 'daily_rollover' ELSE 'daily_rollover_ignored' END)
         FROM closing
         RETURNING old_status
       )
       SELECT count(*) FILTER (WHERE old_status = 'active')::int AS active_count,
              count(*) FILTER (WHERE old_status = 'ignored')::int AS ignored_count
       FROM events`,
    );
    return { activeCount: counts.active_count, ignoredCount: counts.ignored_count };
  });
}

module.exports = { transitionAlerts, reopenAlert, closeAlertsForDailyRollover };
