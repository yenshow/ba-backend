/**
 * Modbus 全域併發限制器（跨系統共享）
 *
 * 目的：避免 environmentMonitor / lightingMonitor / API 同時大量打 Modbus，
 * 導致大量 timeout 堆積、事件迴圈壓力上升。
 *
 * 使用：
 *   const modbusGlobalLimiter = require("./modbusGlobalLimiter");
 *   await modbusGlobalLimiter.run(() => doModbusWork());
 */

const getGlobalConcurrency = () => {
  const raw = Number(process.env.MODBUS_GLOBAL_CONCURRENCY || 12);
  if (!Number.isFinite(raw)) return 12;
  return Math.max(1, Math.floor(raw));
};

const createLimiter = (concurrency) => {
  const limit = Math.max(1, Number(concurrency) || 1);
  let activeCount = 0;
  const queue = [];

  const next = () => {
    if (activeCount >= limit) return;
    const item = queue.shift();
    if (!item) return;

    activeCount += 1;
    Promise.resolve()
      .then(item.fn)
      .then(item.resolve, item.reject)
      .finally(() => {
        activeCount -= 1;
        next();
      });
  };

  const run = (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });

  const getStats = () => ({
    concurrency: limit,
    activeCount,
    queueSize: queue.length,
  });

  return { run, getStats };
};

// 啟動時取一次，避免 runtime 反覆讀 env（需要調整時重啟服務）
const limiter = createLimiter(getGlobalConcurrency());

module.exports = limiter;

