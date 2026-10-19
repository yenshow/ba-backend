/**
 * ISAPI 佈防訂閱共用骨架：reconnect 迴圈、controller map、start/stop/refresh。
 * 各領域只提供 listTargets / runOnce / 狀態組裝；事件解析與 persistence 留在 domain。
 */

const RE_CONNECT_DELAY_MS = 10000;
const CRLFCRLF = Buffer.from("\r\n\r\n");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error) {
  if (!error) return false;
  if (error.code === "ABORTED") return true;
  return String(error.message || "").includes("ABORTED");
}

/**
 * multipart/mixed 串流：依 boundary 切 part，交由 onPart 處理。
 * @param {object} options
 * @param {import("stream").Readable} options.stream
 * @param {string} options.contentType
 * @param {AbortSignal} [options.abortSignal]
 * @param {(headerStr: string, body: Buffer) => void|Promise<void>} options.onPart
 * @param {(error: Error) => void} [options.onPartError]
 * @param {() => void|Promise<void>} [options.onBeforeResolve]
 * @param {boolean} [options.preferContentLength=true] 有 Content-Length 時先依長度切 body（門禁／人流）；車輛搜下一 boundary
 */
function consumeMultipartEventStream(options) {
  const {
    stream,
    contentType,
    abortSignal,
    onPart,
    onPartError,
    onBeforeResolve,
    preferContentLength = true,
  } = options;

  const boundaryMatch = String(contentType || "").match(
    /boundary=(?:"([^"]+)"|([^\s;]+))/i,
  );
  const rawBoundary = boundaryMatch
    ? (boundaryMatch[1] || boundaryMatch[2]).trim()
    : null;
  if (!rawBoundary) {
    return new Promise((resolve, reject) => {
      stream.on("data", () => {});
      stream.on("error", reject);
      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
    });
  }

  const boundary = rawBoundary.replace(/^["']|["']$/g, "");
  const sep = Buffer.from(`--${boundary}`, "utf8");
  const sepWithCRLF = Buffer.from(`\r\n--${boundary}`, "utf8");
  let buffer = Buffer.alloc(0);
  let partQueue = Promise.resolve();

  const enqueuePart = (headerStr, body) => {
    partQueue = partQueue
      .then(() => onPart(headerStr, body))
      .catch((err) => {
        if (typeof onPartError === "function") {
          onPartError(err);
        }
      });
  };

  const tryConsumeOnePart = () => {
    let start = buffer.indexOf(sepWithCRLF);
    let skip = sepWithCRLF.length;
    if (start === -1) {
      if (
        buffer.length >= sep.length &&
        buffer.slice(0, sep.length).equals(sep)
      ) {
        start = 0;
        skip = sep.length;
      } else {
        return false;
      }
    } else if (start > 0) {
      buffer = buffer.slice(start);
      start = 0;
      skip = sepWithCRLF.length;
    }

    const afterBoundary = buffer.slice(skip);
    const headEnd = afterBoundary.indexOf(CRLFCRLF);
    if (headEnd === -1) return false;
    const headerStr = afterBoundary.slice(0, headEnd).toString("utf8");
    const bodyStart = skip + headEnd + CRLFCRLF.length;
    let bodyEnd;

    if (preferContentLength) {
      const contentLengthMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
      const contentLength = contentLengthMatch
        ? parseInt(contentLengthMatch[1], 10)
        : 0;
      if (contentLength > 0) {
        bodyEnd = bodyStart + contentLength;
        if (bodyEnd > buffer.length) return false;
      } else {
        const nextB = buffer.indexOf(sepWithCRLF, bodyStart);
        const nextB2 = buffer.indexOf(sep, bodyStart);
        const next =
          nextB !== -1
            ? nextB2 !== -1
              ? Math.min(nextB, nextB2)
              : nextB
            : nextB2;
        if (next === -1) return false;
        bodyEnd = next;
        const trim =
          buffer[bodyEnd - 1] === 0x0a && buffer[bodyEnd - 2] === 0x0d ? 2 : 0;
        if (trim) bodyEnd -= trim;
      }
      const body = buffer.slice(bodyStart, bodyEnd);
      enqueuePart(headerStr, body);
      buffer = buffer.slice(bodyEnd);
      return true;
    }

    let next = buffer.indexOf(sepWithCRLF, bodyStart);
    if (next === -1) next = buffer.indexOf(sep, bodyStart);
    if (next === -1) return false;
    bodyEnd = next;
    if (buffer[bodyEnd - 1] === 0x0a && buffer[bodyEnd - 2] === 0x0d) {
      bodyEnd -= 2;
    }
    const body = buffer.slice(bodyStart, bodyEnd);
    enqueuePart(headerStr, body);
    buffer = buffer.slice(next);
    return true;
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const done = () => {
        Promise.resolve(onBeforeResolve ? onBeforeResolve() : undefined)
          .catch(() => {})
          .then(() => resolve());
      };
      partQueue.then(done).catch(done);
    };

    const abortHandler = () => {
      try {
        stream.destroy(new Error("ABORTED"));
      } catch (_e) {
        /* ignore */
      }
    };
    if (abortSignal) {
      if (abortSignal.aborted) abortHandler();
      else abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length > 0 && tryConsumeOnePart()) {}
      if (buffer.length > 1024 * 1024) buffer = buffer.slice(-512 * 1024);
    });
    stream.on("error", reject);
    stream.on("end", finish);
    stream.on("close", finish);
  });
}

