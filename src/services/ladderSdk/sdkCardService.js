/**
 * 梯控卡片 CRUD（HCNetSDK NET_DVR_CARD_CFG_V50）
 */
const { invokeBridge } = require("./sdkBridgeClient");
const { getLadderDevice, toBridgeDevice } = require("./sdkLadderDeviceService");

const listCards = async (deviceId) => {
  const { credentials } = await getLadderDevice(deviceId);
  return invokeBridge({
    action: "card.list",
    device: toBridgeDevice(credentials),
  });
};

const getCard = async (deviceId, cardNo) => {
  const { credentials } = await getLadderDevice(deviceId);
  return invokeBridge({
    action: "card.get",
    device: toBridgeDevice(credentials),
    payload: { cardNo: String(cardNo) },
  });
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
  name: payload.name,
  employeeNo: payload.employeeNo != null ? Number(payload.employeeNo) : undefined,
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
};
