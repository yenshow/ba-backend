/**
 * 固定併發上限的批次 worker（順序保留）
 * @param {Array} items
 * @param {(item: unknown, index: number) => Promise<unknown>} worker
 * @param {{ concurrency?: number }} [options]
 */
async function mapWithConcurrency(items, worker, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(
    1,
    Number(options.concurrency) > 0 ? Math.trunc(Number(options.concurrency)) : 8,
  );
  const results = new Array(list.length);
  let idx = 0;
  const runners = new Array(Math.min(concurrency, list.length))
    .fill(null)
    .map(async () => {
      while (idx < list.length) {
        const my = idx++;
        try {
          results[my] = await worker(list[my], my);
        } catch (e) {
          results[my] = {
            ok: false,
            error: e?.message || String(e),
            code: e?.code || null,
          };
        }
      }
    });
  await Promise.all(runners);
  return results;
}

module.exports = {
  mapWithConcurrency,
};
