/**
 * ISAPI 佈防訂閱共用骨架：reconnect 迴圈、controller map、start/stop/refresh。
 * 各領域只提供 listTargets / runOnce / 狀態組裝；事件解析與 persistence 留在 domain。
 */

const RE_CONNECT_DELAY_MS = 10000;
const CRLFCRLF = Buffer.from("\r\n\r\n");
const MAX_MULTIPART_HEADER_BYTES = 64 * 1024;
const MAX_MULTIPART_BODY_BYTES = 16 * 1024 * 1024;

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
async function consumeMultipartEventStream(options) {
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
  const boundary = rawBoundary?.replace(/^["']|["']$/g, "");
  const sep = boundary ? Buffer.from(`--${boundary}`, "utf8") : null;
  const sepWithCRLF = boundary ? Buffer.from(`\r\n--${boundary}`, "utf8") : null;
  let buffer = Buffer.alloc(0);
  let spare = Buffer.alloc(0);

  const appendChunk = (chunk) => {
    // 必須複製：stream 可能重用 chunk 底層記憶體。
    if (buffer.length === 0) {
      buffer = Buffer.from(chunk);
      spare = Buffer.alloc(0);
      return;
    }
    if (spare.length < chunk.length) {
      const storage = Buffer.allocUnsafe(
        Math.max(buffer.length * 2, buffer.length + chunk.length),
      );
      buffer.copy(storage);
      spare = storage.subarray(buffer.length);
      buffer = storage.subarray(0, buffer.length);
    }
    chunk.copy(spare);
    buffer = Buffer.from(
      buffer.buffer,
      buffer.byteOffset,
      buffer.length + chunk.length,
    );
    spare = spare.subarray(chunk.length);
  };

  const assertPartSize = (length, limit, name) => {
    if (length > limit) {
      const error = new Error(`ISAPI multipart ${name} exceeds ${limit} bytes`);
      onPartError?.(error);
      throw error;
    }
  };

  const readPart = () => {
    const startsWithBoundary = buffer.subarray(0, sep.length).equals(sep);
    const start = startsWithBoundary ? 0 : buffer.indexOf(sepWithCRLF);
    if (start < 0) {
      // 保留可能跨 chunk 的 boundary 前綴。
      buffer = buffer.subarray(Math.max(0, buffer.length - sepWithCRLF.length + 1));
      return null;
    }
    buffer = buffer.subarray(start);
    const skip = startsWithBoundary ? sep.length : sepWithCRLF.length;
    if (buffer[skip] === 0x2d && buffer[skip + 1] === 0x2d) {
      buffer = Buffer.alloc(0);
      return null;
    }

    const afterBoundary = buffer.subarray(skip);
    const headEnd = afterBoundary.indexOf(CRLFCRLF);
    if (headEnd === -1) {
      assertPartSize(afterBoundary.length, MAX_MULTIPART_HEADER_BYTES + 3, "header");
      return null;
    }
    assertPartSize(headEnd, MAX_MULTIPART_HEADER_BYTES, "header");
    const headerStr = afterBoundary.subarray(0, headEnd).toString("utf8");
    const bodyStart = skip + headEnd + CRLFCRLF.length;
    const length = preferContentLength
      ? Number(headerStr.match(/Content-Length:\s*(\d+)/i)?.[1] ?? 0)
      : 0;
    if (length > 0) {
      assertPartSize(length, MAX_MULTIPART_BODY_BYTES, "body");
      const bodyEnd = bodyStart + length;
      if (bodyEnd > buffer.length) return null;
      const body = buffer.subarray(bodyStart, bodyEnd);
      buffer = buffer.subarray(bodyEnd);
      return { headerStr, body };
    }

    let next = buffer.indexOf(sepWithCRLF, bodyStart);
    if (next === -1) next = buffer.indexOf(sep, bodyStart);
    if (next === -1) {
      assertPartSize(
        buffer.length - bodyStart,
        MAX_MULTIPART_BODY_BYTES + sepWithCRLF.length,
        "body",
      );
      return null;
    }
    assertPartSize(next - bodyStart, MAX_MULTIPART_BODY_BYTES, "body");
    const body = buffer.subarray(bodyStart, next);
    buffer = buffer.subarray(next);
    return { headerStr, body };
  };

  const abortError = new Error("ABORTED");
  const abortHandler = () => stream.destroy(abortError);
  abortSignal?.addEventListener("abort", abortHandler, { once: true });
  try {
    if (abortSignal?.aborted) {
      stream.destroy();
      throw abortError;
    }
    for await (const chunk of stream) {
      if (!boundary) continue;
      appendChunk(chunk);
      // Await persistence before reading more chunks so the stream can apply backpressure.
      while (buffer.length > 0) {
        if (abortSignal?.aborted) throw abortError;
        const part = readPart();
        if (!part) break;
        try {
          await onPart(part.headerStr, part.body);
        } catch (error) {
          onPartError?.(error);
        }
      }
    }
  } catch (error) {
    if (abortSignal?.aborted) throw abortError;
    if (error?.code !== "ERR_STREAM_PREMATURE_CLOSE") throw error;
  } finally {
    abortSignal?.removeEventListener("abort", abortHandler);
  }
  try {
    if (boundary) await onBeforeResolve?.();
  } catch (_error) {
    // Stream completion remains successful if final bookkeeping fails.
  }
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
