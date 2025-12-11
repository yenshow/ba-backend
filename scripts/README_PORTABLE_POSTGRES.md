# 可攜式 PostgreSQL 跨平台支援

## 概述

專案提供跨平台的可攜式 PostgreSQL 下載與管理腳本，支援 **macOS、Windows 和 Linux**。

## 支援的平台

| 平台    | 架構                  | 狀態    |
| ------- | --------------------- | ------- |
| macOS   | Intel (x86_64)        | ✅ 支援 |
| macOS   | Apple Silicon (arm64) | ✅ 支援 |
| Windows | x64                   | ✅ 支援 |
| Linux   | x64                   | ✅ 支援 |
| Linux   | ARM64                 | ✅ 支援 |

## 使用方式

### 下載並設定（只需一次）

```bash
npm run postgres:download
```

此腳本會：

1. 自動檢測作業系統和架構
2. 下載對應平台的 PostgreSQL 二進制檔案
3. 解壓縮到 `postgres/` 目錄
4. 初始化資料庫
5. 建立資料庫和使用者
6. 啟動 PostgreSQL

### 啟動 PostgreSQL

```bash
npm run postgres:start
```

### 停止 PostgreSQL

```bash
npm run postgres:stop
```

## 技術實現

### 跨平台腳本

使用 **Node.js** 腳本而非 shell 腳本，確保在所有平台上都能運行：

- `scripts/download-portable-postgres.js` - 下載與設定腳本
- `scripts/start-portable-postgres.js` - 啟動腳本
- `scripts/stop-portable-postgres.js` - 停止腳本

### 平台檢測

腳本會自動檢測：

- 作業系統：`process.platform` (darwin / win32 / linux)
- 架構：`os.arch()` (x64 / arm64)

### 下載來源

使用 EnterpriseDB 提供的官方二進制檔案：

- macOS: ZIP 格式
- Windows: ZIP 格式
- Linux: TAR.GZ 格式

## 目錄結構

```
postgres/
├── bin/          # PostgreSQL 執行檔
├── data/         # 資料庫資料
├── logs/         # 日誌檔案
└── share/        # 共享檔案
```

## 平台特定說明

### Windows

- 使用 PowerShell 解壓縮 ZIP 檔案
- 執行檔需要 `.exe` 副檔名
- 路徑使用反斜線 `\`

### Linux

- 使用 `tar` 解壓縮 TAR.GZ 檔案
- 需要 `tar` 命令（通常已預裝）

### macOS

- 使用 `unzip` 解壓縮 ZIP 檔案
- 需要 `unzip` 命令（通常已預裝）

## 疑難排解

### Windows: PowerShell 執行策略錯誤

如果遇到 PowerShell 執行策略限制：

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Linux: 缺少 tar 命令

```bash
# Ubuntu/Debian
sudo apt-get install tar

# CentOS/RHEL
sudo yum install tar
```

### macOS: 缺少 unzip 命令

```bash
# 通常已預裝，如果沒有：
brew install unzip
```

## 注意事項

⚠️ **開發環境設定**：此設定使用 `trust` 認證方式，僅適合開發環境。生產環境請修改 `postgres/data/pg_hba.conf`。

⚠️ **防火牆**：Windows 防火牆可能會詢問是否允許 PostgreSQL 存取網路，請選擇允許。
