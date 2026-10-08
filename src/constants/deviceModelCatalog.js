/**
 * 產品設備型號 catalog SSOT。
 *
 * 生產階段在本檔維護型號；產品首次初始化只新增不存在的型號，
 * 不覆寫產品現場既有資料。未指定 description 時，會以「<型別名>預設型號」補上。
 */
const { getDeviceTypeName } = require("./deviceTypes");

/** @param {string} name */
const visIndoorModel = (name) => ({
  name,
  typeCode: "video_intercom",
  port: 8000,
  description: "VIS 室內機",
  config: { unitType: "indoor", sipPort: 5060 },
});

const DEVICE_MODEL_CATALOG = [
  { name: "YS AC-02F", typeCode: "access_control" },
  { name: "YS AC-07", typeCode: "access_control" },
  {
    name: "YS K1T105AM",
    typeCode: "access_control",
    description: "純刷卡門禁機",
    config: {
      credentials: { face: false, fingerprint: false, card: true },
    },
  },
  {
    name: "YS 9503",
    typeCode: "video_intercom",
    port: 8000,
    description: "VIS 管理中心主機",
    config: { unitType: "manage" },
  },
  visIndoorModel("YS-KH6350-WTE1"),
  visIndoorModel("YS-9510-WTE1"),
  visIndoorModel("YS-8520-WTE1"),
  visIndoorModel("YS-KH8380-WTE1"),
  {
    name: "YS-K2210",
    typeCode: "controller",
    port: 8000,
    description: "HCNetSDK 梯控控制器",
    config: { protocol: "hcnet_sdk" },
  },
  {
    name: "ZC160",
    typeCode: "controller",
    port: 502,
    description: "Modbus DI/DO 控制器",
  },
  {
    name: "展廳測試",
    typeCode: "sensor",
    description: "展廳環境品質感測器",
    config: {
      registerType: "holding",
      sensorParameters: [
        { type: "pm25", modbusConfig: { address: 0, transform: "value - 1" } },
        { type: "pm10", modbusConfig: { address: 1, transform: "value - 1" } },
        {
          type: "tvoc",
          modbusConfig: { address: 2, transform: "value / 1000" },
        },
        { type: "hcho", modbusConfig: { address: 3 } },
        {
          type: "humidity",
          modbusConfig: { address: 4, transform: "value / 10" },
        },
        {
          type: "temperature",
          modbusConfig: { address: 5, transform: "value / 10" },
        },
        { type: "co2", modbusConfig: { address: 6 } },
        { type: "noise", modbusConfig: { address: 11 } },
      ],
    },
  },
  {
    name: "風速計",
    typeCode: "sensor",
    description: "Modbus 風速感測器",
    config: {
      registerType: "holding",
      sensorParameters: [
        {
          type: "wind",
          modbusConfig: { address: 0, transform: "value *10/32767" },
        },
      ],
    },
  },
  {
    name: "數位電表範例（A21 FLOAT）",
    typeCode: "sensor",
    description:
      "A21-06-ADP-33 對照範例（Holding／IEEE-754 BE；請依實際型號調整）",
    config: {
      registerType: "holding",
      meterKind: "electricity",
      sensorParameters: [
        {
          type: "active_energy",
          modbusConfig: {
            address: 0x1400,
            length: 4,
            dataType: "float64_be",
            transform: "value",
          },
        },
        {
          type: "total_energy",
          modbusConfig: {
            address: 0x1408,
            length: 4,
            dataType: "float64_be",
            transform: "value",
          },
        },
        {
          type: "export_energy",
          modbusConfig: {
            address: 0x1404,
            length: 4,
            dataType: "float64_be",
            transform: "value",
          },
        },
        {
          type: "active_power",
          modbusConfig: {
            address: 0x1032,
            length: 2,
            dataType: "float32_be",
            transform: "value / 1000",
          },
        },
        {
          type: "reactive_power",
          modbusConfig: {
            address: 0x103a,
            length: 2,
            dataType: "float32_be",
            transform: "value / 1000",
          },
        },
        {
          type: "apparent_power",
          modbusConfig: {
            address: 0x1042,
            length: 2,
            dataType: "float32_be",
            transform: "value / 1000",
          },
        },
        {
          type: "demand",
          modbusConfig: {
            address: 0x3006,
            length: 2,
            dataType: "float32_be",
            transform: "value / 1000",
          },
        },
        {
          type: "voltage_v1",
          modbusConfig: {
            address: 0x1000,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "voltage_v2",
          modbusConfig: {
            address: 0x1002,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "voltage_v3",
          modbusConfig: {
            address: 0x1004,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "voltage_avg",
          modbusConfig: {
            address: 0x1006,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "current_i1",
          modbusConfig: {
            address: 0x1010,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "current_i2",
          modbusConfig: {
            address: 0x1012,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "current_i3",
          modbusConfig: {
            address: 0x1014,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "current_avg",
          modbusConfig: {
            address: 0x1016,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "pf_1",
          modbusConfig: {
            address: 0x101c,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "pf_2",
          modbusConfig: {
            address: 0x101e,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "pf_3",
          modbusConfig: {
            address: 0x1020,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "pf_avg",
          modbusConfig: {
            address: 0x1022,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "active_power_p1",
          modbusConfig: {
            address: 0x102c,
            length: 2,
            dataType: "float32_be",
            transform: "value / 1000",
          },
        },
        {
          type: "active_power_p2",
          modbusConfig: {
            address: 0x102e,
            length: 2,
            dataType: "float32_be",
            transform: "value / 1000",
          },
        },
        {
          type: "active_power_p3",
          modbusConfig: {
            address: 0x1030,
            length: 2,
            dataType: "float32_be",
            transform: "value / 1000",
          },
        },
        {
          type: "frequency",
          modbusConfig: {
            address: 0x101a,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "load_type",
          modbusConfig: {
            address: 0x10a0,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "run_hour",
          modbusConfig: {
            address: 0x0f00,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "co2",
          modbusConfig: {
            address: 0x0f06,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
        {
          type: "cost",
          modbusConfig: {
            address: 0x0f08,
            length: 2,
            dataType: "float32_be",
            transform: "value",
          },
        },
      ],
    },
  },
  {
    name: "數位水表範例",
    typeCode: "sensor",
    description: "能源管理水表範例（請依實際暫存器修改）",
    config: {
      registerType: "holding",
      meterKind: "water",
      sensorParameters: [
        {
          type: "water_volume",
          modbusConfig: {
            address: 0,
            length: 2,
            dataType: "uint32_be",
            transform: "value / 1000",
          },
        },
      ],
    },
  },
  {
    name: "TP-Link",
    typeCode: "camera",
    description: "通用 RTSP 攝影機",
    config: {
      rtsp_url_template: "rtsp://{username}:{password}@{ip}:554/stream2",
    },
  },
  {
    name: "YS-2CD3046G2H-IU",
    typeCode: "camera",
    categoryCode: "people_counting",
  },
  { name: "YS-47-G0", typeCode: "camera", categoryCode: "people_counting" },
  {
    name: "YS-46-G0",
    typeCode: "camera",
    categoryCode: "license_plate_recognition",
  },
  {
    name: "YS-TCG405-E",
    typeCode: "camera",
    categoryCode: "license_plate_recognition",
  },
  {
    name: "YS-2CD3021G0-IU(2.8mm)",
    typeCode: "camera",
    categoryCode: "surveillance_2mp",
  },
  {
    name: "YS-2CD3321G2-IUF",
    typeCode: "camera",
    categoryCode: "surveillance_2mp",
  },
  {
    name: "YS-2CD3T43G2-2ISU",
    typeCode: "camera",
    categoryCode: "surveillance_2mp",
  },
  {
    name: "YS-2CD3047G2E-LUF",
    typeCode: "camera",
    categoryCode: "surveillance_4mp",
  },
  {
    name: "YS-2CD2043G2-IU(4mm)",
    typeCode: "camera",
    categoryCode: "surveillance_4mp",
  },
  {
    name: "YS-2CD3347G2E-LUF",
    typeCode: "camera",
    categoryCode: "surveillance_4mp",
  },
  {
    name: "YS-2CD3151G0-I",
    typeCode: "camera",
    categoryCode: "surveillance_5mp",
  },
  {
    name: "YS-2CD3051G0-IUF",
    typeCode: "camera",
    categoryCode: "surveillance_5mp",
  },
  {
    name: "YS-2CD3956G2-IS(U)",
    typeCode: "camera",
    categoryCode: "surveillance_5mp",
  },
  {
    name: "YS-2CD3661G2-LIZSU",
    typeCode: "camera",
    categoryCode: "surveillance_6mp",
  },
  { name: "YS 4G-55", typeCode: "camera", categoryCode: "surveillance_8mp" },
  {
    name: "YS-2CD3381G2P-LIUF/SL",
    typeCode: "camera",
    categoryCode: "surveillance_8mp",
  },
];

function listDeviceModels() {
  return DEVICE_MODEL_CATALOG.map((model) => ({
    categoryCode: null,
    port: null,
    unitId: null,
    description: `${getDeviceTypeName(model.typeCode)}預設型號`,
    config: {},
    ...model,
  }));
}

module.exports = {
  listDeviceModels,
};
