/**
 * 梯控卡片 CRUD（HCNetSDK NET_DVR_CARD_CFG_V50）
 */
const db = require("../../database/db");
const { invokeBridge } = require("./sdkBridgeClient");
const { getLadderDevice, toBridgeDevice } = require("./sdkLadderDeviceService");

const isUnsetDeviceName = (name) => {
  const value = String(name || "").trim();
  return !value || value === "(未設定)";
};

/** 部分梯控機不寫入 byName；以人員主檔補齊顯示用姓名 */
const enrichLadderCardName = async (card) => {
  if (!card || typeof card !== "object") return card;
  if (!isUnsetDeviceName(card.name)) return card;

  const cardNo = String(card.cardNo || card.card_no || "").trim();
  if (!cardNo) return card;

  const rows = await db.query(
    `SELECT p.full_name, p.employee_no
     FROM person_ladder_cards plc
     INNER JOIN persons p ON p.id = plc.person_id
     WHERE plc.card_no = ?
     LIMIT 1`,
    [cardNo],
  );
  const person = rows?.[0];
  if (!person) return card;

  const displayName = String(person.full_name || person.employee_no || "").trim();
  if (!displayName) return card;

  return { ...card, name: displayName };
};

const listCards = async (deviceId) => {
  const { credentials } = await getLadderDevice(deviceId);
  const data = await invokeBridge({
    action: "card.list",
    device: toBridgeDevice(credentials),
  });
  const cards = Array.isArray(data?.cards) ? data.cards : [];
  return {
    ...data,
    cards: await Promise.all(cards.map((card) => enrichLadderCardName(card))),
  };
};

const getCard = async (deviceId, cardNo) => {
  const { credentials } = await getLadderDevice(deviceId);
  const card = await invokeBridge({
    action: "card.get",
    device: toBridgeDevice(credentials),
    payload: { cardNo: String(cardNo) },
  });
  return enrichLadderCardName(card);
};

const createCard = async (deviceId, payload) => {
  const { credentials } = await getLadderDevice(deviceId);
  return invokeBridge({
    action: "card.create",
    device: toBridgeDevice(credentials),
    payload: normalizeCardPayload(payload),
  });
};

const updateCard = async (deviceId, cardNo, payload) => {
  const { credentials } = await getLadderDevice(deviceId);
  return invokeBridge({
    action: "card.update",
    device: toBridgeDevice(credentials),
    payload: normalizeCardPayload({ ...payload, cardNo: String(cardNo) }),
  });
};

const deleteCard = async (deviceId, cardNo) => {
  const { credentials } = await getLadderDevice(deviceId);
  return invokeBridge({
    action: "card.delete",
    device: toBridgeDevice(credentials),
    payload: { cardNo: String(cardNo) },
  });
};

const normalizeCardPayload = (payload = {}) => ({
  cardNo: payload.cardNo != null ? String(payload.cardNo) : undefined,
  floors: Array.isArray(payload.floors)
    ? payload.floors.map((f) => Number(f)).filter((f) => f > 0)
    : undefined,
  homeFloor: payload.homeFloor != null ? Number(payload.homeFloor) : undefined,
  name: payload.name != null ? String(payload.name).trim() : undefined,
  employeeNo: (() => {
    const n = Number(payload.employeeNo);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })(),
  password: payload.password,
  cardType: payload.cardType != null ? Number(payload.cardType) : undefined,
  validEnabled: Boolean(payload.validEnabled),
  validBegin: payload.validBegin,
  validEnd: payload.validEnd,
  floorMode: payload.floorMode,
});

module.exports = {
  listCards,
  getCard,
  createCard,
  updateCard,
  deleteCard,
  enrichLadderCardName,
};
