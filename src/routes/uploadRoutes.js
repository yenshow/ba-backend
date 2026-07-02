const express = require("express");
const fs = require("fs");
const asyncHandler = require("../utils/asyncHandler");
const { authenticateUploadRead } = require("../middleware/authMiddleware");
const C = require("../utils/apiErrorCodes");
const {
  decodeUploadRequestPath,
  resolveUploadRelativePath,
} = require("../utils/baDataPaths");

const router = express.Router();

router.get(
  /.*/,
  authenticateUploadRead,
  asyncHandler(async (req, res) => {
    const relativePath = decodeUploadRequestPath(req.path);
    if (!relativePath) {
      return res.sendFailure(
        { code: C.NOT_FOUND, message: "找不到檔案", details: null },
        404,
      );
    }

    const filePath = resolveUploadRelativePath(relativePath);
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
