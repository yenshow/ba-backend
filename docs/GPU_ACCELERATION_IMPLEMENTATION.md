# GPU 加速實作方案

## 📋 概述

本文檔說明如何在現有架構中整合 FFmpeg 進行 GPU 硬體編碼，以提升影像處理性能和流暢度。

**結論**：✅ **是的，如果要進行 GPU 運算，必須使用 FFmpeg**

---

## 🏗️ 目前架構分析

### 當前數據流

```
攝像頭 (RTSP)
    ↓
MediaMTX (CPU 編碼/封裝)
    ↓
HLS 輸出
    ↓
前端播放器
```

### 當前代碼架構

```
前端 VideoPlayer
    ↓
POST /api/rtsp/start
    ↓
mediaMTXService.startStream()
    ↓
MediaMTX API: addPath(pathName, { source: rtspUrl })
    ↓
MediaMTX 直接從 RTSP 讀取並轉換
```

**關鍵代碼位置**：

- `src/services/communication/mediaMTXService.js` - `addPath()` 方法（第 237 行）
- `src/routes/rtspRoutes.js` - `/start` 端點

---

## 🚀 GPU 加速實作方案

### 方案 1：使用 MediaMTX `runOnInit` Hook（推薦）

**架構流程**：

```
攝像頭 (RTSP)
    ↓
FFmpeg (GPU 編碼) ← 新增
    ↓
MediaMTX (接收已編碼串流)
    ↓
HLS 輸出
    ↓
前端播放器
```

**優點**：

- ✅ 最小改動，只需修改路徑配置
- ✅ MediaMTX 自動管理 FFmpeg 進程
- ✅ 無需額外的進程管理

**缺點**：

- ⚠️ 需要在路徑配置中指定 FFmpeg 命令
- ⚠️ 錯誤處理較複雜

### 方案 2：創建 FFmpeg 服務層（更靈活）

**架構流程**：

```
攝像頭 (RTSP)
    ↓
FFmpeg Service (GPU 編碼) ← 新增服務層
    ↓
MediaMTX (接收已編碼串流)
    ↓
HLS 輸出
    ↓
前端播放器
```

**優點**：

- ✅ 更好的進程管理和錯誤處理
- ✅ 可以監控 FFmpeg 狀態
- ✅ 更靈活的配置選項

**缺點**：

- ⚠️ 需要額外的服務層代碼
- ⚠️ 需要管理 FFmpeg 進程生命週期

---

## 💻 實作方案 1：使用 MediaMTX `runOnInit` Hook

### 步驟 1：修改 `mediaMTXService.js`

在 `addPath()` 方法中添加 GPU 編碼選項：

