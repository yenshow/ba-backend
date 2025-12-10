const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const crypto = require("crypto");
const EventEmitter = require("events");

// 設置 ffmpeg 路徑
ffmpeg.setFfmpegPath(ffmpegPath);

class RTSPStreamService extends EventEmitter {
	constructor() {
		super();
		// 存儲所有活躍的串流
		this.streams = new Map();
		// HLS 輸出目錄
		this.hlsOutputDir = path.join(__dirname, "../../public/hls");
		// 確保輸出目錄存在
		this.ensureOutputDirectory();
		// 緩存檢測到的 GPU 編碼器
		this.detectedGpuCodec = null;
		this.gpuCodecDetectionPromise = null;
	}

	/**
	 * 檢測可用的 GPU 編碼器
	 * @returns {Promise<{codec: string, platform: string, type: string}|null>}
	 */
	async detectGpuCodec() {
		// 如果已經檢測過，直接返回緩存結果
		if (this.detectedGpuCodec !== undefined) {
			return this.detectedGpuCodec;
		}

		// 如果正在檢測中，等待檢測完成
		if (this.gpuCodecDetectionPromise) {
			return this.gpuCodecDetectionPromise;
		}

		// 開始檢測
		this.gpuCodecDetectionPromise = this._performGpuDetection();
		this.detectedGpuCodec = await this.gpuCodecDetectionPromise;
		return this.detectedGpuCodec;
	}

	/**
	 * 執行 GPU 編碼器檢測
	 * @private
	 */
	async _performGpuDetection() {
		const platform = process.platform;

		try {
			// 獲取所有可用的編碼器
			const encodersOutput = execSync(`"${ffmpegPath}" -encoders 2>&1`, {
				encoding: "utf8",
				timeout: 5000
			});

			// macOS: 優先使用 VideoToolbox
			if (platform === "darwin") {
				if (encodersOutput.includes("h264_videotoolbox")) {
					console.log("[RTSP Stream] 檢測到 macOS VideoToolbox 硬體加速");
					return {
						codec: "h264_videotoolbox",
						platform: "darwin",
						type: "VideoToolbox"
					};
				}
			}

			// Windows/Linux: 檢測 NVENC (NVIDIA)
			if (encodersOutput.includes("h264_nvenc")) {
				console.log("[RTSP Stream] 檢測到 NVIDIA NVENC 硬體加速");
				return {
					codec: "h264_nvenc",
					platform: platform,
					type: "NVENC"
				};
			}

			// Windows/Linux: 檢測 QSV (Intel)
			if (encodersOutput.includes("h264_qsv")) {
				console.log("[RTSP Stream] 檢測到 Intel QSV 硬體加速");
				return {
					codec: "h264_qsv",
					platform: platform,
					type: "QSV"
				};
			}

			// Linux: 檢測 VAAPI
			if (platform === "linux" && encodersOutput.includes("h264_vaapi")) {
				console.log("[RTSP Stream] 檢測到 VAAPI 硬體加速");
				return {
					codec: "h264_vaapi",
					platform: "linux",
					type: "VAAPI"
				};
			}

			console.log("[RTSP Stream] 未檢測到硬體加速編碼器，將使用軟體編碼");
			return null;
		} catch (error) {
			console.warn("[RTSP Stream] GPU 編碼器檢測失敗，將使用軟體編碼:", error.message);
			return null;
		}
	}

	/**
	 * 獲取編碼器配置
	 * @param {Object} gpuInfo - GPU 編碼器信息
	 * @returns {Object} 編碼器配置
	 */
	getEncoderConfig(gpuInfo) {
		if (!gpuInfo) {
			// 軟體編碼配置
			return {
				codec: "libx264",
				options: ["-preset", "ultrafast", "-tune", "zerolatency", "-g", "30"]
			};
		}

		const { codec, type } = gpuInfo;

		// VideoToolbox (macOS)
		if (type === "VideoToolbox") {
			return {
				codec: codec,
				options: ["-allow_sw", "1", "-realtime", "1"]
			};
		}

		// NVENC (NVIDIA)
		if (type === "NVENC") {
			return {
				codec: codec,
				options: [
					"-preset",
					"p1", // 最快預設（最低延遲）
					"-tune",
					"ll", // 低延遲模式
					"-rc",
					"cbr", // 恆定比特率
					"-gpu",
					"0" // 使用第一個 GPU
				]
			};
		}

		// QSV (Intel)
		if (type === "QSV") {
			return {
				codec: codec,
				options: [
					"-preset",
					"veryfast", // QSV 預設選項
					"-global_quality",
					"23", // 品質參數（18-28，越小品質越好）
					"-g",
					"30"
				]
			};
		}

		// VAAPI (Linux)
		if (type === "VAAPI") {
			return {
				codec: codec,
				options: [
					"-b:v",
					"2M", // 視頻比特率
					"-maxrate",
					"2M",
					"-bufsize",
					"4M"
				]
			};
		}

		// 默認回退到軟體編碼
		return {
			codec: "libx264",
			options: ["-preset", "ultrafast", "-tune", "zerolatency", "-g", "30"]
		};
	}

