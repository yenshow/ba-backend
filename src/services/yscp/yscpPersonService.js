const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("../../config");
const logger = require("../../utils/logger");

const serviceLogger = logger.createLogger("YSCP Person Service");

/**
 * YSCP 人員服務
 * 處理人員資訊和圖片資料的獲取
 */
class YscpPersonService {
	/**
	 * 從 output 文件讀取人員 ID 列表
	 * @param {string} filePath - 文件路徑（相對於 output 目錄或絕對路徑）
	 * @returns {Promise<Array<number>>} 人員 ID 列表
	 */
	async getPersonIdsFromFile(filePath) {
		try {
			let fullPath = filePath;
			if (!path.isAbsolute(filePath)) {
				fullPath = path.join(__dirname, "../../../output", filePath);
			}

			if (!fs.existsSync(fullPath)) {
				throw new Error(`文件不存在: ${fullPath}`);
			}

			const content = fs.readFileSync(fullPath, "utf8");
			const personIds = [];
			const recordPattern = /\{\s*"id":\s*(\d+)/g;
			let match;

			while ((match = recordPattern.exec(content)) !== null) {
				const personId = parseInt(match[1], 10);
				if (!isNaN(personId)) {
					personIds.push(personId);
				}
			}

			serviceLogger.info("從文件讀取人員 ID", {
				filePath: fullPath,
				count: personIds.length,
			});

			return personIds;
		} catch (error) {
			serviceLogger.error("讀取人員 ID 文件失敗", {
				filePath,
				error: error.message,
			});
			throw error;
		}
	}

	/**
	 * 構建 YSCP API 簽名
	 * @param {string} urlPath - API 路徑
	 * @param {string} method - HTTP 方法（預設 POST）
	 * @returns {string} Base64 編碼的簽名
	 */
	_buildSignature(urlPath, method = "POST") {
		const accept = "application/json";
		const contentType = "application/json;charset=UTF-8";
		const textToSign = `${method}\n${accept}\n${contentType}\n${urlPath}`;
		const signature = crypto
			.createHmac("sha256", config.yscp.secretKey)
			.update(textToSign)
			.digest("base64");
		return signature;
	}

	/**
	 * 構建 YSCP API 請求配置（通用方法）
	 * @param {string} urlPath - API 路徑
	 * @param {string} method - HTTP 方法（預設 POST）
	 * @param {object} options - 額外選項
	 * @returns {object} 包含 headers、httpsAgent 等的配置對象
	 */
	_buildRequestConfig(urlPath, method = "POST", options = {}) {
		const accept = "application/json";
		const contentType = "application/json;charset=UTF-8";
		const signature = this._buildSignature(urlPath, method);

		return {
			headers: {
				Accept: accept,
				"Content-Type": contentType,
				"X-Ca-Key": config.yscp.accessKey,
				"X-Ca-Signature": signature,
			},
			httpsAgent: new https.Agent({
				rejectUnauthorized: config.yscp.rejectUnauthorized,
			}),
			timeout: 30000,
			...options,
		};
	}

	/**
	 * 獲取人員資訊（包含 picUri）
	 * @param {string|number} personId - 人員 ID
	 * @returns {Promise<object>} 人員資訊
	 */
	async getPersonInfo(personId) {
		try {
			const urlPath = `/artemis/api/resource/v1/person/personId/personInfo`;
			const fullUrl = `${config.yscp.host}${urlPath}`;
			const requestConfig = this._buildRequestConfig(urlPath);

			const response = await axios.post(
				fullUrl,
				{ personId: String(personId) },
				requestConfig
			);

			if (response.data.code !== "0") {
				throw new Error(
					`獲取人員資訊失敗: ${response.data.msg || "未知錯誤"}`
				);
			}

			return {
				success: true,
				data: response.data.data,
			};
		} catch (error) {
			serviceLogger.error("獲取人員資訊失敗", {
				personId,
				error: error.response?.data || error.message,
			});

			return {
				success: false,
				error: error.response?.data || error.message,
				status: error.response?.status || 500,
			};
		}
	}

	/**
	 * 獲取人員圖片（Base64）
	 * @param {string|number} personId - 人員 ID
	 * @param {string} picUri - 圖片 URI
	 * @returns {Promise<object>} 圖片資料（Base64）
	 */
	async getPersonPicture(personId, picUri) {
		try {
			const urlPath = `/artemis/api/resource/v1/person/picture_data`;
			const fullUrl = `${config.yscp.host}${urlPath}`;
			const requestConfig = this._buildRequestConfig(urlPath, "POST", {
				responseType: "text",
			});

			const response = await axios.post(
				fullUrl,
				{
					personId: String(personId),
					picUri: picUri,
				},
				requestConfig
			);

			let pictureData = null;
			
			if (typeof response.data === "string" && response.data.trim().startsWith("{")) {
				try {
					const jsonData = JSON.parse(response.data);
					if (jsonData.code !== "0") {
						throw new Error(
							`獲取人員圖片失敗: ${jsonData.msg || "未知錯誤"}`
						);
					}
					pictureData = jsonData.data;
				} catch (parseError) {
					serviceLogger.warn("響應不是標準 JSON 格式，嘗試作為 Base64 字符串處理", {
						personId,
						picUri,
					});
					pictureData = response.data;
				}
			} else if (typeof response.data === "string") {
				pictureData = response.data;
			} else if (response.data && typeof response.data === "object") {
				if (response.data.code !== "0") {
					throw new Error(
						`獲取人員圖片失敗: ${response.data.msg || "未知錯誤"}`
					);
				}
				pictureData = response.data.data;
			} else {
				throw new Error("無法解析響應數據格式");
			}

			if (typeof pictureData === "string" && pictureData.startsWith("data:image")) {
				const base64Match = pictureData.match(/data:image\/[^;]+;base64,(.+)/);
				if (base64Match && base64Match[1]) {
					pictureData = base64Match[1];
				}
			}

			return {
				success: true,
				data: pictureData,
			};
		} catch (error) {
			serviceLogger.error("獲取人員圖片失敗", {
				personId,
				picUri,
				error: error.response?.data || error.message,
				status: error.response?.status,
				responseType: typeof error.response?.data,
			});

			return {
				success: false,
				error: error.response?.data || error.message,
				status: error.response?.status || 500,
			};
		}
	}

	/**
	 * 批量獲取人員資訊和圖片
	 * @param {Array<number>} personIds - 人員 ID 列表
	 * @param {object} options - 選項
	 * @param {boolean} options.includePicture - 是否包含圖片（預設 false）
	 * @returns {Promise<Array<object>>} 人員資訊列表
	 */
	async getBatchPersonInfo(personIds, options = {}) {
		const { includePicture = false } = options;
		const results = [];

		for (const personId of personIds) {
			try {
				const personInfoResult = await this.getPersonInfo(personId);

				if (!personInfoResult.success) {
					results.push({
						personId,
						success: false,
						error: personInfoResult.error,
					});
					continue;
				}

				const personData = {
					personId,
					success: true,
					personInfo: personInfoResult.data,
				};

				if (
					includePicture &&
					personInfoResult.data?.personPhoto?.picUri
				) {
					const picUri =
						personInfoResult.data.personPhoto.picUri;
					const pictureResult = await this.getPersonPicture(
						personId,
						picUri
					);

					if (pictureResult.success) {
						personData.picture = pictureResult.data;
					} else {
						personData.pictureError = pictureResult.error;
					}
				}

				results.push(personData);
			} catch (error) {
				serviceLogger.error("處理人員資訊時發生錯誤", {
					personId,
					error: error.message,
				});
				results.push({
					personId,
					success: false,
					error: error.message,
				});
			}
		}

		return results;
	}

	/**
	 * 從文件讀取人員 ID 並批量獲取資訊
	 * @param {string} filePath - 文件路徑
	 * @param {object} options - 選項
	 * @param {boolean} options.includePicture - 是否包含圖片（預設 false）
	 * @returns {Promise<Array<object>>} 人員資訊列表
	 */
	async getPersonInfoFromFile(filePath, options = {}) {
		const personIds = await this.getPersonIdsFromFile(filePath);
		return await this.getBatchPersonInfo(personIds, options);
	}
}

module.exports = new YscpPersonService();

