/**
 * DI/DO／bit 解析 SSOT（照明／HVAC 快照、diDoMonitor edge）
 * - modbus_config：points[] type／registerType／method；diAddress／doAddress；裸 address→DO
 * - status_points：僅 discrete／coil（排水馬達等）→ 營運事件 edge
 */

/**
 * @param {string} raw
 * @returns {"discrete" | "coil" | null}
 */
function normalizeBitRegisterType(raw) {
  const t = String(raw || "")
    .toLowerCase()
    .trim();
  if (
    t === "di" ||
    t === "discrete" ||
    t === "discreteinput" ||
    t === "discrete_input"
  ) {
    return "discrete";
  }
  if (t === "do" || t === "coil") return "coil";
  return null;
}

/**
 * @param {unknown} point
 * @returns {"di" | "do" | null}
 */
function pointKind(point) {
  if (!point || typeof point !== "object") return null;

  const fromType = normalizeBitRegisterType(point.type);
  if (fromType) return fromType === "coil" ? "do" : "di";

  const fromRt = normalizeBitRegisterType(point.registerType);
  if (fromRt) return fromRt === "coil" ? "do" : "di";

  const method = String(point.method || "").toLowerCase();
  if (
    method === "writecoil" ||
    method === "writecoils" ||
    method === "getcoils" ||
    method === "readcoils"
  ) {
    return "do";
  }
  if (
    method === "getdiscreteinputs" ||
    method === "readdiscreteinputs" ||
    method === "getdiscreteinput"
  ) {
    return "di";
  }
  return null;
}

/** @param {unknown[]} list */
function minFiniteNumber(list) {
  const nums = (Array.isArray(list) ? list : [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
  return nums.length > 0 ? Math.min(...nums) : null;
}

/**
 * @param {unknown} modbus
 * @returns {{ di: { registerType: string, address: number } | null, do: { registerType: string, address: number } | null }}
 */
function resolveDiDoParts(modbus) {
  const cfg = modbus && typeof modbus === "object" ? modbus : {};
  const points = Array.isArray(cfg.points) ? cfg.points : [];

  const findAddr = (want) => {
    const p = points.find(
      (x) => pointKind(x) === want && Number.isFinite(Number(x?.address)),
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
  if (doAddr == null) doAddr = minFiniteNumber(cfg.doAddresses);
  if (diAddr == null) diAddr = minFiniteNumber(cfg.diAddresses);

  if (
    doAddr == null &&
    diAddr == null &&
    Number.isFinite(Number(cfg.address))
  ) {
    doAddr = Number(cfg.address);
  }

  return {
    do: doAddr != null ? { registerType: "coil", address: doAddr } : null,
    di: diAddr != null ? { registerType: "discrete", address: diAddr } : null,
  };
}

function collectLightingDiDoReadSpecs(modbusConfigRaw) {
  const { di, do: doPart } = resolveDiDoParts(modbusConfigRaw);
  const specs = [];
  if (doPart) specs.push({ ...doPart, pointKey: "do" });
  if (di) specs.push({ ...di, pointKey: "di" });
  return specs;
}

function pickPrimaryDiDoBitRead(modbus) {
  const { di, do: doPart } = resolveDiDoParts(modbus);
  if (di) return { registerType: di.registerType, address: di.address };
  if (doPart) return { registerType: doPart.registerType, address: doPart.address };
  return null;
}

/**
 * @param {unknown} statusPoints
 * @param {number|null} defaultDeviceId
 */
function collectBitPointsFromStatusPoints(statusPoints, defaultDeviceId) {
  const out = [];
  if (!statusPoints || typeof statusPoints !== "object") return out;

  for (const [role, def] of Object.entries(statusPoints)) {
    if (!def || typeof def !== "object") continue;
    const registerType = normalizeBitRegisterType(
      def.registerType || def.type,
    );
    if (!registerType) continue;

    const address = Number(def.address);
    if (!Number.isFinite(address) || address < 0) continue;

    let deviceId = defaultDeviceId;
    if (def.deviceId != null && def.deviceId !== "") {
      const own = Number(def.deviceId);
      if (Number.isFinite(own) && own > 0) deviceId = own;
    }
    if (!deviceId) continue;

    const kind = registerType === "discrete" ? "di" : "do";
    out.push({
      deviceId,
      bitKey: `${kind}:${address}`,
      registerType,
      address,
      role: String(role),
    });
  }
  return out;
}

/**
 * @param {unknown} systemConfig
 * @returns {Array<{ deviceId: number, bitKey: string, registerType: string, address: number, role: string }>}
 */
function collectConfiguredBitPointsFromSystemConfig(systemConfig) {
  const cfg =
    systemConfig && typeof systemConfig === "object" ? systemConfig : {};
  const primary = Number(
    Array.isArray(cfg.device_ids) ? cfg.device_ids[0] : NaN,
  );
  const defaultDeviceId =
    Number.isFinite(primary) && primary > 0 ? primary : null;

  const byKey = new Map();
  const add = (p) => {
    if (!p?.deviceId || !p.bitKey) return;
    const k = `${p.deviceId}:${p.bitKey}`;
    if (!byKey.has(k)) byKey.set(k, p);
  };

  if (cfg.modbus_config && defaultDeviceId) {
    const { di, do: doPart } = resolveDiDoParts(cfg.modbus_config);
    if (di) {
      add({
        deviceId: defaultDeviceId,
        bitKey: `di:${di.address}`,
        registerType: di.registerType,
        address: di.address,
        role: "modbus_di",
      });
    }
    if (doPart) {
      add({
        deviceId: defaultDeviceId,
        bitKey: `do:${doPart.address}`,
        registerType: doPart.registerType,
        address: doPart.address,
        role: "modbus_do",
      });
    }
  }

  for (const p of collectBitPointsFromStatusPoints(
    cfg.status_points,
    defaultDeviceId,
  )) {
    add(p);
  }

  return [...byKey.values()];
}

module.exports = {
  resolveDiDoParts,
  collectLightingDiDoReadSpecs,
  pickPrimaryDiDoBitRead,
  collectConfiguredBitPointsFromSystemConfig,
};