```javascript
async addPath(pathName, rtspUrl, options = {}) {
  const {
    useGpuEncoding = false,  // 是否使用 GPU 編碼
    gpuType = 'nvidia',      // GPU 類型: 'nvidia', 'intel', 'amd'
    bitrate = '2M'           // 位元率
  } = options;

  let pathConfig;

  if (useGpuEncoding) {
    // 使用 FFmpeg 作為源（GPU 編碼）
    const ffmpegCommand = this.buildFFmpegCommand(rtspUrl, gpuType, bitrate, pathName);

    pathConfig = {
      runOnInit: ffmpegCommand,
      runOnInitRestart: true,  // FFmpeg 退出時自動重啟
      sourceOnDemand: false,
    };
  } else {
    // 直接使用 RTSP 源（原有方式）
    pathConfig = {
      source: rtspUrl,
      sourceOnDemand: false,
    };
  }

  // ... 其餘代碼
}

buildFFmpegCommand(rtspUrl, gpuType, bitrate, pathName) {
  const serverIP = this.getServerIP();
  const rtspOutput = `rtsp://${serverIP}:8554/${pathName}`;

  let encoderArgs = '';

  switch (gpuType) {
    case 'nvidia':
      encoderArgs = `-c:v h264_nvenc -preset p4 -tune ll -rc vbr -b:v ${bitrate} -maxrate ${bitrate} -bufsize ${parseInt(bitrate) * 2}M -gpu 0`;
      break;
    case 'intel':
      encoderArgs = `-c:v h264_qsv -preset fast -b:v ${bitrate} -maxrate ${bitrate} -bufsize ${parseInt(bitrate) * 2}M`;
      break;
    case 'amd':
      encoderArgs = `-c:v h264_amf -quality speed -b:v ${bitrate} -maxrate ${bitrate} -bufsize ${parseInt(bitrate) * 2}M`;
      break;
    default:
      throw new Error(`不支援的 GPU 類型: ${gpuType}`);
  }

  // 構建完整的 FFmpeg 命令
  return `ffmpeg -i ${rtspUrl} ${encoderArgs} -f rtsp ${rtspOutput}`;
}
```

### 步驟 2：修改 `startStream()` 方法

添加 GPU 編碼選項參數：

```javascript
async startStream(rtspUrl, options = {}) {
  // ... 現有代碼 ...

  const pathName = this.generatePathName(rtspUrl);

  // 添加路徑時傳入 GPU 選項
  await this.addPath(pathName, rtspUrl, {
    useGpuEncoding: options.useGpuEncoding || false,
    gpuType: options.gpuType || 'nvidia',
    bitrate: options.bitrate || '2M'
  });

  // ... 其餘代碼 ...
}
```

### 步驟 3：修改 API 路由

在 `rtspRoutes.js` 中添加 GPU 選項：

```javascript
router.post("/start", async (req, res, next) => {
  try {
    const { rtspUrl, useGpuEncoding, gpuType, bitrate } = req.body;

    // ... 驗證代碼 ...

    const result = await mediaMTXService.startStream(rtspUrl, {
      useGpuEncoding: useGpuEncoding || false,
      gpuType: gpuType || "nvidia",
      bitrate: bitrate || "2M",
    });

    // ... 其餘代碼 ...
  } catch (error) {
    // ... 錯誤處理 ...
  }
});
```

---

## 💻 實作方案 2：創建 FFmpeg 服務層

### 步驟 1：創建 `ffmpegService.js`

```javascript
const { spawn } = require("child_process");
const EventEmitter = require("events");

class FFmpegService extends EventEmitter {
  constructor() {
    super();
    this.processes = new Map(); // streamId -> process
  }

  /**
   * 啟動 FFmpeg GPU 編碼進程
   * @param {string} streamId - 串流 ID
   * @param {string} rtspInput - RTSP 輸入 URL
   * @param {string} rtspOutput - RTSP 輸出 URL
   * @param {Object} options - 編碼選項
   */
  startGpuEncoding(streamId, rtspInput, rtspOutput, options = {}) {
    const { gpuType = "nvidia", bitrate = "2M", preset = "p4" } = options;

    // 構建 FFmpeg 命令
    const args = this.buildFFmpegArgs(rtspInput, rtspOutput, {
      gpuType,
      bitrate,
      preset,
    });

    // 啟動 FFmpeg 進程
    const ffmpeg = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 處理輸出
    ffmpeg.stdout.on("data", (data) => {
      console.log(`[FFmpeg ${streamId}] ${data.toString()}`);
    });

    ffmpeg.stderr.on("data", (data) => {
      const output = data.toString();
      // FFmpeg 通常將信息輸出到 stderr
      if (output.includes("error") || output.includes("Error")) {
        console.error(`[FFmpeg ${streamId}] ${output}`);
        this.emit("error", { streamId, error: output });
      } else {
        console.log(`[FFmpeg ${streamId}] ${output}`);
      }
    });

    ffmpeg.on("exit", (code) => {
      console.log(`[FFmpeg ${streamId}] 進程退出，代碼: ${code}`);
      this.processes.delete(streamId);
      this.emit("exit", { streamId, code });
    });

    this.processes.set(streamId, ffmpeg);
    return ffmpeg;
  }

