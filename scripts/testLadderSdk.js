/**
 * 梯控 SDK 本機測試腳本（透過 ba-backend/sdk bridge）
 *
 * 使用方式：npm run test:sdk-ladder-door-list
 * 參數直接改下方 CONFIG，無需設定環境變數。
 */
const { invokeBridge } = require("../src/services/ladderSdk/sdkBridgeClient");
const { enrichLadderCardName } = require("../src/services/ladderSdk/sdkCardService");

// ===== 本機測試設定（直接改這裡）=====
const CONFIG = {
  device: {
    host: "192.168.6.100",
    port: 8000,
    username: "admin",
    password: "Aa83124007", // 必填
  },
  cardNo: "1234567890",
  cardFloors: [1, 2, 3],
  cardHomeFloor: 3,
  cardName: "",
  cardEmployeeNo: 0,
  cardType: 1,
  cardFloorMode: "byte", // "byte" | "bitmap"
  gatewayIndex: 1,
  controlCommand: 1, // 0 關、1 開、2 常開、3 常閉、4 恢復、5 訪客呼梯、6 住戶呼梯
  doorLimit: 10, // door.list 筆數上限，0 = 依設備能力全部
  doorIndex: 1,
  doorName: "Floor 01",
  doorOpenDuration: 5,
};

const action = process.argv[2] || "card.list";
const device = CONFIG.device;

const run = async () => {
  if (!device.password) {
    console.error(
      "請在 scripts/testLadderSdk.js 的 CONFIG.device.password 填入密碼",
    );
    process.exit(1);
  }

  let request;
  switch (action) {
    case "card.list":
      request = { action: "card.list", device };
      break;
    case "card.get":
      request = {
        action: "card.get",
        device,
        payload: { cardNo: CONFIG.cardNo },
      };
      break;
    case "card.create":
    case "card.update":
      request = {
        action,
        device,
        payload: {
          cardNo: CONFIG.cardNo,
          floors: CONFIG.cardFloors,
          homeFloor: CONFIG.cardHomeFloor,
          name: CONFIG.cardName,
          employeeNo: CONFIG.cardEmployeeNo,
          cardType: CONFIG.cardType,
          floorMode: CONFIG.cardFloorMode,
        },
      };
      break;
    case "card.delete":
      request = {
        action: "card.delete",
        device,
        payload: { cardNo: CONFIG.cardNo },
      };
      break;
    case "control":
      request = {
        action: "control.gateway",
        device,
        payload: {
          gatewayIndex: CONFIG.gatewayIndex,
          command: CONFIG.controlCommand,
        },
      };
      break;
    case "door.list":
      request = {
        action: "door.list",
        device,
        payload: {
          limit: CONFIG.doorLimit,
        },
      };
      break;
    case "door.get":
      request = {
        action: "door.get",
        device,
        payload: { doorIndex: CONFIG.doorIndex },
      };
      break;
    case "door.set":
      request = {
        action: "door.set",
        device,
        payload: {
          doorIndex: CONFIG.doorIndex,
          name: CONFIG.doorName,
          openDuration: CONFIG.doorOpenDuration,
        },
      };
      break;
    default:
      console.error(`未知 action: ${action}`);
      process.exit(1);
  }

  let result = await invokeBridge(request);
  if (action === "card.list" && Array.isArray(result?.cards)) {
    result = {
      ...result,
      cards: await Promise.all(result.cards.map((card) => enrichLadderCardName(card))),
    };
  } else if (action === "card.get" && result) {
    result = await enrichLadderCardName(result);
  }
  console.log(JSON.stringify(result, null, 2));
};

run().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
