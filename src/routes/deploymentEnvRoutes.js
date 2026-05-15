const express = require("express");
const fs = require("fs");
const path = require("path");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { validateRequired } = require("../middleware/validation");
const logger = require("../utils/logger");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrorMeta");

const routeLogger = logger.createLogger("deploymentEnvRoutes");

const router = express.Router();

/** 僅 JWT 角色為 `admin` 可讀寫（不含 operator／viewer）。 */

/**
 * 與 `config.js` 的 dotenv 路徑一致；`ENV_FILE` 必須落在 `process.cwd()` 目錄內，避免路徑穿越。
 */
function resolveEnvFilePath() {
  const cwd = process.cwd();
  const resolvedCwd = path.resolve(cwd);
  const raw = process.env.ENV_FILE;
  const resolvedFile = raw
    ? path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(resolvedCwd, raw)
    : path.join(resolvedCwd, ".env");
  const normalizedFile = path.resolve(resolvedFile);
  const dirWithSep = resolvedCwd.endsWith(path.sep)
    ? resolvedCwd
    : `${resolvedCwd}${path.sep}`;
  const isInside =
    normalizedFile === resolvedCwd || normalizedFile.startsWith(dirWithSep);
  if (!isInside) {
    throwApiError(
      C.DEPLOYMENT_ENV_INVALID_PATH,
      "ENV_FILE 必須解析為後端工作目錄內的路徑",
    );
  }
  return normalizedFile;
}

function stripUtf8Bom(str) {
  if (str.length > 0 && str.charCodeAt(0) === 0xfeff) {
    return str.slice(1);
  }
  return str;
}

/**
 * GET /api/deployment/env-file
 */
router.get(
  "/env-file",
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const envPath = resolveEnvFilePath();
    let content = "";
    if (fs.existsSync(envPath)) {
      content = stripUtf8Bom(fs.readFileSync(envPath, "utf8"));
    }
    res.sendSuccess({
      content,
    });
  }),
);

/**
 * PUT /api/deployment/env-file
 * Body: { content: string } — UTF-8 無 BOM 寫入；寫入前備份為 `.env.bak`（若可寫）。
 */
router.put(
  "/env-file",
  authenticate,
  requireAdmin,
  validateRequired("content"),
  asyncHandler(async (req, res) => {
    const { content } = req.body;
    if (typeof content !== "string") {
      throwApiError(C.DEPLOYMENT_ENV_CONTENT_MUST_BE_STRING, "content 必須為字串");
    }
    if (!content.trim()) {
      throwApiError(C.DEPLOYMENT_ENV_CONTENT_EMPTY, "content 不可為空白");
    }

    const envPath = resolveEnvFilePath();
    const dir = path.dirname(envPath);
    if (!fs.existsSync(dir)) {
      throwApiError(C.DEPLOYMENT_ENV_WRITE_DIR_MISSING, "無法寫入：目錄不存在", {
        statusCode: 500,
      });
    }

    if (fs.existsSync(envPath)) {
      const bakPath = `${envPath}.bak`;
      try {
        fs.copyFileSync(envPath, bakPath);
      } catch (err) {
        routeLogger.warn("備份 .env.bak 失敗，仍繼續寫入", {
          error: err?.message || String(err),
        });
      }
    }

    fs.writeFileSync(envPath, content, { encoding: "utf8" });

    routeLogger.info("已更新環境設定", {
      userId: req.user?.id,
      username: req.user?.username,
      path: envPath,
    });

    res.sendSuccess({
      message: "已寫入環境檔",
      needsPm2Restart: true,
      pm2RestartCommand: "pm2 restart ba-backend",
    });
  }),
);

module.exports = router;