  /**
   * 構建 FFmpeg 參數
   */
  buildFFmpegArgs(rtspInput, rtspOutput, options) {
    const { gpuType, bitrate, preset } = options;
    const args = ["-i", rtspInput];

    // 根據 GPU 類型添加編碼參數
    switch (gpuType) {
      case "nvidia":
        args.push(
          "-c:v",
          "h264_nvenc",
          "-preset",
          preset,
          "-tune",
          "ll",
          "-rc",
          "vbr",
          "-b:v",
          bitrate,
          "-maxrate",
          bitrate,
          "-bufsize",
          `${parseInt(bitrate) * 2}M`,
          "-gpu",
          "0"
        );
        break;
      case "intel":
        args.push(
          "-c:v",
          "h264_qsv",
          "-preset",
          "fast",
          "-b:v",
          bitrate,
          "-maxrate",
          bitrate,
          "-bufsize",
          `${parseInt(bitrate) * 2}M`
        );
        break;
      case "amd":
        args.push(
          "-c:v",
          "h264_amf",
          "-quality",
          "speed",
          "-b:v",
          bitrate,
          "-maxrate",
          bitrate,
          "-bufsize",
          `${parseInt(bitrate) * 2}M`
        );
        break;
    }

    args.push("-f", "rtsp", rtspOutput);
    return args;
  }

  /**
   * 停止 FFmpeg 進程
   */
  stopGpuEncoding(streamId) {
    const process = this.processes.get(streamId);
    if (process) {
      process.kill("SIGTERM");
      this.processes.delete(streamId);
    }
  }
}

module.exports = new FFmpegService();
```

### 步驟 2：修改 `mediaMTXService.js`

```javascript
const ffmpegService = require("./ffmpegService");

class MediaMTXService extends EventEmitter {
  // ... 現有代碼 ...

  async startStream(rtspUrl, options = {}) {
    const {
      useGpuEncoding = false,
      gpuType = "nvidia",
      bitrate = "2M",
    } = options;
    const streamId = this.generateStreamId(rtspUrl);
    const pathName = this.generatePathName(rtspUrl);

    if (useGpuEncoding) {
      // 使用 GPU 編碼：先啟動 FFmpeg，再添加 MediaMTX 路徑
      const serverIP = this.getServerIP();
      const rtspOutput = `rtsp://${serverIP}:8554/${pathName}`;

      // 啟動 FFmpeg GPU 編碼
      ffmpegService.startGpuEncoding(streamId, rtspUrl, rtspOutput, {
        gpuType,
        bitrate,
      });

      // 等待 FFmpeg 開始推送（可選）
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 添加 MediaMTX 路徑（從本地 RTSP 接收）
      await this.addPath(pathName, rtspOutput, { sourceOnDemand: false });
    } else {
      // 原有方式：直接從攝像頭 RTSP 讀取
      await this.addPath(pathName, rtspUrl, { sourceOnDemand: false });
    }

    // ... 其餘代碼 ...
  }

