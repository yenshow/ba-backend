/**
 * 人流統計地點管理服務
 *
 * 使用統一地點管理架構，location_type = 'people_counting'。
 * 兩大流程：data_source = 'yscp'（YSCP 資料庫，人員/統計來自外部）；data_source = 'access_control'（門禁設備本系統，人員與權限由人員管理 API 處理）。
 */

const config = require("../../config");
const locationService = require("./locationService");
const logger = require("../../utils/logger");
const yscpProvider = require("./peopleCounting/providers/yscpProvider");
const accessControlProvider = require("./peopleCounting/providers/accessControlProvider");
const isapiCameraProvider = require("./peopleCounting/providers/isapiCameraProvider");
const {
  parseEventType,
  countEntryExitFromSorted,
} = require("./peopleCounting/helpers/entryExitStats");

const PROVIDERS = {
  yscp: yscpProvider,
  access_control: accessControlProvider,
  isapi_camera: isapiCameraProvider,
};
const getProvider = (dataSource) =>
  PROVIDERS[
    dataSource === "access_control"
      ? "access_control"
      : dataSource === "isapi_camera"
        ? "isapi_camera"
        : "yscp"
  ] || yscpProvider;

// ========== 統一錯誤處理和驗證工具 ==========

/**
 * 創建驗證錯誤
 * @param {string} message - 錯誤訊息
 * @returns {Error} 帶有 statusCode 的錯誤對象
 */
function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/**
 * 統一錯誤處理包裝器
 * 用於業務邏輯錯誤（關鍵錯誤，需要拋出）
 * @param {Function} fn - 異步函數
 * @param {string} errorMessage - 錯誤訊息前綴
 * @param {Object} context - 上下文信息
 * @returns {Promise} 函數執行結果
 */
async function handleServiceError(fn, errorMessage, context = {}) {
  try {
    return await fn();
  } catch (error) {
    // 如果錯誤已經有 statusCode（驗證錯誤等），直接拋出
    if (error.statusCode) {
      throw error;
    }
    logger.error(errorMessage, {
      error,
      ...context,
      module: "peopleCountingService",
    });
    throw new Error(errorMessage + ": " + error.message);
  }
}

/**
 * 統一非關鍵錯誤處理（降級處理）
 * 用於非關鍵錯誤（可返回預設值）
 * @param {Function} fn - 異步函數
 * @param {string} warnMessage - 警告訊息
 * @param {*} defaultValue - 預設返回值
 * @param {Object} context - 上下文信息
 * @returns {Promise} 函數執行結果或預設值
 */
async function handleNonCriticalError(
  fn,
  warnMessage,
  defaultValue,
  context = {},
) {
  try {
    return await fn();
  } catch (error) {
    logger.warn(warnMessage, {
      error,
      ...context,
      module: "peopleCountingService",
    });
    return defaultValue;
  }
}

/**
 * 驗證地點資料
 * @param {Object} locationData - 地點資料
 * @param {boolean} isUpdate - 是否為更新操作
 * @throws {Error} 驗證失敗時拋出錯誤
 */
