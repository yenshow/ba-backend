const express = require("express");
const path = require("path");
const fs = require("fs");
const asyncHandler = require("../utils/asyncHandler");
const { authenticateUploadRead } = require("../middleware/authMiddleware");
const C = require("../utils/apiErrorCodes");

const router = express.Router();
const uploadsRoot = path.resolve(process.cwd(), "uploads");

const resolveUploadFilePath = (requestPath) => {
  const raw = String(requestPath || "").replace(/^\/+/, "");
  const decoded = decodeURIComponent(raw);
  const normalized = path.normalize(decoded);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return null;
  }
  const absolute = path.resolve(uploadsRoot, normalized);
  if (!absolute.startsWith(uploadsRoot + path.sep) && absolute !== uploadsRoot) {
    return null;
  }
  return absolute;
};

router.get(
  /.*/,
  authenticateUploadRead,
  asyncHandler(async (req, res) => {
    const relativePath = String(req.path || "").replace(/^\/+/, "").trim();
    if (!relativePath) {
      return res.sendFailure(
        { code: C.NOT_FOUND, message: "找不到檔案", details: null },
        404,
      );
    }

    const filePath = resolveUploadFilePath(relativePath);
    if (!filePath) {
      return res.sendFailure(
        { code: C.FORBIDDEN, message: "不允許的檔案路徑", details: null },
        403,
      );
    }

    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return res.sendFailure(
        { code: C.NOT_FOUND, message: "找不到檔案", details: null },
        404,
      );
    }

    if (!stat.isFile()) {
      return res.sendFailure(
        { code: C.NOT_FOUND, message: "找不到檔案", details: null },
        404,
      );
    }

    res.sendFile(filePath);
  }),
);

module.exports = router;
