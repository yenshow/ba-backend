# 跨平台支援說明

## 概述

可攜式 PostgreSQL 腳本已更新為**跨平台支援**，使用 Node.js 實現，可在 **macOS、Windows 和 Linux** 上運行。

## 支援的平台

| 平台    | 架構                  | 狀態 | 下載格式 |
| ------- | --------------------- | ---- | -------- |
| macOS   | Intel (x86_64)        | ✅   | ZIP      |
| macOS   | Apple Silicon (arm64) | ✅   | ZIP      |
| Windows | x64                   | ✅   | ZIP      |
| Linux   | x64                   | ✅   | TAR.GZ   |
| Linux   | ARM64                 | ✅   | TAR.GZ   |

## 主要變更

### 從 Shell 腳本改為 Node.js 腳本

**之前**（僅支援 macOS）：

- `scripts/download-portable-postgres.sh` - Bash 腳本
- `scripts/start-portable-postgres.sh` - Bash 腳本
- `scripts/stop-portable-postgres.sh` - Bash 腳本

**現在**（跨平台）：

- `scripts/download-portable-postgres.js` - Node.js 腳本 ✅
- `scripts/start-portable-postgres.js` - Node.js 腳本 ✅
- `scripts/stop-portable-postgres.js` - Node.js 腳本 ✅

### package.json 更新

```json
{
	"scripts": {
		"postgres:download": "node scripts/download-portable-postgres.js",
		"postgres:start": "node scripts/start-portable-postgres.js",
		"postgres:stop": "node scripts/stop-portable-postgres.js"
	}
}
```

## 使用方式

所有平台使用相同的命令：

```bash
# 下載並設定（自動檢測平台）
npm run postgres:download

# 啟動
npm run postgres:start

# 停止
npm run postgres:stop
```

## 技術細節

### 平台檢測

腳本使用 Node.js 內建模組自動檢測：

```javascript
const platform = os.platform(); // 'darwin' | 'win32' | 'linux'
const arch = os.arch(); // 'x64' | 'arm64'
```

### 解壓縮方式

- **macOS**: 使用 `unzip` 命令
- **Windows**: 使用 PowerShell `Expand-Archive`
- **Linux**: 使用 `tar` 命令

### 路徑處理

- 使用 Node.js `path` 模組處理路徑，自動適應不同平台
- Windows 使用反斜線 `\`，Unix 系統使用正斜線 `/`

### 命令執行

- Windows 使用 `shell: true` 選項執行命令
- Unix 系統直接執行命令

## 平台特定需求

### Windows

- 需要 PowerShell（Windows 7+ 已內建）
- 可能需要設定執行策略：
  ```powershell
  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
  ```

### Linux

- 需要 `tar` 命令（通常已預裝）
- 如果沒有，安裝：

  ```bash
  # Ubuntu/Debian
  sudo apt-get install tar

  # CentOS/RHEL
  sudo yum install tar
  ```

### macOS

- 需要 `unzip` 命令（通常已預裝）
- 如果沒有，安裝：
  ```bash
  brew install unzip
  ```

## 測試建議

### Windows 測試

```powershell
# 在 PowerShell 或 CMD 中
cd ba-backend
npm run postgres:download
npm run postgres:start
npm run db:test
```

### Linux 測試

```bash
cd ba-backend
npm run postgres:download
npm run postgres:start
npm run db:test
```

### macOS 測試

```bash
cd ba-backend
npm run postgres:download
npm run postgres:start
npm run db:test
```

## 向後兼容

舊的 `.sh` 腳本仍然保留在專案中，但 `package.json` 已更新為使用新的 `.js` 腳本。如果需要，可以手動執行舊腳本：

```bash
# macOS/Linux
bash scripts/download-portable-postgres.sh
```

## 疑難排解

### Windows: 下載失敗

如果下載失敗，可能是網路問題或防火牆阻擋。可以：

1. 檢查網路連線
2. 暫時關閉防火牆測試
3. 手動下載並放置到 `postgres/` 目錄

### Linux: 權限錯誤

```bash
# 確保腳本有執行權限
chmod +x scripts/*.js
```

### 所有平台: 解壓縮失敗

確保有足夠的磁碟空間和寫入權限。
