# NVIDIA 驅動和 CUDA 安裝指南

本指南將幫助您在 Windows 系統上安裝 NVIDIA 驅動程式和 CUDA Toolkit，以支援 FFmpeg GPU 硬體編碼（NVENC）。

## 📋 前置檢查

### 1. 確認您的系統有 NVIDIA GPU

**方法一：使用設備管理器**
1. 按 `Win + X`，選擇「設備管理器」
2. 展開「顯示適配器」
3. 查看是否有 NVIDIA 顯示卡（例如：NVIDIA GeForce RTX 3060）

**方法二：使用 PowerShell**
```powershell
Get-WmiObject Win32_VideoController | Select-Object Name, Status
```

**方法三：使用 DirectX 診斷工具**
1. 按 `Win + R`，輸入 `dxdiag`，按 Enter
2. 切換到「顯示」標籤
3. 查看「製造商」和「晶片類型」

### 2. 確認系統要求

- **作業系統**：Windows 10/11 (64-bit)
- **管理員權限**：需要管理員權限進行安裝
- **磁碟空間**：至少 3-4 GB 可用空間

---

## 🚀 安裝步驟

### 步驟 1：安裝 NVIDIA 驅動程式

#### 1.1 下載驅動程式

1. 訪問 NVIDIA 官方驅動下載頁面：
   - **GeForce 驅動**：https://www.nvidia.com/Download/index.aspx
   - **Quadro/專業卡驅動**：https://www.nvidia.com/Download/index.aspx（選擇「所有產品」）

2. 選擇您的 GPU 型號：
   - **產品類型**：GeForce / Quadro / Tesla 等
   - **產品系列**：例如 RTX 30 Series / RTX 40 Series
   - **產品**：選擇具體型號
   - **作業系統**：Windows 10/11 64-bit
   - **下載類型**：Game Ready Driver（遊戲）或 Studio Driver（創作）

3. 點擊「搜尋」並下載驅動程式

#### 1.2 安裝驅動程式

1. 執行下載的 `.exe` 安裝檔
2. 選擇「自訂安裝」（Custom Installation）
3. 建議選項：
   - ✅ **NVIDIA 圖形驅動程式**（必須）
   - ✅ **PhysX 系統軟體**（建議）
   - ✅ **NVIDIA GeForce Experience**（可選，用於遊戲優化）
   - ✅ **HD Audio Driver**（如果使用 HDMI 音訊輸出）
4. 點擊「下一步」開始安裝
5. 安裝完成後**重新啟動電腦**

#### 1.3 驗證驅動安裝

開啟命令提示字元或 PowerShell，執行：

```powershell
nvidia-smi
```

**成功輸出範例**：
```
+-----------------------------------------------------------------------------+
| NVIDIA-SMI 535.xx       Driver Version: 535.xx       CUDA Version: 12.2     |
|-------------------------------+----------------------+----------------------+
| GPU  Name            TCC/WDDM | Bus-Id        Disp.A | Volatile Uncorr. ECC |
| Fan  Temp  Perf  Pwr:Usage/Cap|         Memory-Usage | GPU-Util  Compute M. |
|===============================+======================+======================|
|   0  NVIDIA GeForce ...  WDDM  | 00000000:01:00.0 On |                  N/A |
| N/A   45C    P0    25W / 170W |      1234MiB / 8192MiB |      0%      Default |
+-------------------------------+----------------------+----------------------+
```

如果看到類似輸出，表示驅動安裝成功！

---

### 步驟 2：安裝 CUDA Toolkit

#### 2.1 下載 CUDA Toolkit

1. 訪問 NVIDIA CUDA Toolkit 下載頁面：
   - https://developer.nvidia.com/cuda-downloads

2. 選擇安裝方式：
   - **作業系統**：Windows
   - **架構**：x86_64
   - **版本**：Windows 10/11
   - **安裝程式類型**：exe (local)（推薦，離線安裝）

3. 下載對應版本的 CUDA Toolkit：
   - **建議版本**：CUDA 12.x（最新穩定版）
   - **注意**：確保 CUDA 版本與您的驅動程式兼容
   - 查看兼容性：https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html

#### 2.2 安裝 CUDA Toolkit

1. 執行下載的 `.exe` 安裝檔
2. 選擇「自訂安裝」（Custom Installation）
3. 建議選項：
   - ✅ **CUDA Toolkit**（必須）
   - ✅ **CUDA Samples**（可選，用於測試）
   - ✅ **CUDA Documentation**（可選）
   - ❌ **Visual Studio Integration**（如果沒有安裝 Visual Studio，可取消）
4. 點擊「下一步」開始安裝
5. 安裝完成後**重新啟動電腦**（如果需要）

#### 2.3 驗證 CUDA 安裝

開啟命令提示字元或 PowerShell，執行：

```powershell
nvcc --version
```

**成功輸出範例**：
```
nvcc: NVIDIA (R) Cuda compiler driver
Copyright (c) 2005-2023 NVIDIA Corporation
Built on [日期]
Cuda compilation tools, release 12.2, V12.2.xxx
```

---

### 步驟 3：驗證 FFmpeg NVENC 支援

#### 3.1 檢查 FFmpeg 編譯選項

在專案目錄下執行：

