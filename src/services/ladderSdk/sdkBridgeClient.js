/**
 * HCNetSDK Bridge 客戶端（呼叫 ba-backend/sdk/dotnet/bridge）
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("../../config");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrorMeta");
const logger = require("../../utils/logger").createLogger("Ladder SDK Bridge");

const BRIDGE_EXE_NAME = "HcNetSdkBridge.exe";
const DEFAULT_TIMEOUT_MS = 90_000;

const resolveBridgeExe = () => {
  const configured = config.ladderSdk?.bridgeExePath;
  if (configured && fs.existsSync(configured)) {
    return configured;
  }

  const candidate = path.join(
    process.cwd(),
    "sdk",
    "dotnet",
    "bridge",
    "bin",
    "Release",
    "net8.0",
    "win-x64",
    BRIDGE_EXE_NAME,
  );

  if (fs.existsSync(candidate)) {
    return candidate;
  }

  throw createApiError(
    C.LADDER_SDK_BRIDGE_NOT_FOUND,
    "找不到 HcNetSdkBridge.exe，請先執行 sdk/scripts/run-bridge.ps1 建置",
  );
};

const ensureSdkDlls = (exePath) => {
  const dir = path.dirname(exePath);
  const dllPath = path.join(dir, "HCNetSDK.dll");
  if (fs.existsSync(dllPath)) {
    return dir;
  }

  const sdkLib = path.join(process.cwd(), "sdk", "hcnet-sdk", "lib");
  if (!fs.existsSync(path.join(sdkLib, "HCNetSDK.dll"))) {
    throw createApiError(
      C.LADDER_SDK_RUNTIME_MISSING,
      "找不到 HCNetSDK.dll，請確認 ba-backend/sdk/hcnet-sdk/lib 已就緒",
    );
  }

  return dir;
};

const BRIDGE_CODE_MAP = {
  LOGIN_FAILED: C.LADDER_SDK_LOGIN_FAILED,
  CARD_NOT_FOUND: C.LADDER_SDK_CARD_NOT_FOUND,
  CARD_READ_FAILED: C.LADDER_SDK_CARD_READ_FAILED,
  CARD_WRITE_FAILED: C.LADDER_SDK_CARD_WRITE_FAILED,
  CONTROL_FAILED: C.LADDER_SDK_CONTROL_FAILED,
  INVALID_GATEWAY: C.LADDER_SDK_INVALID_GATEWAY,
  CARD_NO_REQUIRED: C.VALIDATION_CUSTOM,
  INVALID_PAYLOAD: C.VALIDATION_CUSTOM,
  DEVICE_INCOMPLETE: C.LADDER_SDK_CONFIG_INCOMPLETE,
  UNKNOWN_ACTION: C.BAD_REQUEST,
};

const mapBridgeError = (response) => {
  const bridgeCode = response?.code || "LADDER_SDK_ERROR";
  const apiCode = BRIDGE_CODE_MAP[bridgeCode] || C.LADDER_SDK_ERROR;
  const message = response?.message || "HCNetSDK 操作失敗";

  throw createApiError(apiCode, message, {
    details: response?.data ?? null,
  });
};

const invokeBridge = (request, options = {}) =>
  new Promise((resolve, reject) => {
    let exePath;
    try {
      exePath = resolveBridgeExe();
      ensureSdkDlls(exePath);
    } catch (error) {
      reject(error);
      return;
    }

    const cwd = path.dirname(exePath);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const env = {
      ...process.env,
      HCNETSDK_ROOT:
        process.env.HCNETSDK_ROOT ||
        config.ladderSdk?.hcnetSdkRoot ||
        path.join(process.cwd(), "sdk", "hcnet-sdk"),
    };

    const child = spawn(exePath, [], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(reject, createApiError(C.LADDER_SDK_TIMEOUT, "HCNetSDK 操作逾時"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      finish(
        reject,
        createApiError(C.LADDER_SDK_BRIDGE_FAILED, error.message, { stderr }),
      );
    });

    child.on("close", (code) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        finish(
          reject,
          createApiError(C.LADDER_SDK_BRIDGE_FAILED, stderr || "Bridge 無回應", {
            exitCode: code,
          }),
        );
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        finish(
          reject,
          createApiError(C.LADDER_SDK_BRIDGE_FAILED, "Bridge 回應非 JSON", {
            stdout: trimmed.slice(0, 500),
            stderr,
          }),
        );
        return;
      }

      if (!parsed.ok) {
        finish(reject, mapBridgeError(parsed));
        return;
      }

      finish(resolve, parsed.data ?? null);
    });

    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });

const spawnArmingProcess = (deviceCredentials, handlers = {}) => {
  const exePath = resolveBridgeExe();
  ensureSdkDlls(exePath);
  const cwd = path.dirname(exePath);

  const env = {
    ...process.env,
    HCNETSDK_ROOT:
      process.env.HCNETSDK_ROOT ||
      config.ladderSdk?.hcnetSdkRoot ||
      path.join(process.cwd(), "sdk", "hcnet-sdk"),
    SDK_DEVICE_HOST: deviceCredentials.host,
    SDK_DEVICE_PORT: String(deviceCredentials.port ?? 8000),
    SDK_DEVICE_USER: deviceCredentials.username,
    SDK_DEVICE_PASS: deviceCredentials.password,
  };

  const child = spawn(exePath, ["--arming"], {
    cwd,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed);
        if (message.type === "event" && typeof handlers.onEvent === "function") {
          handlers.onEvent(message);
        } else if (
          message.type === "ready" &&
          typeof handlers.onReady === "function"
        ) {
          handlers.onReady(message);
        } else if (
          message.type === "error" &&
          typeof handlers.onError === "function"
        ) {
          handlers.onError(message);
        } else if (
          message.type === "stopped" &&
          typeof handlers.onStopped === "function"
        ) {
          handlers.onStopped(message);
        }
      } catch (error) {
        logger.warn("佈防訊息解析失敗", { line: trimmed.slice(0, 200) });
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    logger.warn("佈防 stderr", { text: chunk.toString("utf8").trim() });
  });

  child.on("close", (code) => {
    if (typeof handlers.onClose === "function") {
      handlers.onClose(code);
    }
  });

  return child;
};

module.exports = {
  invokeBridge,
  spawnArmingProcess,
  resolveBridgeExe,
};