  async stopStream(streamId) {
    // ... 現有代碼 ...

    // 如果使用 GPU 編碼，停止 FFmpeg 進程
    if (stream.useGpuEncoding) {
      ffmpegService.stopGpuEncoding(streamId);
    }

    // ... 其餘代碼 ...
  }
}
```

---

## 📊 方案比較

| 項目           | 方案 1 (runOnInit) | 方案 2 (服務層) |
| -------------- | ------------------ | --------------- |
| **實施複雜度** | 低                 | 中              |
| **進程管理**   | MediaMTX 自動管理  | 手動管理        |
| **錯誤處理**   | 較困難             | 較容易          |
| **監控能力**   | 有限               | 完整            |
| **靈活性**     | 中等               | 高              |
| **推薦場景**   | 簡單使用           | 生產環境        |

---

## 🔧 實作建議

### 推薦方案

**生產環境**：建議使用**方案 2（服務層）**

- 更好的錯誤處理和監控
- 更容易調試和維護
- 可以添加重試機制和健康檢查

**開發/測試環境**：可以使用**方案 1（runOnInit）**

- 實施簡單快速
- 適合快速驗證

### 實作步驟

1. **檢查 GPU 支援**：

   ```bash
   npm run gpu:check  # 如果之前有創建這個腳本
   # 或手動檢查
   ffmpeg -encoders | grep nvenc  # NVIDIA
   ```

2. **選擇實作方案**：

   - 根據需求選擇方案 1 或方案 2

3. **修改代碼**：

   - 按照上述步驟修改相關文件

4. **測試驗證**：

   - 測試 GPU 編碼是否正常工作
   - 監控 GPU 使用率
   - 檢查影像品質和延遲

5. **添加配置選項**：
   - 可以通過環境變數或配置文件控制是否啟用 GPU

---

## ⚙️ 配置選項

### 環境變數

```bash
# .env
ENABLE_GPU_ENCODING=true
GPU_TYPE=nvidia  # nvidia, intel, amd
GPU_BITRATE=2M
FFMPEG_PATH=     # 可選：指定 ffmpeg 執行檔完整路徑（不指定則使用內建/系統 ffmpeg）
```

### FFmpeg 內建下載（推薦）

本專案已加入 `@ffmpeg-installer/ffmpeg` 依賴，**在安裝依賴時會自動下載對應平台的 ffmpeg 執行檔**，後端會優先使用該路徑，不需要手動到系統安裝。

可用以下命令驗證目前後端會使用的 ffmpeg 以及是否具備 GPU 編碼器：

```bash
npm run ffmpeg:check
```

如需改用你自行安裝/下載的 ffmpeg（例如你需要特定版本或特定硬體編碼支援），可設置 `FFMPEG_PATH` 指向該 ffmpeg 執行檔。

### API 請求範例

```javascript
// 啟用 GPU 編碼
POST /api/rtsp/start
{
  "rtspUrl": "rtsp://camera_url",
  "useGpuEncoding": true,
  "gpuType": "nvidia",
  "bitrate": "2M"
}

// 不使用 GPU（原有方式）
POST /api/rtsp/start
{
  "rtspUrl": "rtsp://camera_url"
}
```

---

## 📝 注意事項

1. **FFmpeg 版本**：

   - 確保 FFmpeg 編譯時啟用了 GPU 硬體編碼支援
   - Windows：下載包含硬體編碼的 FFmpeg 版本
   - Linux：可能需要重新編譯 FFmpeg

2. **GPU 驅動程式**：

   - 確保安裝最新 GPU 驅動程式
   - NVIDIA：需要 CUDA Toolkit（可選但建議）

3. **性能監控**：

   - 監控 GPU 使用率（`nvidia-smi`）
   - 監控 FFmpeg 進程狀態
   - 檢查 MediaMTX 日誌

4. **錯誤處理**：
   - FFmpeg 進程可能因為各種原因退出
   - 需要實現重試機制
   - 記錄錯誤日誌以便調試

---

## ✅ 總結

**回答您的問題**：

1. **是否必須使用 FFmpeg？**

   - ✅ 是的，MediaMTX 不支援直接配置 GPU，必須使用 FFmpeg

2. **如何實作？**

   - 方案 1：使用 MediaMTX 的 `runOnInit` hook（簡單）
   - 方案 2：創建 FFmpeg 服務層（推薦，更靈活）

3. **架構分析**：
   - 當前架構：攝像頭 → MediaMTX → HLS
   - GPU 架構：攝像頭 → FFmpeg (GPU) → MediaMTX → HLS

**建議**：先實施方案 2（服務層），因為它提供更好的控制和監控能力。
