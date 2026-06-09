# ba-backend HCNetSDK 梯控整合

海康 HCNetSDK 梯控整合（卡片 CRUD、佈防事件、呼梯控制）。

> **平台**：Windows x64 + .NET 8 Runtime

## 目錄

```
sdk/
├── hcnet-sdk/lib/       # HCNetSDK.dll 與 HCNetSDKCom/
├── dotnet/common/       # P/Invoke、卡片、佈防解析
├── dotnet/bridge/       # HcNetSdkBridge.exe（JSON 介面）
└── scripts/run-bridge.ps1
```

## 佈防事件（僅以下 minor）

| Major | Minor | 說明 |
|-------|-------|------|
| 0x3 | 0x400–0x403 | 遠端開／關／常開／常閉 |
| 0x5 | 0x01 | 合法卡通行 |
| 0x5 | 0x5f / 0x60 | 呼梯繼電器斷開／閉合 |

## 建置與測試

```powershell
cd ba-backend
npm run sdk:build
$env:SDK_DEVICE_PASS="密碼"
npm run test:sdk-ladder-card-get
```

API：
- `/api/ladder-sdk/devices/:deviceId/...` — 設備卡片／呼梯
- `/api/ladder-sdk/events`、`/events/latest` — 佈防事件（寫入 `ladder_sdk_events`）
- WebSocket：`ladder-sdk:event`（前端防抖重拉最新紀錄）

人員梯控卡：`person_ladder_cards` + `PUT /api/personnel/persons/:id/ladder-card`

設備請在 `devices` 表建立 `controller` + `protocol: "hcnet_sdk"`。
