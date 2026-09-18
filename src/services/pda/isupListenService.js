/**
 * ISUP 5.0 常駐監聽：spawn IsupCmsBridge，將 type=scan 寫入 pda_scan_events。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("../../config");
const logger = require("../../utils/logger").createLogger("ISUP Listen");
const pdaScanService = require("./pdaScanService");

const BRIDGE_EXE_NAME = "IsupCmsBridge.exe";
const RECONNECT_DELAY_MS = 10_000;
const DEFAULT_EXE = path.join(
  process.cwd(),
  "sdk",
  "dotnet",
  "isup-bridge",
  "bin",
  "Release",
  "net8.0",
  "win-x64",
  BRIDGE_EXE_NAME,
);

let child = null;
let stopping = false;
let restartTimer = null;
let stdoutBuffer = "";

const state = {
  running: false,
  cmsReady: false,
  alarmReady: false,
  deviceId: null,
  deviceIp: null,
  lastScanAt: null,
  lastError: null,
};

const resetRuntimeState = () => {
  state.running = false;
  state.cmsReady = false;
  state.alarmReady = false;
  state.deviceId = null;
  state.deviceIp = null;
};

const resolveBridgeExe = () => {
  const configured = config.isup?.bridgeExePath;
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  return fs.existsSync(DEFAULT_EXE) ? DEFAULT_EXE : null;
};

const getStatus = () => ({
  ...state,
  enabled: Boolean(config.isup?.key),
  listenPort: config.isup?.listenPort,
  alarmPort: config.isup?.alarmPort,
  advertiseIp: config.isup?.advertiseIp,
});

const handleMessage = async (message) => {
  switch (message?.type) {
    case "scan": {
      const saved = await pdaScanService.ingestScan({
        deviceCode: message.deviceCode,
        barcode: message.barcode,
        scannedAt: message.scannedAt,
      });
      state.lastScanAt = saved.scanned_at;
      state.lastError = null;
      logger.info("ISUP 掃碼已入庫", {
        id: saved.id,
        deviceCode: saved.device_code,
        barcode: saved.barcode,
      });
      return;
    }
    case "ready":
      if (message.mode === "isup_cms") {
        state.cmsReady = true;
        logger.info("ISUP CMS 已就緒", { listenPort: message.listenPort });
      } else if (message.mode === "isup_alarm") {
        state.alarmReady = true;
        logger.info("ISUP 告警已就緒", { alarmPort: message.alarmPort });
      }
      return;
    case "online":
      state.deviceId = message.deviceId || null;
      state.deviceIp = message.deviceIp || null;
      logger.info("PDA ISUP 上線", {
        deviceId: message.deviceId,
        deviceIp: message.deviceIp,
      });
      return;
    case "offline":
      logger.warn("PDA ISUP 離線", { deviceId: message.deviceId || state.deviceId });
      state.deviceId = null;
      state.deviceIp = null;
      return;
    case "error":
    case "warn":
      state.lastError = message.message || "ISUP 錯誤";
      logger.error("ISUP bridge 錯誤", { message: state.lastError });
      return;
    default:
      return;
  }
};

const consumeStdout = (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  const lines = stdoutBuffer.split(/\r?\n/);
  stdoutBuffer = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const message = JSON.parse(trimmed);
      void handleMessage(message).catch((error) => {
        logger.warn("ISUP 事件處理失敗", {
          error: error?.message || String(error),
        });
      });
    } catch {
      // native SDK 可能夾雜非 JSON
    }
  }
};

const stopChild = () => {
  if (!child) {
    return;
  }
  const current = child;
  child = null;
  try {
    current.kill();
  } catch {
    // ignore
  }
};

const scheduleRestart = () => {
  if (stopping || restartTimer) {
    return;
  }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!stopping) {
      spawnBridge();
    }
  }, RECONNECT_DELAY_MS);
};

const spawnBridge = () => {
  if (stopping || child) {
    return;
  }

  const exePath = resolveBridgeExe();
  if (!exePath) {
    state.lastError = "找不到 IsupCmsBridge.exe";
    logger.warn("找不到 IsupCmsBridge.exe，請先執行 npm run sdk:build-isup", {
      expected: DEFAULT_EXE,
    });
    return;
  }

  const isup = config.isup;
  stdoutBuffer = "";
  child = spawn(exePath, [], {
    cwd: path.dirname(exePath),
    env: {
      ...process.env,
      ISUP_KEY: isup.key,
      ISUP_LISTEN_IP: isup.listenIp,
      ISUP_LISTEN_PORT: String(isup.listenPort),
      ISUP_ALARM_PORT: String(isup.alarmPort),
      ISUP_ADVERTISE_IP: isup.advertiseIp,
      ISUP_ALARM_PROTOCOL: isup.alarmProtocol,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  state.running = true;
  state.lastError = null;
  child.stdout.on("data", consumeStdout);
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      logger.warn("ISUP bridge stderr", { text: text.slice(0, 500) });
    }
  });
  child.on("error", (error) => {
    state.lastError = error.message;
    logger.error("ISUP bridge 無法啟動", { error: error.message });
  });
  child.on("close", (code) => {
    resetRuntimeState();
    child = null;
    if (!stopping) {
      logger.warn("ISUP bridge 結束，將重連", { code });
      scheduleRestart();
    }
  });
};

const start = () => {
  if (!config.isup?.key) {
    logger.warn("未設定 ISUP_KEY，略過 ISUP 掃碼監聽");
    return;
  }
  if (child || restartTimer) {
    return;
  }
  stopping = false;
  logger.info("啟動 ISUP 掃碼監聽", {
    listenPort: config.isup.listenPort,
    alarmPort: config.isup.alarmPort,
    advertiseIp: config.isup.advertiseIp,
  });
  spawnBridge();
};

const stop = () => {
  stopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  stopChild();
  resetRuntimeState();
};

module.exports = {
  start,
  stop,
  getStatus,
};
