# MediaMTX（攝影機 RTSP → WebRTC）

## 如何啟動

### 方式一：PM2（建議，與整機一起）

從 **ba-system 根目錄**執行時，`ecosystem.config.cjs` 已包含 `ba-mediamtx`：

```bash
# 啟動所有服務（含後端、兩前端、MediaMTX）
pm2 start ecosystem.config.cjs

# 僅啟動 MediaMTX
pm2 start ecosystem.config.cjs --only ba-mediamtx
```

停止 MediaMTX：`pm2 stop ba-mediamtx`  
查看狀態：`pm2 list` / `pm2 logs ba-mediamtx`

### 方式二：從 ba-backend 用 npm 腳本

在 **ba-backend** 目錄下：

```bash
# 直接執行 mediamtx 可執行檔（需已放置 mediamtx/bin/mediamtx.exe 或 mediamtx）
npm run mediamtx

# 或透過 PM2 只啟動 MediaMTX（需在 ba-system 上一層有 ecosystem.config.cjs）
npm run mediamtx:pm2:start
npm run mediamtx:pm2:stop
```

若未安裝可執行檔，請從 [MediaMTX Releases](https://github.com/bluenviron/mediamtx/releases) 下載並解壓至 `mediamtx/bin/`（Windows：`mediamtx.exe`；Linux：`mediamtx`）。

## 設定

- 組態檔：`mediamtx.yml`（API :9997、WebRTC :8889 等）
- 後端 `.env`：
  - `MEDIAMTX_API_BASE_URL`：後端連 MediaMTX 用（本機可填 `http://127.0.0.1:9997`）
  - **`MEDIAMTX_WEBRTC_BASE_URL`**：**瀏覽器**連 WHEP 用，須填「網頁所在裝置能連到的位址」。例如前端是 `http://192.168.2.8:3001`，則填 `http://192.168.2.8:8889`；若填 `127.0.0.1:8889`，只有本機瀏覽器能連，其他裝置會出現 ERR_CONNECTION_REFUSED。
