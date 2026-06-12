const db = require("../../database/db");
const logger = require("../../utils/logger");
const { sendSmtpMailAndClose } = require("../notifications/mailer");

const mailLogger = logger.createLogger("alertEmail");

const { getAlertSourceLabel } = require("../../access/catalog");

const getSeverityLabelZhTw = (severity) => {
  const s = String(severity || "")
    .trim()
    .toLowerCase();
  if (s === "critical") return "警報";
  if (s === "warning") return "異常";
  if (s === "error") return "警報";
  return s || "未知";
};

const getSourceLabelZhTw = (source) => getAlertSourceLabel(source);

const normalizeEmailList = (list) => {
  const arr = Array.isArray(list) ? list : [];
  return arr
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .slice(0, 200);
};

const toInt = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

const buildSubject = (alert) => {
  const sev = getSeverityLabelZhTw(alert?.severity);
  const src = getSourceLabelZhTw(alert?.source);
  return `[BA][${sev}] ${src}`;
};

const buildTextBody = (alert) => {
  const lines = [];
  lines.push("BA 系統警報通知");
  lines.push("");
  lines.push(`嚴重程度: ${getSeverityLabelZhTw(alert?.severity)}`);
  lines.push(`來源: ${getSourceLabelZhTw(alert?.source)}`);
  lines.push("");
  lines.push("訊息：");
  lines.push(String(alert?.message || ""));
  lines.push("");
  lines.push(`時間: ${alert?.created_at || ""}`);
  return lines.join("\n");
};

const sendAlertEmail = async ({ sub, toEmails, alert }) => {
  await sendSmtpMailAndClose(
    {
      host: sub.smtp_host,
      port: toInt(sub.smtp_port, 0),
      user: sub.smtp_user,
      password: sub.smtp_password,
      security: sub.smtp_security,
    },
    {
      to: toEmails.join(", "),
      from: sub.smtp_user,
      subject: buildSubject(alert),
      text: buildTextBody(alert),
    },
  );
};

async function notifyNewAlertByEmail(alert) {
  const alertId = Number(alert?.id);
  const ruleId = Number(alert?.rule_id);
  if (!Number.isInteger(alertId) || alertId <= 0) return;
  if (!Number.isInteger(ruleId) || ruleId <= 0) return; // 無 rule_id 不寄

  try {
    await db.transaction(async (tq) => {
      // 同 rule_id 全域節流 / 去重：用 xact advisory lock 避免併發重複寄信
      const lockRows = await tq(
        "SELECT pg_try_advisory_xact_lock(?) as locked",
        [ruleId],
      );
      const locked = Boolean(lockRows?.[0]?.locked);
      if (!locked) {
        return;
      }

      const subsRows = await tq(
        `SELECT *
         FROM alert_email_subscriptions
         WHERE rule_id = ? AND enabled = TRUE
         LIMIT 1`,
        [ruleId],
      );
      const sub = subsRows?.[0];
      if (!sub) {
        return;
      }

      const toEmails = normalizeEmailList(sub.to_emails);
      if (toEmails.length === 0) {
        return;
      }

      const minInterval = Math.max(
        15,
        toInt(sub.repeat_min_interval_seconds, 15),
      );
      const maxCount = Math.min(
        10,
        Math.max(1, toInt(sub.repeat_max_send_count, 10)),
      );

      // 同 rule_id 全域節流：任意兩封成功信最短間隔
      const throttleRows = await tq(
        `SELECT last_success_sent_at
         FROM alert_email_rule_throttle
         WHERE rule_id = ?
         LIMIT 1`,
        [ruleId],
      );
      const lastRuleSentAt = throttleRows?.[0]?.last_success_sent_at
        ? new Date(throttleRows[0].last_success_sent_at)
        : null;
      if (lastRuleSentAt) {
        const diffMs = Date.now() - lastRuleSentAt.getTime();
        if (diffMs >= 0 && diffMs < minInterval * 1000) {
          return;
        }
      }

      // alert_id + rule_id 追蹤（即便目前只在 create 時寄一次，仍保留計數/上限）
      const stateRows = await tq(
        `SELECT send_count, last_sent_at
         FROM alert_email_send_state
         WHERE alert_id = ? AND rule_id = ?
         LIMIT 1`,
        [alertId, ruleId],
      );
      const sendCount = toInt(stateRows?.[0]?.send_count, 0);
      if (sendCount >= maxCount) {
        return;
      }
      const lastSentAt = stateRows?.[0]?.last_sent_at
        ? new Date(stateRows[0].last_sent_at)
        : null;
      if (lastSentAt) {
        const diffMs = Date.now() - lastSentAt.getTime();
        if (diffMs >= 0 && diffMs < minInterval * 1000) {
          return;
        }
      }

      // 寄信（持有 advisory lock；失敗則 transaction rollback，不更新狀態）
      await sendAlertEmail({ sub, toEmails, alert });

      // upsert send_state
      await tq(
        `
        INSERT INTO alert_email_send_state (alert_id, rule_id, send_count, last_sent_at)
        VALUES (?, ?, 1, NOW())
        ON CONFLICT (alert_id, rule_id)
        DO UPDATE SET
          send_count = alert_email_send_state.send_count + 1,
          last_sent_at = NOW()
        `,
        [alertId, ruleId],
      );

      // upsert rule throttle
      await tq(
        `
        INSERT INTO alert_email_rule_throttle (rule_id, last_success_sent_at, updated_at)
        VALUES (?, NOW(), NOW())
        ON CONFLICT (rule_id)
        DO UPDATE SET
          last_success_sent_at = NOW(),
          updated_at = NOW()
        `,
        [ruleId],
      );

      mailLogger.info("Email 通知寄送成功", {
        alertId,
        ruleId,
        toCount: toEmails.length,
      });
    });
  } catch (err) {
    mailLogger.warn("Email 通知寄送失敗（不影響警報流程）", {
      alertId,
      ruleId,
      error: err?.message || String(err),
    });
  }
}

/**
 * 背景任務：同一筆 active 警報持續存在時，依間隔重送直到上限。
 * - 只掃描 status=active 且有啟用 Email 設定（rule_id）
 * - 會尊重每 rule 的全域節流（alert_email_rule_throttle）
 * - 真正寄送與計數更新仍由 notifyNewAlertByEmail() 內 transaction 控制
 */
async function processActiveAlertEmailResends({ limit = 50 } = {}) {
  const n = Number(limit);
  const safeLimit = Number.isFinite(n)
    ? Math.max(1, Math.min(500, Math.trunc(n)))
    : 50;

  try {
    const rows = await db.query(
      `
      SELECT a.*
      FROM alerts a
      JOIN alert_email_subscriptions s
        ON s.rule_id = a.rule_id AND s.enabled = TRUE
      WHERE a.status = 'active'::alert_status
        AND a.rule_id IS NOT NULL
      ORDER BY a.created_at ASC, a.id ASC
      LIMIT ?
      `,
      [safeLimit],
    );

    for (const alert of rows || []) {
      // notifyNewAlertByEmail 內部會再次 double-check（lock + throttle + last_sent_at + maxCount）
      // 這裡不 await all parallel，避免單 tick 同時打爆 SMTP
      // eslint-disable-next-line no-await-in-loop
      await notifyNewAlertByEmail(alert);
    }

    return { processed: (rows || []).length };
  } catch (err) {
    mailLogger.warn("Email 重送掃描失敗（不影響監控流程）", {
      error: err?.message || String(err),
    });
    return { processed: 0, error: err?.message || String(err) };
  }
}

module.exports = {
  notifyNewAlertByEmail,
  processActiveAlertEmailResends,
};
