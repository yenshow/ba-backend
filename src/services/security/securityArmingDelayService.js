/**
 * 保全延遲佈防：行程內進入延遲計時＋離開寬限。
 * 重啟後未完成延遲視為取消，下一 edge 重算。
 */
const { createLogger } = require("../../utils/logger");

const logger = createLogger("securityArmingDelayService");

/** @type {Map<number, boolean>} locationId → 上次是否許可（撤防） */
const lastPermittedByLocation = new Map();

/** @type {Map<number, number>} locationId → exitGraceUntilMs */
const exitGraceUntilByLocation = new Map();

/**
 * @typedef {{
 *   timer: NodeJS.Timeout,
 *   untilMs: number,
 *   systemId: number,
 *   alertType: string,
 *   dimensionKey: string|null,
 * }} EntryDelayEntry
 */

/** @type {Map<string, EntryDelayEntry>} */
const entryDelays = new Map();

function entryKey(systemId, alertType, dimensionKey) {
  return `${Number(systemId)}:${String(alertType || "")}:${dimensionKey == null ? "" : String(dimensionKey)}`;
}

/**
 * 依許可狀態更新離開寬限（撤防→佈防時啟動）
 * @param {number} locationId
 * @param {boolean} permittedNow
 * @param {{ armingMode: string, exitDelaySec: number }} arming
 * @param {number} [nowMs]
 */
function syncExitGrace(locationId, permittedNow, arming, nowMs = Date.now()) {
  const lid = Number(locationId);
  if (!Number.isFinite(lid) || lid <= 0) return;
  const prev = lastPermittedByLocation.get(lid);
  lastPermittedByLocation.set(lid, Boolean(permittedNow));

  if (permittedNow) {
    exitGraceUntilByLocation.delete(lid);
    return;
  }

  if (arming?.armingMode !== "delay") {
    exitGraceUntilByLocation.delete(lid);
    return;
  }

  const exitSec = Math.max(0, Number(arming.exitDelaySec) || 0);
  // 首次觀測（prev undefined）不啟動離開延遲，避免開機誤觸
  if (prev === true && exitSec > 0) {
    exitGraceUntilByLocation.set(lid, nowMs + exitSec * 1000);
  }
}

function isInExitGrace(locationId, nowMs = Date.now()) {
  const until = exitGraceUntilByLocation.get(Number(locationId));
  if (until == null) return false;
  if (nowMs >= until) {
    exitGraceUntilByLocation.delete(Number(locationId));
    return false;
  }
  return true;
}

/**
 * 啟動或沿用進入延遲；回傳 'pending' | 'fire_now'
 * @param {{
 *   systemId: number,
 *   alertType: string,
 *   dimensionKey?: string|null,
 *   entryDelaySec: number,
 *   onFire: () => Promise<void>|void,
 * }} opts
 */
function startOrContinueEntryDelay(opts) {
  const sid = Number(opts.systemId);
  const alertType = String(opts.alertType || "");
  const dimensionKey =
    opts.dimensionKey == null ? null : String(opts.dimensionKey);
  const delaySec = Math.max(0, Number(opts.entryDelaySec) || 0);
  const key = entryKey(sid, alertType, dimensionKey);

  if (delaySec <= 0) return "fire_now";

  const existing = entryDelays.get(key);
  if (existing) return "pending";

  const untilMs = Date.now() + delaySec * 1000;
  const timer = setTimeout(() => {
    entryDelays.delete(key);
    Promise.resolve()
      .then(() => opts.onFire())
      .catch((err) => {
        logger.warn("進入延遲逾時告警失敗", {
          error: err?.message || String(err),
          systemId: sid,
          alertType,
        });
      });
  }, delaySec * 1000);
  if (typeof timer.unref === "function") timer.unref();

  entryDelays.set(key, {
    timer,
    untilMs,
    systemId: sid,
    alertType,
    dimensionKey,
  });
  return "pending";
}

function cancelEntryDelay(systemId, alertType, dimensionKey = null) {
  const key = entryKey(systemId, alertType, dimensionKey);
  const entry = entryDelays.get(key);
  if (!entry) return false;
  clearTimeout(entry.timer);
  entryDelays.delete(key);
  return true;
}

function cancelAllEntryDelaysForSystem(systemId) {
  const sid = Number(systemId);
  let n = 0;
  for (const [key, entry] of entryDelays.entries()) {
    if (entry.systemId !== sid) continue;
    clearTimeout(entry.timer);
    entryDelays.delete(key);
    n += 1;
  }
  return n;
}

/** 測試／重啟清理 */
function resetForTests() {
  for (const entry of entryDelays.values()) clearTimeout(entry.timer);
  entryDelays.clear();
  lastPermittedByLocation.clear();
  exitGraceUntilByLocation.clear();
}

module.exports = {
  syncExitGrace,
  isInExitGrace,
  startOrContinueEntryDelay,
  cancelEntryDelay,
  cancelAllEntryDelaysForSystem,
  resetForTests,
};
