/**
 * 統一日誌工具：LOG_LEVEL + DEBUG 相容
 */

const LOG_LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const normalizeLogLevel = () => {
  const raw = String(process.env.LOG_LEVEL || "").trim().toLowerCase();
  if (raw in LOG_LEVELS) return raw;
  return "info";
};

const resolvedLogLevel = normalizeLogLevel();
const isDebugEnabled =
  process.env.DEBUG === "true" || resolvedLogLevel === "debug";

const shouldLog = (level) => {
  if (resolvedLogLevel === "silent") return false;
  if (level === "debug") return isDebugEnabled;
  return LOG_LEVELS[level] <= LOG_LEVELS[resolvedLogLevel];
};

const formatPrefix = (level, module) => {
  const timestamp = new Date().toISOString();
  const levelUpper = level.toUpperCase().padEnd(5);
  const moduleName = module ? `[${module}]` : "";
  return `${timestamp} ${levelUpper} ${moduleName}`;
};

const stripModuleFromMeta = (meta) => {
  if (!meta || typeof meta !== "object") return {};
  if (!("module" in meta)) return meta;
  const { module: _module, ...rest } = meta;
  return rest;
};

const normalizeMeta = (meta = {}) => {
  const metaForPrint = stripModuleFromMeta(meta);
  if (!metaForPrint || typeof metaForPrint !== "object") return {};
  if (metaForPrint.error instanceof Error) {
    return {
      ...metaForPrint,
      error: {
        name: metaForPrint.error.name,
        message: metaForPrint.error.message,
        stack: metaForPrint.error.stack,
      },
    };
  }
  return metaForPrint;
};

const writeLog = (level, consoleFn, message, meta = {}) => {
  if (!shouldLog(level)) return;
  const prefix = formatPrefix(level, meta.module);
  const metaForPrint = normalizeMeta(meta);
  const hasMeta = Object.keys(metaForPrint).length > 0;
  consoleFn(`${prefix} ${message}`, hasMeta ? metaForPrint : "");
};

function error(message, meta = {}) {
  writeLog("error", console.error, message, meta);
}

function warn(message, meta = {}) {
  writeLog("warn", console.warn, message, meta);
}

function info(message, meta = {}) {
  writeLog("info", console.log, message, meta);
}

function debug(message, meta = {}) {
  writeLog("debug", console.log, message, meta);
}

function createLogger(moduleName) {
  return {
    error: (message, meta = {}) => error(message, { ...meta, module: moduleName }),
    warn: (message, meta = {}) => warn(message, { ...meta, module: moduleName }),
    info: (message, meta = {}) => info(message, { ...meta, module: moduleName }),
    debug: (message, meta = {}) => debug(message, { ...meta, module: moduleName }),
  };
}

module.exports = {
  error,
  warn,
  info,
  debug,
  createLogger,
  shouldLog,
};
