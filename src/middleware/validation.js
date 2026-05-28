/**
 * 請求驗證中間件
 * 
 * 提供統一的請求參數驗證邏輯
 */

const C = require("../utils/apiErrorCodes");

/**
 * 驗證必填參數
 * @param {...string} requiredFields - 必填欄位名稱
 * @returns {Function} Express 中間件
 */
function validateRequired(...requiredFields) {
  return (req, res, next) => {
    const missing = [];
    const body = req.body || {};
    const query = req.query || {};
    const params = req.params || {};

    // 檢查每個必填欄位
    for (const field of requiredFields) {
      // 優先檢查 body，然後是 query，最後是 params
      const value = body[field] ?? query[field] ?? params[field];

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
    const body = req.body || {};
    const query = req.query || {};
    const params = req.params || {};

    for (const field of numberFields) {
      const value = body[field] ?? query[field] ?? params[field];

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
    const body = req.body || {};
    const query = req.query || {};
    const params = req.params || {};

    for (const field of integerFields) {
      const value = body[field] ?? query[field] ?? params[field];

      if (value !== undefined && value !== null && value !== "") {
        // 允許 number / string；string 先 trim，並以正規式判斷是否為「純整數」
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

/**
 * 驗證參數是否為有效的枚舉值
 * @param {string} field - 欄位名稱
 * @param {Array} allowedValues - 允許的值列表
 * @returns {Function} Express 中間件
 */
function validateEnum(field, allowedValues) {
  return (req, res, next) => {
    const body = req.body || {};
    const query = req.query || {};
    const params = req.params || {};

    const value = body[field] ?? query[field] ?? params[field];

    if (value !== undefined && value !== null && value !== "") {
      if (!allowedValues.includes(value)) {
        return res.sendFailure(
          {
            code: C.VALIDATION_INVALID_ENUM,
            message: `參數 ${field} 的值必須是以下之一: ${allowedValues.join(", ")}`,
            details: { field, value, allowedValues },
          },
          400,
        );
      }
    }

    next();
  };
}

/**
 * 驗證日期參數
 * @param {...string} dateFields - 日期欄位名稱
 * @returns {Function} Express 中間件
 */
function validateDates(...dateFields) {
  return (req, res, next) => {
    const invalid = [];
    const body = req.body || {};
    const query = req.query || {};
    const params = req.params || {};

    for (const field of dateFields) {
      const value = body[field] ?? query[field] ?? params[field];

      if (value !== undefined && value !== null && value !== "") {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          invalid.push(field);
        }
      }
    }

    if (invalid.length > 0) {
      return res.sendFailure(
        {
          code: C.VALIDATION_INVALID_DATE,
          message: `無效的日期參數: ${invalid.join(", ")}`,
          details: { invalid },
        },
        400,
      );
    }

    next();
  };
}

/**
 * 自定義驗證函數
 * @param {Function} validator - 驗證函數 (req) => { valid: boolean, message?: string }
 * @returns {Function} Express 中間件
 */
function validateCustom(validator) {
  return (req, res, next) => {
    const result = validator(req);

    if (!result.valid) {
      return res.sendFailure(
        {
          code: C.VALIDATION_CUSTOM,
          message: result.message || "驗證失敗",
          details: null,
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
  validateEnum,
  validateDates,
  validateCustom,
};
