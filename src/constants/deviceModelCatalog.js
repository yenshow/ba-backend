/**
 * 產品設備型號 catalog SSOT。
 *
 * 生產階段在本檔維護型號；產品首次初始化只新增不存在的型號，
 * 不覆寫產品現場既有資料。未指定 description 時，會以「<型別名>預設型號」補上。
 */
const { getDeviceTypeName } = require("./deviceTypes");

const DEVICE_MODEL_CATALOG = [
  { name: "YS AC-02F", typeCode: "access_control" },
  { name: "YS AC-07", typeCode: "access_control" },
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
    name: "TP-Link",
    typeCode: "camera",
    description: "通用 RTSP 攝影機",
    config: {
      rtsp_url_template: "rtsp://{username}:{password}@{ip}/stream1",
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