	ensureOutputDirectory() {
		if (!fs.existsSync(this.hlsOutputDir)) {
			fs.mkdirSync(this.hlsOutputDir, { recursive: true });
		}
	}

	/**
	 * 生成串流 ID（基於 RTSP URL）
	 */
	generateStreamId(rtspUrl) {
		// 使用 URL 的 hash 作為 ID
		return crypto.createHash("md5").update(rtspUrl).digest("hex");
	}

	/**
	 * 啟動 RTSP 串流轉換為 HLS
	 * @param {string} rtspUrl - RTSP 串流 URL
	 * @returns {Promise<{streamId: string, hlsUrl: string, status: string}>}
	 */
	async startStream(rtspUrl) {
		if (!rtspUrl || typeof rtspUrl !== "string") {
			throw new Error("RTSP URL 是必需的");
		}

		// 驗證 RTSP URL 格式
		if (!rtspUrl.startsWith("rtsp://")) {
			throw new Error("無效的 RTSP URL 格式，必須以 rtsp:// 開頭");
		}

		const streamId = this.generateStreamId(rtspUrl);
		const hlsPath = path.join(this.hlsOutputDir, `${streamId}`);
		const hlsPlaylistPath = path.join(hlsPath, "playlist.m3u8");

		// 如果串流已經存在，返回現有資訊
		if (this.streams.has(streamId)) {
			const existingStream = this.streams.get(streamId);
			return {
				streamId,
				hlsUrl: `/hls/${streamId}/playlist.m3u8`,
				status: existingStream.status,
				rtspUrl: existingStream.rtspUrl
			};
		}

		// 確保 HLS 目錄存在
		if (!fs.existsSync(hlsPath)) {
			fs.mkdirSync(hlsPath, { recursive: true });
		}

		return new Promise(async (resolve, reject) => {
			try {
				// 檢測可用的 GPU 編碼器
				const gpuInfo = await this.detectGpuCodec();
				const encoderConfig = this.getEncoderConfig(gpuInfo);

				console.log(`[RTSP Stream] 使用編碼器: ${encoderConfig.codec}${gpuInfo ? ` (${gpuInfo.type} 硬體加速)` : " (軟體編碼)"}`);

				// 創建 ffmpeg 進程
				const command = ffmpeg(rtspUrl)
					.inputOptions([
						"-rtsp_transport",
						"tcp" // 使用 TCP 傳輸，更穩定
					])
					.outputOptions([
						"-c:v",
						encoderConfig.codec, // 使用檢測到的編碼器
						...encoderConfig.options, // 編碼器特定參數
						"-c:a",
						"aac", // 音頻編碼器（如果有）
						"-b:a",
						"128k", // 音頻比特率
						"-hls_time",
						"1", // 每個片段 1 秒（降低延遲）
						"-hls_list_size",
						"3", // 只保留 3 個片段（約 3 秒緩衝）
						"-hls_flags",
						"delete_segments+independent_segments", // 自動刪除舊片段 + 獨立片段
						"-hls_segment_type",
						"mpegts", // 使用 MPEG-TS 格式
						"-hls_segment_filename",
						path.join(hlsPath, "segment_%03d.ts"), // 片段文件名
						"-start_number",
						"0", // 從 0 開始編號
						"-hls_allow_cache",
						"0", // 禁用緩存
						"-f",
						"hls" // 輸出格式為 HLS
					])
					.output(hlsPlaylistPath)
					.on("start", (commandLine) => {
						console.log(`[RTSP Stream] 啟動串流: ${streamId}`);
						console.log(`[RTSP Stream] FFmpeg 命令: ${commandLine}`);
					})
					.on("error", (err, stdout, stderr) => {
						console.error(`[RTSP Stream] 串流錯誤 (${streamId}):`, err.message);
						console.error(`[RTSP Stream] stderr:`, stderr);
						this.streams.delete(streamId);
						this.emit("error", { streamId, error: err });
						reject(new Error(`串流啟動失敗: ${err.message}`));
					})
					.on("end", () => {
						console.log(`[RTSP Stream] 串流結束: ${streamId}`);
						this.streams.delete(streamId);
						this.emit("end", { streamId });
					})
					.on("stderr", (stderrLine) => {
						// 可以記錄 stderr 日誌，但不一定表示錯誤
						if (stderrLine.includes("error") || stderrLine.includes("Error")) {
							console.error(`[RTSP Stream] stderr (${streamId}):`, stderrLine);
						}
					});

				// 啟動轉換
				command.run();

				// 存儲串流資訊
				const streamInfo = {
					streamId,
					rtspUrl,
					hlsPath,
					hlsPlaylistPath,
					command,
					status: "running",
					startedAt: new Date(),
					hlsUrl: `/hls/${streamId}/playlist.m3u8`
				};

				this.streams.set(streamId, streamInfo);

				// 等待一小段時間確保串流開始
				setTimeout(() => {
					resolve({
						streamId,
						hlsUrl: streamInfo.hlsUrl,
						status: streamInfo.status,
						rtspUrl
					});
				}, 2000); // 等待 2 秒讓串流初始化
			} catch (error) {
				reject(new Error(`無法啟動串流: ${error.message}`));
			}
		});
	}