function validateLocationData(locationData, isUpdate = false) {
  const {
    name,
    zoneId,
    personGroupIds,
    entryDoorIds,
    exitDoorIds,
    dataSource = "yscp",
    entryDeviceIds,
    exitDeviceIds,
    cameraDeviceId,
    cameraDeviceIds,
    cameraChannelId,
    preferRegion,
  } = locationData;

  if (!name?.trim()) {
    throw createValidationError("地點名稱不能為空");
  }
  if (!isUpdate && !zoneId) {
    throw createValidationError("區域 ID 不能為空");
  }

  const effectiveDataSource =
    dataSource === "access_control"
      ? "access_control"
      : dataSource === "isapi_camera"
        ? "isapi_camera"
        : "yscp";

  if (effectiveDataSource === "yscp") {
    if (!isUpdate) {
      if (!Array.isArray(personGroupIds) || personGroupIds.length === 0) {
        throw createValidationError("至少需要選擇一個進場單位");
      }
      if (!Array.isArray(entryDoorIds) || entryDoorIds.length === 0) {
        throw createValidationError("至少需要選擇一個入口設備");
      }
      if (!Array.isArray(exitDoorIds) || exitDoorIds.length === 0) {
        throw createValidationError("至少需要選擇一個出口設備");
      }
    }
    if (isUpdate && personGroupIds !== undefined) {
      if (!Array.isArray(personGroupIds) || personGroupIds.length === 0) {
        throw createValidationError("至少需要選擇一個進場單位");
      }
    }
    if (entryDoorIds !== undefined && (!Array.isArray(entryDoorIds) || entryDoorIds.length === 0)) {
      throw createValidationError("至少需要選擇一個入口設備");
    }
    if (exitDoorIds !== undefined && (!Array.isArray(exitDoorIds) || exitDoorIds.length === 0)) {
      throw createValidationError("至少需要選擇一個出口設備");
    }
    const entrySet = new Set(
      (Array.isArray(entryDoorIds) ? entryDoorIds : [])
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
    const exitSet = new Set(
      (Array.isArray(exitDoorIds) ? exitDoorIds : [])
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
    for (const id of entrySet) {
      if (exitSet.has(id)) {
        throw createValidationError("入口和出口不能包含同一個設備");
      }
    }
  } else {
    if (effectiveDataSource === "access_control") {
      if (!isUpdate && (!Array.isArray(entryDeviceIds) || entryDeviceIds.length === 0)) {
        throw createValidationError("至少需要選擇一個門禁入口設備");
      }
      if (!isUpdate && (!Array.isArray(exitDeviceIds) || exitDeviceIds.length === 0)) {
        throw createValidationError("至少需要選擇一個門禁出口設備");
      }
      if (isUpdate && entryDeviceIds !== undefined && (!Array.isArray(entryDeviceIds) || entryDeviceIds.length === 0)) {
        throw createValidationError("至少需要選擇一個門禁入口設備");
      }
      if (isUpdate && exitDeviceIds !== undefined && (!Array.isArray(exitDeviceIds) || exitDeviceIds.length === 0)) {
        throw createValidationError("至少需要選擇一個門禁出口設備");
      }
      const entrySet = new Set(
        (Array.isArray(entryDeviceIds) ? entryDeviceIds : [])
          .map((id) => Number(id))
          .filter((n) => Number.isFinite(n) && n > 0),
      );
      const exitSet = new Set(
        (Array.isArray(exitDeviceIds) ? exitDeviceIds : [])
          .map((id) => Number(id))
          .filter((n) => Number.isFinite(n) && n > 0),
      );
      for (const id of entrySet) {
        if (exitSet.has(id)) {
          throw createValidationError("入口和出口不能包含同一個設備");
        }
      }
    }
    if (effectiveDataSource === "isapi_camera") {
      const cameraIds = Array.isArray(cameraDeviceIds)
        ? cameraDeviceIds.filter(
            (id) => typeof id === "number" && Number.isFinite(id) && id > 0,
          )
        : [];
      const hasAnyCamera = cameraIds.length > 0 || !!cameraDeviceId;

      if (!isUpdate && !hasAnyCamera) {
        throw createValidationError("至少需要選擇一台攝影機設備");
      }
      if (isUpdate && cameraDeviceIds !== undefined && cameraIds.length === 0) {
        throw createValidationError("至少需要選擇一台攝影機設備");
      }
      if (
        isUpdate &&
        cameraDeviceId !== undefined &&
        cameraDeviceIds === undefined &&
        !cameraDeviceId
      ) {
        // 向後相容：若只傳 cameraDeviceId（未傳 cameraDeviceIds），仍允許以單值更新
        throw createValidationError("攝影機設備 ID 不能為空");
      }
      if (
        cameraChannelId !== undefined &&
        cameraChannelId != null &&
        (!Number.isFinite(Number(cameraChannelId)) ||
          Number(cameraChannelId) <= 0)
      ) {
        throw createValidationError("攝影機 channelId 必須為正整數");
      }
    }
  }
}

/**
 * 確保陣列值
 * @param {*} value - 值
 * @returns {Array} 陣列
 */
function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

// ========== 地點管理 API ==========

/**
 * 取得人流統計地點列表
 */
async function getPeopleCountingLocations(options = {}) {
  return handleServiceError(
    async () => {
      const { zoneId } = options;

      // 使用統一服務，篩選 people_counting 類型
      const result = await locationService.getZones({
        locationType: "people_counting",
      });
      const zones = result.zones;

      // 如果指定了 zoneId，只返回該區域的地點
      if (zoneId) {
        const zone = zones.find((z) => String(z.id) === String(zoneId));
        if (zone) {
          return {
            locations: ensureArray(zone.locations),
          };
        }
        return { locations: [] };
      }

      // 返回所有地點（扁平化）
      const allLocations = zones.flatMap((zone) => ensureArray(zone.locations));
      return {
        locations: allLocations,
      };
    },
    "取得人流統計地點列表失敗",
    { options },
  );
}

/**
 * 取得單一地點
 */
async function getPeopleCountingLocationById(id) {
  return handleServiceError(
    async () => {
      // 先取得地點
      const locationResult = await locationService.getLocationById(id);
      const location = locationResult.location;

      // 驗證地點類型：檢查 systems 中是否有 people_counting 系統
      const hasPeopleCountingSystem = ensureArray(location.systems).some(
        (sys) => sys.systemType === "people_counting",
      );

      if (!hasPeopleCountingSystem) {
        throw createValidationError("地點類型不正確");
      }

      return { location };
    },
    "取得人流統計地點失敗",
    { id },
  );
}

/**
 * 建立人流統計地點
 */
async function createPeopleCountingLocation(locationData, userId) {
  return handleServiceError(
    async () => {
      const {
        name,
        zoneId,
        personGroupIds = [],
        entryDoorIds = [],
        exitDoorIds = [],
        dataSource = "yscp",
        entryDeviceIds = [],
        exitDeviceIds = [],
        cameraDeviceId,
        cameraChannelId,
        preferRegion,
        accessControlGroups = [], // 相容保留；門禁人員改由人員管理 person_location_access 處理
      } = locationData;

      validateLocationData(locationData, false);

      const result = await locationService.createLocation(
        {
          zoneId: parseInt(zoneId),
          name: name.trim(),
          locationType: "people_counting",
          config: {
            personGroupIds,
            entryDoorIds,
            exitDoorIds,
            dataSource,
            entryDeviceIds,
            exitDeviceIds,
            cameraDeviceId,
            cameraChannelId,
            preferRegion,
            accessControlGroups,
          },
        },
        userId,
      );

      return {
        message: "人流統計地點建立成功",
        location: result.location,
      };
    },
    "建立人流統計地點失敗",
    { userId },
  );
}

/**
 * 更新人流統計地點
 */
async function updatePeopleCountingLocation(id, locationData, userId) {
  return handleServiceError(
    async () => {
      const {
        name,
        personGroupIds,
        entryDoorIds,
        exitDoorIds,
        dataSource,
        entryDeviceIds,
        exitDeviceIds,
        cameraDeviceId,
        cameraChannelId,
        preferRegion,
        accessControlGroups,
      } = locationData;

      const existing = await getPeopleCountingLocationById(id);
      validateLocationData(locationData, true);

      const updates = {};
      if (name !== undefined) {
        updates.name = name.trim();
      }

      const pcSystem = ensureArray(existing.location.systems).find(
        (s) => s.systemType === "people_counting",
      );
      const existingConfig = pcSystem?.config || {};
      const currentConfig = {
        person_group_ids: existingConfig.personGroupIds || [],
        entry_door_ids: Array.isArray(existingConfig.entryDoorIds)
          ? existingConfig.entryDoorIds
          : [],
        exit_door_ids: Array.isArray(existingConfig.exitDoorIds)
          ? existingConfig.exitDoorIds
          : [],
        data_source: existingConfig.dataSource || "yscp",
        entry_device_ids: Array.isArray(existingConfig.entryDeviceIds)
          ? existingConfig.entryDeviceIds
          : [],
        exit_device_ids: Array.isArray(existingConfig.exitDeviceIds)
          ? existingConfig.exitDeviceIds
          : [],
        camera_device_id: existingConfig.cameraDeviceId ?? null,
        camera_device_ids: Array.isArray(existingConfig.cameraDeviceIds)
          ? existingConfig.cameraDeviceIds
              .map((id) => Number(id))
              .filter((n) => Number.isFinite(n) && n > 0)
          : [],
        camera_channel_id: existingConfig.cameraChannelId ?? 1,
        prefer_region: existingConfig.preferRegion ?? false,
        access_control_groups: existingConfig.accessControlGroups || [],
      };

      const config = {
        ...currentConfig,
        ...(personGroupIds !== undefined && {
          person_group_ids: personGroupIds,
        }),
        ...(entryDoorIds !== undefined && { entry_door_ids: entryDoorIds }),
        ...(exitDoorIds !== undefined && { exit_door_ids: exitDoorIds }),
        ...(dataSource !== undefined && { data_source: dataSource }),
        ...(entryDeviceIds !== undefined && {
          entry_device_ids: entryDeviceIds,
        }),
        ...(exitDeviceIds !== undefined && {
          exit_device_ids: exitDeviceIds,
        }),
        ...(cameraDeviceId !== undefined && {
          camera_device_id: cameraDeviceId,
        }),
        ...(cameraDeviceIds !== undefined && {
          camera_device_ids: Array.isArray(cameraDeviceIds)
            ? cameraDeviceIds
                .map((id) => Number(id))
                .filter((n) => Number.isFinite(n) && n > 0)
            : [],
        }),
        ...(cameraChannelId !== undefined && {
          camera_channel_id: cameraChannelId,
        }),
        ...(preferRegion !== undefined && {
          prefer_region: preferRegion,
        }),
        ...(accessControlGroups !== undefined && {
          access_control_groups: accessControlGroups,
        }),
      };

      const systemId = pcSystem?.id ? String(pcSystem.id) : null;

      const updateData = {
        ...(updates.name && { name: updates.name }),
        systems: [
          {
            ...(systemId && { id: systemId }),
            systemType: "people_counting",
            config: {
              personGroupIds: config.person_group_ids,
              entryDoorIds: config.entry_door_ids,
              exitDoorIds: config.exit_door_ids,
              dataSource: config.data_source,
              entryDeviceIds: config.entry_device_ids,
              exitDeviceIds: config.exit_device_ids,
              cameraDeviceId: config.camera_device_id,
              cameraDeviceIds: config.camera_device_ids,
              cameraChannelId: config.camera_channel_id,
              preferRegion: config.prefer_region,
              accessControlGroups: config.access_control_groups,
            },
          },
        ],
      };

      const result = await locationService.updateLocation(
        id,
        updateData,
        userId,
      );

      return {
        message: "人流統計地點更新成功",
        location: result.location,
      };
    },
    "更新人流統計地點失敗",
    { id, userId },
  );
}

/**
 * 刪除人流統計地點
 */
async function deletePeopleCountingLocation(id) {
  return handleServiceError(
    async () => {
      // 驗證地點是否存在且類型正確
      await getPeopleCountingLocationById(id);

      // 使用統一服務刪除地點
      return await locationService.deleteLocation(id);
    },
    "刪除人流統計地點失敗",
    { id },
  );
}

// ========== 業務邏輯 API ==========

/**
 * 生成刷卡記錄的唯一 ID
 * @param {number} personId - 人員 ID
 * @param {string} timestamp - 時間戳記
 * @returns {string} 唯一 ID
 */
function generateRecordId(personId, timestamp) {
  const timestampNum = new Date(timestamp).getTime();
  return `${personId}-${timestampNum}`;
}

/**
 * 取得所有工地列表（含統計）
 * 協調層：依 data_source 委派 provider.getSiteData / getSitesData
 */
async function getSites() {
  return handleServiceError(async () => {
    const locationsResult = await locationService.getZones({
      locationType: "people_counting",
    });
    const allLocations = ensureArray(locationsResult.zones).flatMap((zone) =>
      ensureArray(zone.locations),
    );
    if (allLocations.length === 0) return { sites: [] };

    const yscpList = [];
    const accessControlList = [];
    const isapiCameraList = [];
    for (const loc of allLocations) {
      const ds = getPeopleCountingConfig(loc).dataSource || "yscp";
      if (ds === "yscp" && config.features?.enableYscpPeopleCounting === false)
        continue;
      if (
        ds === "access_control" &&
        config.features?.enableAccessControlPersonnel === false
      )
        continue;
      if (ds === "access_control") accessControlList.push(loc);
      else if (ds === "isapi_camera") isapiCameraList.push(loc);
      else yscpList.push(loc);
    }

    const sites = [];
    if (yscpList.length > 0) {
      const yscpDataMap = await yscpProvider.getSitesData(
        yscpList,
        getPeopleCountingConfig,
      );
      for (const location of yscpList) {
        const locationId = normalizeId(location.id);
        const data = yscpDataMap.get(locationId);
        if (!data) continue;
        sites.push({
          id: locationId,
          name: location.name,
          dataSource: "yscp",
          entryCount: data.entryCount,
          exitCount: data.exitCount,
          units: data.units,
        });
      }
    }
    for (const location of accessControlList) {
      const locationId = normalizeId(location.id);
      const siteConfig = getPeopleCountingConfig(location);
      const data = await accessControlProvider.getSiteData(
        locationId,
        siteConfig,
      );
      sites.push({
        id: locationId,
        name: location.name,
        dataSource: "access_control",
        entryCount: data.entryCount,
        exitCount: data.exitCount,
        units: data.units,
      });
    }
    for (const location of isapiCameraList) {
      const locationId = normalizeId(location.id);
      const siteConfig = getPeopleCountingConfig(location);
      let data;
      try {
        data = await isapiCameraProvider.getSiteData(locationId, siteConfig);
      } catch (error) {
        data = { entryCount: 0, exitCount: 0, currentCount: 0, units: [] };
      }
      sites.push({
        id: locationId,
        name: location.name,
        dataSource: "isapi_camera",
        entryCount: data.entryCount,
        exitCount: data.exitCount,
        units: data.units,
      });
    }
    return { sites };
  }, "取得工地列表失敗");
}

/**
 * 取得工地統計
 * 協調層：依 data_source 委派 provider.getSiteData，回傳 entryCount / exitCount / currentCount
 */
async function getSiteStats(siteId) {
  return handleServiceError(
    async () => {
      const { dataSource, ...config } = await getSiteConfig(siteId);
      const provider = getProvider(dataSource);
      const data = await provider.getSiteData(siteId, config);
      return {
        entryCount: data.entryCount,
        exitCount: data.exitCount,
        currentCount: data.currentCount ?? 0,
      };
    },
    "取得工地統計失敗",
    { siteId },
  );
}

/**
 * 取得工地進出場記錄
 * 協調層：依 data_source 委派 provider.getSiteLogs
 */
async function getSiteLogs(siteId, options = {}) {
  return handleServiceError(
    async () => {
      const { dataSource, ...siteConfig } = await getSiteConfig(siteId);
      if (
        dataSource === "yscp" &&
        config.features?.enableYscpPeopleCounting === false
      ) {
        return { logs: [] };
      }
      const provider = getProvider(dataSource);
      const context = dataSource === "yscp" ? { generateRecordId } : {};
      return await provider.getSiteLogs(siteId, siteConfig, options, context);
    },
    "取得工地進出場記錄失敗",
    { siteId, options },
  );
}

/**
 * 取得單位人員列表
 * 協調層：依 data_source 委派 provider.getUnitPersonnel
 */
const YSCP_FALLBACK_CONFIG = {
  entryDoorIds: [],
  exitDoorIds: [],
  personGroupIds: [],
};

async function getUnitPersonnel(unitId, siteId = null) {
  return handleServiceError(
    async () => {
      if (!siteId)
        return await yscpProvider.getUnitPersonnel(
          unitId,
          null,
          YSCP_FALLBACK_CONFIG,
        );
      const siteConfig = await handleNonCriticalError(
        async () => await getSiteConfig(siteId),
        "無法取得工地配置，使用預設值",
        null,
        { siteId, unitId },
      );
      if (!siteConfig)
        return await yscpProvider.getUnitPersonnel(
          unitId,
          null,
          YSCP_FALLBACK_CONFIG,
        );
      const { dataSource, ...cfg } = siteConfig;
      return await getProvider(dataSource).getUnitPersonnel(
        unitId,
        siteId,
        cfg,
      );
    },
    "取得單位人員列表失敗",
    { unitId, siteId },
  );
}

// ========== 共同邏輯：地點與 config ==========

/**
 * 從地點取得人流統計系統配置
 * @param {Object} location - 地點物件
 * @returns {Object} { peopleCountingSystem, entryDoorIds, exitDoorIds, personGroupIds, dataSource, entryDeviceIds, exitDeviceIds, accessControlGroups }
 * @deprecated accessControlGroups 僅相容保留；門禁流程之可進出人員改由 personnelService.getPersonsWithAccessByLocationId 取得
 */
function getPeopleCountingConfig(location) {
  const peopleCountingSystem = ensureArray(location.systems).find(
    (sys) => sys.systemType === "people_counting",
  );
  return {
    peopleCountingSystem,
    entryDoorIds: ensureArray(peopleCountingSystem?.config?.entryDoorIds),
    exitDoorIds: ensureArray(peopleCountingSystem?.config?.exitDoorIds),
    personGroupIds: ensureArray(peopleCountingSystem?.config?.personGroupIds),
    dataSource: peopleCountingSystem?.config?.dataSource || "yscp",
    entryDeviceIds: ensureArray(peopleCountingSystem?.config?.entryDeviceIds),
    exitDeviceIds: ensureArray(peopleCountingSystem?.config?.exitDeviceIds),
    cameraDeviceId: peopleCountingSystem?.config?.cameraDeviceId ?? null,
    cameraChannelId: peopleCountingSystem?.config?.cameraChannelId ?? 1,
    preferRegion: peopleCountingSystem?.config?.preferRegion ?? false,
    accessControlGroups: ensureArray(
      peopleCountingSystem?.config?.accessControlGroups,
    ),
  };
}

/**
 * 取得工地配置（統一處理地點取得和配置解析）
 * @param {number} siteId - 工地 ID
 * @returns {Promise<Object>} { location, personGroupIds, entryDoorIds, exitDoorIds, dataSource, entryDeviceIds, exitDeviceIds, accessControlGroups }
 * @deprecated accessControlGroups 僅相容保留
 */
async function getSiteConfig(siteId) {
  const locationResult = await getPeopleCountingLocationById(siteId);
  const location = locationResult.location;
  const config = getPeopleCountingConfig(location);
  return {
    location,
    personGroupIds: config.personGroupIds,
    entryDoorIds: config.entryDoorIds,
    exitDoorIds: config.exitDoorIds,
    dataSource: config.dataSource,
    entryDeviceIds: config.entryDeviceIds,
    exitDeviceIds: config.exitDeviceIds,
    cameraDeviceId: config.cameraDeviceId,
    cameraChannelId: config.cameraChannelId,
    preferRegion: config.preferRegion,
    accessControlGroups: config.accessControlGroups,
  };
}

/**
 * 統一 ID 類型轉換（確保 ID 為數字）
 * @param {string|number} id - ID 值
 * @returns {number} 轉換後的數字 ID
 */
function normalizeId(id) {
  return typeof id === "string" ? Number(id) : id;
}

module.exports = {
  // 地點管理
  getPeopleCountingLocations,
  getPeopleCountingLocationById,
  createPeopleCountingLocation,
  updatePeopleCountingLocation,
  deletePeopleCountingLocation,
  // 輔助函數（供其他模組使用）
  getPeopleCountingConfig,
  generateRecordId,
  parseEventType,
  countEntryExitFromSorted,
  // 業務邏輯 API
  getSites,
  getSiteStats,
  getSiteLogs,
  getUnitPersonnel,
};
