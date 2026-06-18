/**
 * 請求驗證中間件
 *
 * 提供統一的請求參數驗證邏輯
 */

const C = require("../utils/apiErrorCodes");

const getFieldValue = (req, field) => {
  const body = req.body || {};
  const query = req.query || {};
  const params = req.params || {};
  return body[field] ?? query[field] ?? params[field];
};

/**
 * 驗證必填參數
 * @param {...string} requiredFields - 必填欄位名稱
 * @returns {Function} Express 中間件
 */
function validateRequired(...requiredFields) {
  return (req, res, next) => {
    const missing = [];

    for (const field of requiredFields) {
      const value = getFieldValue(req, field);
      if (value === undefined || value === null || value === "") {
        missing.push(field);
      }
    }

    if (missing.length > 0) {
      return res.sendFailure(
        {
          code: C.VALIDATION_REQUIRED,
          message: `缺少必填參數: ${missing.join(", ")}`,
          details: { missing },
        },
        400,
      );
    }

    next();
  };
}

/**
 * 驗證數字參數
 * @param {...string} numberFields - 數字欄位名稱
 * @returns {Function} Express 中間件
 */
function validateNumbers(...numberFields) {
  return (req, res, next) => {
    const invalid = [];

    for (const field of numberFields) {
      const value = getFieldValue(req, field);
      if (value !== undefined && value !== null && value !== "") {
        const numValue = Number(value);
        if (isNaN(numValue) || !isFinite(numValue)) {
          invalid.push(field);
        }
      }
    }

    if (invalid.length > 0) {
      return res.sendFailure(
        {
          code: C.VALIDATION_INVALID_NUMBER,
          message: `無效的數字參數: ${invalid.join(", ")}`,
          details: { invalid },
        },
        400,
      );
    }

    next();
  };
}

/**
 * 驗證整數參數
 * @param {...string} integerFields - 整數欄位名稱
 * @returns {Function} Express 中間件
 */
function validateIntegers(...integerFields) {
  return (req, res, next) => {
    const invalid = [];

    for (const field of integerFields) {
      const value = getFieldValue(req, field);
      if (value !== undefined && value !== null && value !== "") {
        const raw = typeof value === "string" ? value.trim() : value;
        const isValidIntegerString =
          typeof raw === "string" ? /^-?\d+$/.test(raw) : Number.isInteger(raw);

        if (!isValidIntegerString) {
          invalid.push(field);
        }
      }
    }

    if (invalid.length > 0) {
      return res.sendFailure(
        {
          code: C.VALIDATION_INVALID_INTEGER,
          message: `無效的整數參數: ${invalid.join(", ")}`,
          details: { invalid },
        },
        400,
      );
    }

    next();
  };
}

module.exports = {
  validateRequired,
  validateNumbers,
  validateIntegers,
};