```powershell
.\ffmpeg\bin\ffmpeg.exe -encoders | Select-String "nvenc"
```

**成功輸出**：
```
 V..... h264_nvenc           NVIDIA NVENC H.264 encoder
 V..... hevc_nvenc           NVIDIA NVENC HEVC encoder
```

#### 3.2 測試 NVENC 編碼

執行測試命令：

```powershell
.\ffmpeg\bin\ffmpeg.exe -f lavfi -i testsrc=duration=10:size=1920x1080:rate=30 -c:v h264_nvenc -preset fast -b:v 2M -f null -
```

如果沒有錯誤，表示 NVENC 可用！

---

## 🔧 故障排除

### 問題 1：`nvidia-smi` 命令找不到

**原因**：NVIDIA 驅動未正確安裝或未添加到 PATH

**解決方案**：
1. 確認驅動已安裝：檢查「設備管理器」中是否有 NVIDIA 顯示卡
2. 重新安裝驅動程式
3. 確認驅動安裝路徑：通常是 `C:\Windows\System32\DriverStore\FileRepository\`

### 問題 2：`nvcc` 命令找不到

**原因**：CUDA Toolkit 未正確安裝或未添加到 PATH

**解決方案**：
1. 檢查環境變數：
   - 開啟「系統環境變數」設定
   - 確認 `CUDA_PATH` 和 `CUDA_PATH_V12_x`（版本號）已設置
   - 確認 `PATH` 包含 `%CUDA_PATH%\bin`
2. 手動添加環境變數：
   ```
   CUDA_PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.x
   PATH=%CUDA_PATH%\bin;%PATH%
   ```
3. 重新啟動命令提示字元或 PowerShell

### 問題 3：FFmpeg 無法使用 NVENC

**原因**：FFmpeg 未編譯 NVENC 支援或缺少必要的 DLL

**解決方案**：
1. 確認 FFmpeg 版本支援 NVENC：
   ```powershell
   .\ffmpeg\bin\ffmpeg.exe -version
   ```
   查看配置中是否有 `--enable-nvenc`

2. 檢查必要的 DLL 是否存在：
   - `nvEncodeAPI64.dll`（通常在 CUDA 安裝目錄）
   - `nvcuda.dll`（NVIDIA 驅動提供）

3. 如果 FFmpeg 不支援 NVENC，需要：
   - 下載支援 NVENC 的 FFmpeg 版本
   - 或使用專案提供的 FFmpeg（已包含 NVENC 支援）

### 問題 4：編碼時出現 "InitializeEncoder failed"

**原因**：編碼參數不正確或 GPU 不支援

**解決方案**：
1. 檢查 GPU 是否支援 NVENC：
   - 訪問：https://developer.nvidia.com/video-encode-decode-gpu-support-matrix
   - 確認您的 GPU 在支援列表中

2. 降低編碼參數：
   - 降低解析度（例如從 2560x1440 降到 1920x1080）
   - 降低位元率
   - 使用更快的 preset

3. 檢查 GPU 記憶體是否足夠

### 問題 5：驅動版本與 CUDA 版本不兼容

**解決方案**：
1. 查看兼容性表：https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html
2. 更新驅動程式到支援的版本
3. 或降級 CUDA Toolkit 到兼容版本

---

## 📚 參考資源

### 官方文檔
- **NVIDIA 驅動下載**：https://www.nvidia.com/Download/index.aspx
- **CUDA Toolkit 下載**：https://developer.nvidia.com/cuda-downloads
- **CUDA 兼容性表**：https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html
- **NVENC 支援列表**：https://developer.nvidia.com/video-encode-decode-gpu-support-matrix

### 相關文檔
- **GPU 加速實施文檔**：`docs/GPU_ACCELERATION_IMPLEMENTATION.md`
- **FFmpeg NVENC 指南**：https://trac.ffmpeg.org/wiki/HWAccelIntro#NVENC

---

## ✅ 安裝檢查清單

完成安裝後，請確認以下項目：

- [ ] `nvidia-smi` 命令可以執行並顯示 GPU 資訊
- [ ] `nvcc --version` 命令可以執行並顯示 CUDA 版本
- [ ] FFmpeg 可以列出 `h264_nvenc` 編碼器
- [ ] FFmpeg 可以成功執行 NVENC 編碼測試
- [ ] 系統環境變數已正確設置
- [ ] 已重新啟動電腦（如果需要）

---

## 🎯 下一步

安裝完成後，您可以：

1. **測試 GPU 編碼**：
   ```powershell
   npm run dev
   ```
   然後在前端嘗試啟動 GPU 編碼的 RTSP 串流

2. **檢查編碼性能**：
   - 使用 `nvidia-smi` 監控 GPU 使用率
   - 檢查編碼延遲和品質

3. **優化編碼參數**：
   - 根據您的需求調整位元率、preset 等參數
   - 參考 `src/config/ffmpegConfig.js` 中的配置選項

---

**注意**：如果您的系統沒有 NVIDIA GPU，則無法使用 NVENC 編碼。請考慮：
- 使用 CPU 編碼（不勾選「啟用 GPU 編碼」）
- 或使用其他 GPU 加速方案（Intel Quick Sync、AMD VCE）
