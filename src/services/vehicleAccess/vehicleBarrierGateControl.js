/**
 * 車牌攝影機柵欄機控制：依 device model 分流 ISAPI
 * - YS-TCG405-E：Parking barrierGate（設備 lock=常開、unlock=常關，與對外 ctrlMode 一致）
 * - YS-46-G0：System IO outputs/1/trigger（high=常開、low=常關；open/close 為 3 秒脈衝）
 */

const MODEL_46_G0 = "YS-46-G0";
const MODEL_TCG405_E = "YS-TCG405-E";
const IO_TRIGGER_PATH = "/ISAPI/System/IO/outputs/1/trigger";
const IO_PULSE_MS = 3000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeModelName(modelName) {
  return String(modelName || "")
    .trim()
    .toUpperCase();
}

function buildParkingBarrierPath(channelId) {
  const ch =
    Number.isFinite(Number(channelId)) && Number(channelId) > 0
      ? Math.trunc(Number(channelId))
      : 1;
  return `/ISAPI/Parking/channels/${ch}/barrierGate`;
}

function buildBarrierControlXml(ctrlMode) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<BarrierGate xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">
  <ctrlMode>${ctrlMode}</ctrlMode>
</BarrierGate>`;
}

function buildIoTriggerXml(outputState) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<IOPortData>
    <outputState>${outputState}</outputState>
</IOPortData>`;
}

async function putIoOutputState(client, outputState) {
  await client.request({
    method: "PUT",
    path: IO_TRIGGER_PATH,
    data: buildIoTriggerXml(outputState),
    headers: { "Content-Type": "application/xml" },
    responseType: "text",
  });
}

/**
 * @param {import('../accessControl/isapiClient').IsapiClient} client
 * @param {'open'|'close'|'lock'|'unlock'} ctrlMode
 */
async function controlYs46G0(client, ctrlMode) {
  switch (ctrlMode) {
    case "open":
      await putIoOutputState(client, "high");
      await delay(IO_PULSE_MS);
      await putIoOutputState(client, "low");
      break;
    case "close":
      // 現場需求：關閉後維持常關（low），不可再回送 high 造成再次開啟
      await putIoOutputState(client, "low");
      break;
    case "lock":
      await putIoOutputState(client, "high");
      break;
    case "unlock":
      await putIoOutputState(client, "low");
      break;
    default:
      break;
  }
}

/**
 * @param {import('../accessControl/isapiClient').IsapiClient} client
 * @param {number} channelId
 * @param {'open'|'close'|'lock'|'unlock'} ctrlMode
 */
async function controlYsTcg405E(client, channelId, ctrlMode) {
  await client.request({
    method: "PUT",
    path: buildParkingBarrierPath(channelId),
    data: buildBarrierControlXml(ctrlMode),
    headers: { "Content-Type": "application/xml" },
    responseType: "text",
  });
}

function resolveBarrierStrategy(modelName) {
  const normalized = normalizeModelName(modelName);
  if (normalized.includes(MODEL_46_G0)) return "ys46g0";
  if (normalized.includes(MODEL_TCG405_E)) return "ystcg405e";
  return "ystcg405e";
}

/**
 * @param {object} params
 * @param {import('../accessControl/isapiClient').IsapiClient} params.client
 * @param {string} [params.modelName]
 * @param {number} params.channelId
 * @param {'open'|'close'|'lock'|'unlock'} params.ctrlMode
 */
async function executeBarrierGateControl({
  client,
  modelName,
  channelId,
  ctrlMode,
}) {
  const strategy = resolveBarrierStrategy(modelName);
  if (strategy === "ys46g0") {
    await controlYs46G0(client, ctrlMode);
    return;
  }
  await controlYsTcg405E(client, channelId, ctrlMode);
}

module.exports = {
  MODEL_46_G0,
  MODEL_TCG405_E,
  IO_PULSE_MS,
  resolveBarrierStrategy,
  executeBarrierGateControl,
};
