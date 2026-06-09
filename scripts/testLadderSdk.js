/**
 * 梯控 SDK 本機測試腳本（透過 ba-backend/sdk bridge）
 *
 * 環境變數：
 *   SDK_DEVICE_HOST, SDK_DEVICE_PORT, SDK_DEVICE_USER, SDK_DEVICE_PASS
 *   SDK_CARD_NO, SDK_CARD_FLOORS, SDK_GATEWAY_INDEX, SDK_CONTROL_COMMAND
 */
const { invokeBridge } = require("../src/services/ladderSdk/sdkBridgeClient");

const action = process.argv[2] || "card.list";

const device = {
  host: process.env.SDK_DEVICE_HOST || "192.168.6.100",
  port: Number(process.env.SDK_DEVICE_PORT) || 8000,
  username: process.env.SDK_DEVICE_USER || "admin",
  password: process.env.SDK_DEVICE_PASS || "",
};

const run = async () => {
  if (!device.password) {
    console.error("請設定 SDK_DEVICE_PASS");
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
        payload: { cardNo: process.env.SDK_CARD_NO || "1234567890" },
      };
      break;
    case "card.create":
    case "card.update":
      request = {
        action,
        device,
        payload: {
          cardNo: process.env.SDK_CARD_NO || "1234567890",
          floors: (process.env.SDK_CARD_FLOORS || "1,2,3")
            .split(",")
            .map((v) => Number(v.trim()))
            .filter((v) => v > 0),
          homeFloor: Number(process.env.SDK_CARD_HOME_FLOOR) || 3,
          name: process.env.SDK_CARD_NAME || "",
          employeeNo: Number(process.env.SDK_CARD_EMPLOYEE_NO) || 0,
          cardType: Number(process.env.SDK_CARD_TYPE) || 1,
          floorMode: process.env.SDK_CARD_FLOOR_MODE || "byte",
        },
      };
      break;
    case "card.delete":
      request = {
        action: "card.delete",
        device,
        payload: { cardNo: process.env.SDK_CARD_NO || "1234567890" },
      };
      break;
    case "control":
      request = {
        action: "control.gateway",
        device,
        payload: {
          gatewayIndex: Number(process.env.SDK_GATEWAY_INDEX) || 1,
          command: Number(process.env.SDK_CONTROL_COMMAND) || 1,
        },
      };
      break;
    default:
      console.error(`未知 action: ${action}`);
      process.exit(1);
  }

  const result = await invokeBridge(request);
  console.log(JSON.stringify(result, null, 2));
};

run().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
