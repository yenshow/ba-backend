/**
 * 人員門禁卡號（config.access_control.cards）解析與驗證
 */
const C = require("./apiErrorCodes");
const { throwApiError } = require("./apiErrors");

const MAX_CARDS = 5;
const VIRTUAL_CARD_PREFIX = "9";
const VIRTUAL_CARD_LENGTH = 10;
const VALID_SOURCES = new Set(["manual", "captured", "virtual"]);

const isVirtualCardFormat = (cardNo) => {
  const c = String(cardNo || "").trim();
  return (
    c.length === VIRTUAL_CARD_LENGTH &&
    c.startsWith(VIRTUAL_CARD_PREFIX) &&
    /^\d+$/.test(c)
  );
};

const normalizeSource = (raw, cardNo) => {
  const s = raw != null ? String(raw).trim() : "";
  if (VALID_SOURCES.has(s)) return s;
  return isVirtualCardFormat(cardNo) ? "virtual" : "manual";
};

const normalizeCardEntry = (entry) => {
  if (entry == null) return null;
  if (typeof entry === "string") {
    const cardNo = entry.trim();
    if (!cardNo) return null;
    return { cardNo, source: normalizeSource(null, cardNo) };
  }
  if (typeof entry !== "object") return null;
  const cardNo =
    entry.cardNo != null
      ? String(entry.cardNo).trim()
      : entry.card_no != null
        ? String(entry.card_no).trim()
        : "";
  if (!cardNo) return null;
  return {
    cardNo,
    source: normalizeSource(entry.source, cardNo),
  };
};

/** 從 access_control 物件解析卡號列表（含舊 cardNo 相容） */
const resolveAccessControlCards = (ac) => {
  if (!ac || typeof ac !== "object") return [];
  if (Array.isArray(ac.cards) && ac.cards.length > 0) {
    const out = [];
    for (const entry of ac.cards) {
      const normalized = normalizeCardEntry(entry);
      if (normalized) out.push(normalized);
    }
    if (out.length) return out;
  }
  const legacy = ac.cardNo != null ? String(ac.cardNo).trim() : "";
  if (legacy) return [{ cardNo: legacy, source: "manual" }];
  return [];
};

/** 僅卡號字串陣列 */
const resolveCardNos = (ac) =>
  resolveAccessControlCards(ac).map((c) => c.cardNo);

const validateCardEntry = (entry) => {
  const cardNo = String(entry?.cardNo ?? "").trim();
  if (!cardNo) {
    throwApiError(C.PERSONNEL_VALIDATION_FAILED, "卡號不可為空");
  }
  if (!/^\d+$/.test(cardNo)) {
    throwApiError(C.PERSONNEL_VALIDATION_FAILED, "卡號僅允許數字");
  }
  const source = normalizeSource(entry?.source, cardNo);
  if (source === "virtual") {
    if (!isVirtualCardFormat(cardNo)) {
      throwApiError(
        C.PERSONNEL_VALIDATION_FAILED,
        "虛擬卡號須為 10 碼且以 9 開頭",
      );
    }
  } else if (isVirtualCardFormat(cardNo)) {
    throwApiError(
      C.PERSONNEL_VALIDATION_FAILED,
      "此卡號格式為虛擬卡，請使用「生成虛擬卡號」",
    );
  }
  return { cardNo, source };
};

/**
 * 正規化並驗證寫入用的 cards 陣列
 * @param {Array|undefined} rawCards
 * @returns {Array<{ cardNo: string, source: string }>}
 */
const normalizeAndValidateCardsInput = (rawCards) => {
  const items = Array.isArray(rawCards)
    ? rawCards.map(normalizeCardEntry).filter(Boolean)
    : [];
  if (items.length > MAX_CARDS) {
    throwApiError(
      C.PERSONNEL_VALIDATION_FAILED,
      `卡號最多 ${MAX_CARDS} 張`,
    );
  }
  const seen = new Set();
  const validated = [];
  for (const item of items) {
    const normalized = validateCardEntry(item);
    if (seen.has(normalized.cardNo)) {
      throwApiError(C.PERSONNEL_VALIDATION_FAILED, "卡號不可重複");
    }
    seen.add(normalized.cardNo);
    validated.push(normalized);
  }
  return validated;
};

/** 寫入 config 前套用 cards，並清除舊 cardNo */
const applyCardsToAccessControl = (accessControl, cards) => {
  const ac = accessControl || {};
  if (!cards || cards.length === 0) {
    delete ac.cards;
    delete ac.cardNo;
    return ac;
  }
  ac.cards = cards;
  delete ac.cardNo;
  return ac;
};

module.exports = {
  MAX_CARDS,
  VIRTUAL_CARD_PREFIX,
  VIRTUAL_CARD_LENGTH,
  VALID_SOURCES,
  isVirtualCardFormat,
  resolveAccessControlCards,
  resolveCardNos,
  normalizeAndValidateCardsInput,
  applyCardsToAccessControl,
  validateCardEntry,
};