/**
 * @template T
 * @param {object} options
 * @param {object} options.logger
 * @param {(target: T) => string|number} options.keyOf
 * @param {() => Promise<T[]>} options.listTargets
 * @param {(target: T, abortSignal: AbortSignal) => Promise<void>} options.runOnce
 * @param {"eager"|"strict"} [options.refreshPolicy="eager"]
 *   eager：refresh 時若未 started 則設為 true（門禁／人流）
 *   strict：未 start 時 refresh 直接回傳空（車輛）
 * @param {number} [options.reconnectDelayMs]
 * @param {(target: T) => void} [options.onStreamEnded]
 * @param {(target: T, error: Error) => void} [options.onReconnectError]
 * @param {(info: { targets: T[], toStart: T[], toStop: T[] }) => void} [options.onRefresh]
 * @param {(state: { started: boolean, targets: T[] }) => object} [options.buildStatus]
 * @param {(state: { started: boolean, targets: T[] }) => object} [options.buildRefreshResult]
 */
function createSubscribeManager(options) {
  const {
    logger,
    keyOf,
    listTargets,
    runOnce,
    refreshPolicy = "eager",
    reconnectDelayMs = RE_CONNECT_DELAY_MS,
    onStreamEnded,
    onReconnectError,
    onRefresh,
    buildStatus,
    buildRefreshResult,
  } = options;

  /** @type {Map<string|number, { controller: AbortController, startedAt: number }>} */
  const controllers = new Map();
  let started = false;
  /** @type {T[]} */
  let runningTargets = [];

  async function runReconnectLoop(target, abortSignal) {
    for (;;) {
      if (abortSignal?.aborted) return;
      try {
        await runOnce(target, abortSignal);
        if (abortSignal?.aborted) return;
        if (typeof onStreamEnded === "function") {
          onStreamEnded(target);
        }
      } catch (error) {
        if (abortSignal?.aborted) return;
        if (isAbortError(error)) return;
        if (typeof onReconnectError === "function") {
          onReconnectError(target, error);
        } else if (logger?.warn) {
          logger.warn("[ISAPI] 訂閱連線中斷，將重連", {
            error: error?.message || String(error),
            statusCode: error?.statusCode ?? null,
          });
        }
      }
      if (abortSignal?.aborted) return;
      await delay(reconnectDelayMs);
    }
  }

  function startLoopForTarget(target) {
    const key = keyOf(target);
    if (controllers.has(key)) return;
    const controller = new AbortController();
    controllers.set(key, { controller, startedAt: Date.now() });
    void runReconnectLoop(target, controller.signal);
  }

  function stopLoopForTarget(target) {
    const key = keyOf(target);
    const entry = controllers.get(key);
    if (!entry) return;
    try {
      entry.controller.abort();
    } catch (_e) {
      /* ignore */
    }
    controllers.delete(key);
  }

  function stopAllLoops() {
    for (const target of [...runningTargets]) {
      stopLoopForTarget(target);
    }
    for (const key of [...controllers.keys()]) {
      const entry = controllers.get(key);
      if (!entry) continue;
      try {
        entry.controller.abort();
      } catch (_e) {
        /* ignore */
      }
      controllers.delete(key);
    }
    runningTargets = [];
  }

  async function refresh() {
    if (!started) {
      if (refreshPolicy === "strict") {
        const empty = { started: false, targets: [] };
        return typeof buildRefreshResult === "function"
          ? buildRefreshResult(empty)
          : empty;
      }
      started = true;
    }

    const targets = await listTargets();
    const nextKeys = new Set(targets.map(keyOf));
    const prevKeys = new Set(runningTargets.map(keyOf));

    const toStart = targets.filter((t) => !prevKeys.has(keyOf(t)));
    const toStop = runningTargets.filter((t) => !nextKeys.has(keyOf(t)));

    for (const target of toStop) stopLoopForTarget(target);
    for (const target of toStart) startLoopForTarget(target);

    runningTargets = targets;

    if (typeof onRefresh === "function") {
      onRefresh({ targets, toStart, toStop });
    }

    const state = { started: true, targets: [...runningTargets] };
    return typeof buildRefreshResult === "function"
      ? buildRefreshResult(state)
      : state;
  }

  async function start() {
    if (started) return;
    await refresh();
  }

  /**
   * 先標記 started 再執行 hook，最後 refresh（車輛 fan-out 回填用）。
   * @param {() => Promise<void>} [beforeRefresh]
   */
  async function startWithBeforeRefresh(beforeRefresh) {
    if (started) return;
    started = true;
    if (typeof beforeRefresh === "function") {
      await beforeRefresh();
    }
    await refresh();
  }

  function stop() {
    started = false;
    stopAllLoops();
  }

  function getSubscribeStatus() {
    const state = { started, targets: [...runningTargets] };
    return typeof buildStatus === "function" ? buildStatus(state) : state;
  }

  function getStarted() {
    return started;
  }

  function getRunningTargets() {
    return [...runningTargets];
  }

  return {
    start,
    startWithBeforeRefresh,
    stop,
    refresh,
    getSubscribeStatus,
    getStarted,
    getRunningTargets,
  };
}

module.exports = {
  consumeMultipartEventStream,
  createSubscribeManager,
};
