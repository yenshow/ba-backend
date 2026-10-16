# ba-backend/scripts

一層分類（依**誰呼叫／風險**）。細節與 npm 對照見各檔註解；現場 runbook 見 `docs/10-setting/faq-troubleshooting.md`。

| 目錄 | 用途 | 出貨 |
| --- | --- | --- |
| `runtime/` | WinSW／安裝精靈／可攜式 PG／MediaMTX | 是 |
| `ops/` | 現場維運：匯入、排修、YSCP 重訂閱（可寫庫） | 是 |
| `probe/` | 設備探測／協定驗證（扁平，不依領域再分子夾） | 可帶 |
| `codegen/` | 開發產碼（`npm run gen:perm`） | 否（打包刪除） |
| `integration/` | 資料庫對接／轉存本機煙測 | 否 |
| `lib/` | 僅被其他腳本 `require`（非 CLI） | 隨呼叫端 |
| `reports/` | 探測產出（gitignore） | — |

## 常用入口

```text
# 出貨／本機基礎設施
npm run postgres:start|stop|download
npm run admin:create
npm run mediamtx

# 維運
npm run import:access-events
npm run dedupe:access-events
npm run yscp:resubscribe
node scripts/ops/importPersonnelFromDevice.js --host <ip> --password <pwd>

# 探測
npm run probe:isapi
npm run probe:a21-energy
npm run probe:video-intercom

# 開發
npm run gen:perm
npm run test:data-export
npm run test:data-export:sample-all
```

改路徑時請同步：`package.json`、`windows/BaSetupWizard`、`scripts/generate-windows-services.cjs`、`scripts/build-and-package.ps1`、相關 docs。
