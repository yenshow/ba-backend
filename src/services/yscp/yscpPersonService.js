const fs = require("fs");
const path = require("path");
const logger = require("../../utils/logger");
const yscpArtemisClient = require("./yscpArtemisClient");

const serviceLogger = logger.createLogger("YSCP Person Service");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

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
				throwApiError(C.YSCP_FILE_NOT_FOUND, `文件不存在: ${fullPath}`);
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
	 * 獲取人員資訊（包含 picUri）
	 * @param {string|number} personId - 人員 ID
	 * @returns {Promise<object>} 人員資訊
	 */
	async getPersonInfo(personId) {
		try {
			const urlPath = `/artemis/api/resource/v1/person/personId/personInfo`;
			const response = await yscpArtemisClient.post(urlPath, {
				personId: String(personId),
			});

			if (response.data.code !== "0") {
				throwApiError(
					C.YSCP_PERSON_INFO_FAILED,
					`獲取人員資訊失敗: ${response.data.msg || "未知錯誤"}`,
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
			const response = await yscpArtemisClient.post(
				urlPath,
				{
					personId: String(personId),
					picUri: picUri,
				},
				{ responseType: "text" },
			);

			let pictureData = null;
			
			if (typeof response.data === "string" && response.data.trim().startsWith("{")) {
				try {
					const jsonData = JSON.parse(response.data);
					if (jsonData.code !== "0") {
						throwApiError(
							C.YSCP_PERSON_PICTURE_FAILED,
							`獲取人員圖片失敗: ${jsonData.msg || "未知錯誤"}`,
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
					throwApiError(
						C.YSCP_PERSON_PICTURE_FAILED,
						`獲取人員圖片失敗: ${response.data.msg || "未知錯誤"}`,
					);
				}
				pictureData = response.data.data;
			} else {
				throwApiError(C.YSCP_RESPONSE_PARSE_FAILED, "無法解析響應數據格式");
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

