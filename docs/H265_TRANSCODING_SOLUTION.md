# H265 轉碼解決方案

## 問題描述

當 RTSP 串流使用 H265（HEVC）編解碼器時，MediaMTX 可能無法生成 HLS 文件，出現以下錯誤：

```
[HLS] [muxer stream_xxx] destroyed: muxer error: unable to extract DTS: invalid DeltaPocS0
```

## 原因分析

1. **編解碼器兼容性**：H265 編解碼器在某些情況下無法正確提取 DTS（解碼時間戳）
2. **瀏覽器支持**：大多數瀏覽器不原生支持 H265，需要 H264 才能播放 HLS
3. **MediaMTX 限制**：標準版 MediaMTX 不包含轉碼功能

## 解決方案

### 方案 1：修改攝像頭配置（推薦）

將攝像頭配置為輸出 H264 編碼，這是最簡單且最穩定的解決方案。

**優點：**

- 無需額外轉碼，性能最佳
- 瀏覽器原生支持
- 延遲最低

**缺點：**

- 需要訪問攝像頭配置界面
- 可能影響攝像頭的其他功能

### 方案 2：使用 FFmpeg 進行轉碼

使用 FFmpeg 將 H265 轉碼為 H264，然後推送到 MediaMTX。

**實作步驟：**

1. **下載 MediaMTX FFmpeg 版本**（如果可用）

   ```bash
   # 使用帶 FFmpeg 的 Docker 版本
   docker pull bluenviron/mediamtx:1-ffmpeg
   ```

2. **或使用外部 FFmpeg 進程**

   ```bash
   ffmpeg -rtsp_transport tcp -i "rtsp://camera" \
     -c:v libx264 -preset ultrafast -tune zerolatency \
     -c:a aac -f rtsp rtsp://localhost:8554/transcoded_stream
   ```

3. **在 MediaMTX 配置中使用轉碼後的流**
   ```yaml
   paths:
     transcoded_stream:
       source: rtsp://localhost:8554/transcoded_stream
   ```

### 方案 3：使用 WebRTC（臨時方案）

如果 HLS 無法工作，可以嘗試使用 WebRTC，它對 H265 的支持更好。

**注意：** WebRTC 仍然可能遇到編解碼器兼容性問題。

## 當前狀態

目前系統已配置為：

- 自動檢測服務器 IP 並構建完整的 HLS URL
- 支持 HLS 和 WebRTC 兩種播放方式
- 如果遇到 H265 問題，會記錄警告訊息

## 建議

1. **短期**：將攝像頭配置為輸出 H264
2. **長期**：實作自動轉碼功能（如果攝像頭必須使用 H265）

## 測試 H264 流

如果攝像頭支持 H264，可以測試以下 RTSP URL：

```
rtsp://admin:password@192.168.2.103:554/Streaming/Channels/102
```

（通常 Channel 102 是 H264 流，Channel 101 是 H265 流）
