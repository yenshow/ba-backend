/**
 * 虛擬卡號產生（10 碼：9 + 9 位隨機數字）
 */
const crypto = require("crypto");
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const {
  VIRTUAL_CARD_LENGTH,
  VIRTUAL_CARD_PREFIX,
  resolveAccessControlCards,
} = require("../../utils/accessControlCardsUtils");

const MAX_GENERATE_ATTEMPTS = 30;

const parsePersonConfig = (raw) => {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? raw : {};
};

const collectVirtualCardNosFromRows = (rows) => {
  const set = new Set();
  for (const row of rows || []) {
    const config = parsePersonConfig(row?.config);
    const ac = config?.access_control || {};
    for (const card of resolveAccessControlCards(ac)) {
      if (card.source === "virtual" && card.cardNo) {
        set.add(card.cardNo);
      }
    }
  }
  return set;
};

const loadExistingVirtualCardNos = async () => {
  const rows = await db.query(
    `SELECT config FROM persons WHERE config IS NOT NULL`,
  );
  return collectVirtualCardNosFromRows(rows);
};

const randomVirtualCardNo = () => {
  const suffix = crypto.randomInt(0, 1_000_000_000);
  return `${VIRTUAL_CARD_PREFIX}${String(suffix).padStart(9, "0")}`;
};

const generateVirtualCard = async () => {
  const existing = await loadExistingVirtualCardNos();
  for (let i = 0; i < MAX_GENERATE_ATTEMPTS; i++) {
    const cardNo = randomVirtualCardNo();
    if (cardNo.length !== VIRTUAL_CARD_LENGTH) continue;
    if (!existing.has(cardNo)) {
      return { cardNo, source: "virtual" };
    }
  }
  throwApiError(
    C.PERSONNEL_VALIDATION_FAILED,
    "虛擬卡號產生失敗，請稍後再試",
  );
};

module.exports = {
  generateVirtualCard,
  loadExistingVirtualCardNos,
  collectVirtualCardNosFromRows,
};