	/**
	 * 停止 RTSP 串流
	 * @param {string} streamId - 串流 ID
	 * @returns {Promise<{success: boolean, message: string}>}
	 */
	async stopStream(streamId) {
		if (!this.streams.has(streamId)) {
			throw new Error(`串流 ${streamId} 不存在`);
		}

		const streamInfo = this.streams.get(streamId);

		return new Promise((resolve) => {
			try {
				// 停止 ffmpeg 進程
				if (streamInfo.command && streamInfo.command.ffmpegProc) {
					streamInfo.command.ffmpegProc.kill("SIGTERM");
				}

				// 更新狀態
				streamInfo.status = "stopped";
				this.streams.delete(streamId);

				// 清理 HLS 文件（可選，也可以保留讓客戶端繼續播放）
				// this.cleanupHlsFiles(streamId);

				console.log(`[RTSP Stream] 已停止串流: ${streamId}`);
				resolve({
					success: true,
					message: `串流 ${streamId} 已停止`
				});
			} catch (error) {
				console.error(`[RTSP Stream] 停止串流時發生錯誤:`, error);
				resolve({
					success: false,
					message: `停止串流時發生錯誤: ${error.message}`
				});
			}
		});
	}

	/**
	 * 獲取串流狀態
	 * @param {string} streamId - 串流 ID（可選，不提供則返回所有串流）
	 * @returns {Object|Array}
	 */
	getStreamStatus(streamId = null) {
		if (streamId) {
			if (!this.streams.has(streamId)) {
				return null;
			}
			const stream = this.streams.get(streamId);
			return {
				streamId: stream.streamId,
				rtspUrl: stream.rtspUrl,
				hlsUrl: stream.hlsUrl,
				status: stream.status,
				startedAt: stream.startedAt
			};
		}

		// 返回所有串流狀態
		return Array.from(this.streams.values()).map((stream) => ({
			streamId: stream.streamId,
			rtspUrl: stream.rtspUrl,
			hlsUrl: stream.hlsUrl,
			status: stream.status,
			startedAt: stream.startedAt
		}));
	}

	/**
	 * 清理 HLS 文件
	 * @param {string} streamId - 串流 ID
	 */
	cleanupHlsFiles(streamId) {
		const hlsPath = path.join(this.hlsOutputDir, streamId);
		if (fs.existsSync(hlsPath)) {
			fs.rmSync(hlsPath, { recursive: true, force: true });
			console.log(`[RTSP Stream] 已清理 HLS 文件: ${streamId}`);
		}
	}

	/**
	 * 停止所有串流
	 */
	async stopAllStreams() {
		const streamIds = Array.from(this.streams.keys());
		const results = await Promise.allSettled(streamIds.map((id) => this.stopStream(id)));
		return results;
	}
}

// 導出單例
module.exports = new RTSPStreamService();
