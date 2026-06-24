/**
 * 進出統計（Entry/Exit/Presence）共用演算法
 * SSOT：docs/30-contracts/entry-exit-stats.md
 */

/**
 * transition 策略（狀態切換 + 在場 = 最後為 entry）
 *
 * @param {Array} events
 * @param {object} options
 * @param {(event: *) => string|null|undefined} options.getKey - 主體識別（空則略過）
 * @param {(event: *) => 'entry'|'exit'|null|undefined} options.getDirection
 * @param {(event: *) => Date|string|number} [options.getTime] - 用於排序；預設不排序（呼叫端可先排序）
 * @param {boolean} [options.sortByTime=true]
 * @returns {{ entryCount: number, exitCount: number, currentCount: number }}
 */
function computeTransitionStats(events, options) {
  const {
    getKey,
    getDirection,
    getTime = (e) => e,
    sortByTime = true,
  } = options;

  if (!events?.length) {
    return { entryCount: 0, exitCount: 0, currentCount: 0 };
  }

  let list = [...events];
  if (sortByTime) {
    list.sort(
      (a, b) => new Date(getTime(a)).getTime() - new Date(getTime(b)).getTime(),
    );
  }

  /** @type {Map<string, 'entry'|'exit'>} */
  const lastByKey = new Map();
  let entryCount = 0;
  let exitCount = 0;

  for (const event of list) {
    const keyRaw = getKey(event);
    const key =
      keyRaw != null && String(keyRaw).trim() !== ""
        ? String(keyRaw).trim()
        : "";
    if (!key) continue;

    const dir = getDirection(event);
    if (dir !== "entry" && dir !== "exit") continue;

    const prev = lastByKey.get(key);
    if (prev === undefined && dir === "exit") continue;
    if (prev !== dir) {
      if (dir === "entry") entryCount += 1;
      else exitCount += 1;
    }
    lastByKey.set(key, dir);
  }

  let currentCount = 0;
  for (const dir of lastByKey.values()) {
    if (dir === "entry") currentCount += 1;
  }

  return { entryCount, exitCount, currentCount };
}

/**
 * cumulative 策略（設備累計 enter/exit）
 *
 * @param {number} entryCount
 * @param {number} exitCount
 * @returns {{ entryCount: number, exitCount: number, currentCount: number }}
 */
function computeCumulativeStats(entryCount, exitCount) {
  const ent = Math.max(0, Math.trunc(Number(entryCount) || 0));
  const ex = Math.max(0, Math.trunc(Number(exitCount) || 0));
  return {
    entryCount: ent,
    exitCount: ex,
    currentCount: Math.max(0, ent - ex),
  };
}

/**
 * @param {Array<{ entryCount?: number, exitCount?: number }>} parts
 */
function sumCumulativeParts(parts) {
  let entryCount = 0;
  let exitCount = 0;
  for (const p of parts || []) {
    entryCount += Math.max(0, Math.trunc(Number(p.entryCount) || 0));
    exitCount += Math.max(0, Math.trunc(Number(p.exitCount) || 0));
  }
  return computeCumulativeStats(entryCount, exitCount);
}

/**
 * 單一人員在營運日內的在場狀態（與 computeTransitionStats / currentCount 口徑一致）
 *
 * @param {Array} events - 該人員在營運日內的進出事件
 * @param {object} options
 * @param {(event: *) => 'entry'|'exit'|null|undefined} options.getDirection
 * @param {(event: *) => Date|string|number} options.getTime
 * @param {boolean} [options.sortByTime=true]
 * @returns {{
 *   isInside: boolean,
 *   lastEntryTime: Date|null,
 *   lastExitTime: Date|null,
 * }}
 */
function resolvePersonPresenceFromEvents(events, options) {
  const { getDirection, getTime, sortByTime = true } = options;

  let list = [...(events || [])];
  if (sortByTime) {
    list.sort(
      (a, b) => new Date(getTime(a)).getTime() - new Date(getTime(b)).getTime(),
    );
  }

  /** @type {'entry'|'exit'|undefined} */
  let lastState;
  let lastEntryTime = null;
  let lastExitTime = null;

  for (const event of list) {
    const dir = getDirection(event);
    if (dir !== "entry" && dir !== "exit") continue;

    const ts = new Date(getTime(event));
    if (lastState === undefined && dir === "exit") continue;

    if (dir === "entry") lastEntryTime = ts;
    else lastExitTime = ts;

    lastState = dir;
  }

  return {
    isInside: lastState === "entry",
    lastEntryTime,
    lastExitTime,
  };
}

module.exports = {
  computeTransitionStats,
  computeCumulativeStats,
  sumCumulativeParts,
  resolvePersonPresenceFromEvents,
};

