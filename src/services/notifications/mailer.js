const nodemailer = require("nodemailer");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());

/**
 * 建立 SMTP transporter（每規則獨立設定）
 * @param {{
 *  host: string,
 *  port: number,
 *  user?: string|null,
 *  password?: string|null,
 *  security: "none"|"ssl"|"tls",
 * }} smtp
 */
function createSmtpTransporter(smtp) {
  const host = String(smtp?.host || "").trim();
  const port = Number(smtp?.port);
  const security = String(smtp?.security || "none").toLowerCase();

  if (!host) {
    throwApiError(C.SMTP_HOST_REQUIRED, "SMTP 主機為必填");
  }
  if (!Number.isFinite(port) || port <= 0) {
    throwApiError(C.SMTP_PORT_REQUIRED, "SMTP 連接埠為必填");
  }
  if (security !== "none" && security !== "ssl" && security !== "tls") {
    throwApiError(C.SMTP_SECURITY_INVALID, "SMTP 安全模式無效");
  }

  const user = smtp?.user != null ? String(smtp.user) : "";
  const password = smtp?.password != null ? String(smtp.password) : "";

  const transporter = nodemailer.createTransport({
    host,
    port,
    // ssl: 465 常用；tls/none: STARTTLS 由 server 決定，secure=false
    secure: security === "ssl",
    auth:
      user && password
        ? {
            user,
            pass: password,
          }
        : undefined,
    // security=tls 代表強制 STARTTLS
    requireTLS: security === "tls",
    // 避免掛死（MVP）
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  return transporter;
}

/**
 * 寄出一封測試信並關閉連線（避免 transporter 長留）
 * @param {{
 *  host: string,
 *  port: number,
 *  user?: string|null,
 *  password?: string|null,
 *  security: "none"|"ssl"|"tls",
 * }} smtp
 * @param {{ to: string|string[], from?: string, subject?: string, text?: string, html?: string }} mail
 */
async function sendSmtpMailAndClose(smtp, mail) {
  const transporter = createSmtpTransporter(smtp);
  try {
    const from = mail?.from != null ? String(mail.from).trim() : "";
    const smtpUser = smtp?.user != null ? String(smtp.user).trim() : "";
    const resolvedFrom = looksLikeEmail(from)
      ? `${from} <${from}>`
      : looksLikeEmail(smtpUser)
        ? `${smtpUser} <${smtpUser}>`
        : "";
    const info = await transporter.sendMail({
      to: mail?.to,
      from: resolvedFrom || undefined,
      subject: mail?.subject != null ? String(mail.subject) : "",
      text: mail?.text != null ? String(mail.text) : undefined,
      html: mail?.html != null ? String(mail.html) : undefined,
    });
    return info;
  } finally {
    try {
      transporter.close();
    } catch {
      // ignore
    }
  }
}

module.exports = {
  createSmtpTransporter,
  sendSmtpMailAndClose,
};

