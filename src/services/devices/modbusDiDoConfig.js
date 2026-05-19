/**
 * modbus_config 內 DI/DO 解析（SSOT）
 * - points[]：`type` di|do + `address`
 * - 精簡：`diAddress` / `doAddress`
 * - 單一 `address`：視為 DO 線圈（與既有 lighting / hvac 行為一致）
 *
 * 照明：可同時讀 DO+DI；HVAC 主 bit：優先 DI 再 DO（與原 `extractPrimaryBitPoint` 一致）
 */

/**
 * @param {unknown} modbus
 * @returns {{ di: { registerType: string, address: number } | null, do: { registerType: string, address: number } | null }}
 */
function resolveDiDoParts(modbus) {
  const cfg = modbus && typeof modbus === "object" ? modbus : {};
  const points = Array.isArray(cfg.points) ? cfg.points : [];

  const findAddr = (typeLower) => {
    const p = points.find(
      (x) =>
        String(x?.type || "").toLowerCase() === typeLower &&
        Number.isFinite(Number(x.address)),
    );
    return p != null ? Number(p.address) : null;
  };

  let doAddr = findAddr("do");
  let diAddr = findAddr("di");

  if (doAddr == null && Number.isFinite(Number(cfg.doAddress))) {
    doAddr = Number(cfg.doAddress);
  }
  if (diAddr == null && Number.isFinite(Number(cfg.diAddress))) {
    diAddr = Number(cfg.diAddress);
  }

  if (
    doAddr == null &&
    diAddr == null &&
    Number.isFinite(Number(cfg.address))
  ) {
    doAddr = Number(cfg.address);
  }

  const doPart =
    doAddr != null
      ? { registerType: "coil", address: doAddr }
      : null;
  const diPart =
    diAddr != null
      ? { registerType: "discrete", address: diAddr }
      : null;

  return { di: diPart, do: doPart };
}

/** 照明快照：讀取順序 DO → DI（`pointKey` 供 merge） */
function collectLightingDiDoReadSpecs(modbusConfigRaw) {
  const { di, do: doPart } = resolveDiDoParts(modbusConfigRaw);
  const specs = [];
  if (doPart) {
    specs.push({ ...doPart, pointKey: "do" });
  }
  if (di) {
    specs.push({ ...di, pointKey: "di" });
  }
  return specs;
}

/** HVAC：擇一主 bit（DI 優先） */
function pickPrimaryDiDoBitRead(modbus) {
  const { di, do: doPart } = resolveDiDoParts(modbus);
  if (di) {
    return { registerType: di.registerType, address: di.address };
  }
  if (doPart) {
    return { registerType: doPart.registerType, address: doPart.address };
  }
  return null;
}

module.exports = {
  collectLightingDiDoReadSpecs,
  pickPrimaryDiDoBitRead,
};
