const { AsyncLocalStorage } = require("node:async_hooks");
const { randomUUID } = require("node:crypto");

const storage = new AsyncLocalStorage();

function auditContext(req, res, next) {
  const requestId = randomUUID();
  res.setHeader("X-Request-Id", requestId);
  storage.run({ req, requestId }, next);
}

function getAuditContext() {
  const context = storage.getStore();
  const actor = context?.req.user;
  if (!actor || /^(GET|HEAD|OPTIONS)$/.test(context.req.method)) return null;

  const reason = context.req.body?.reason;
  return {
    actorId: String(actor.id),
    actorUsername: actor.username || "",
    requestId: context.requestId,
    reason: typeof reason === "string" ? reason.trim().slice(0, 500) : "",
  };
}

module.exports = { auditContext, getAuditContext };
