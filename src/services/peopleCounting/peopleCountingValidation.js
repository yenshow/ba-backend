/**
 * 人流統計地點設定驗證（people_counting system_config / API payload）
 */
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { peopleCounting: yscpFeature } = require("../../utils/yscpSystemFeature");
const { ensureIntArray } = require("../location/locationShared");

const optionalPositiveDeviceId = (value, label) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throwApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      `${label}須為有效設備 ID`,
    );
  }
  return Math.trunc(n);
};
const {
  normalizeCameraMode,
  CAMERA_MODE,
} = require("./peopleCountingConfig");

/**
 * 驗證地點資料（API camelCase）
 * @param {Object} locationData
 * @param {boolean} isUpdate
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
    cameraDeviceIds,
    entryCameraDeviceIds,
    exitCameraDeviceIds,
    cameraMode,
    entryEventCameraDeviceId,
    exitEventCameraDeviceId,
  } = locationData;

  if (!name?.trim()) {
    throwApiError(C.PEOPLE_COUNTING_VALIDATION_FAILED, "地點名稱不能為空");
  }
  if (!isUpdate && !zoneId) {
    throwApiError(C.PEOPLE_COUNTING_VALIDATION_FAILED, "區域 ID 不能為空");
  }

  const effectiveDataSource =
    dataSource === "access_control"
      ? "access_control"
      : dataSource === "isapi_camera"
        ? "isapi_camera"
        : "yscp";

  if (yscpFeature.shouldSkipYscp(effectiveDataSource)) {
    throwApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      "YSCP 人流資料源已關閉，請改用門禁設備或攝影機人流",
    );
  }

  if (effectiveDataSource === "yscp") {
    if (!isUpdate) {
      if (!Array.isArray(personGroupIds) || personGroupIds.length === 0) {
        throwApiError(
          C.PEOPLE_COUNTING_VALIDATION_FAILED,
          "至少需要選擇一個人員群組",
        );
      }
      if (!Array.isArray(entryDoorIds) || entryDoorIds.length === 0) {
        throwApiError(
          C.PEOPLE_COUNTING_VALIDATION_FAILED,
          "至少需要選擇一個入口設備",
        );
      }
      if (!Array.isArray(exitDoorIds) || exitDoorIds.length === 0) {
        throwApiError(
          C.PEOPLE_COUNTING_VALIDATION_FAILED,
          "至少需要選擇一個出口設備",
        );
      }
    }
    if (isUpdate && personGroupIds !== undefined) {
      if (!Array.isArray(personGroupIds) || personGroupIds.length === 0) {
        throwApiError(
          C.PEOPLE_COUNTING_VALIDATION_FAILED,
          "至少需要選擇一個人員群組",
        );
      }
    }
    if (
      entryDoorIds !== undefined &&
      (!Array.isArray(entryDoorIds) || entryDoorIds.length === 0)
    ) {
      throwApiError(
        C.PEOPLE_COUNTING_VALIDATION_FAILED,
        "至少需要選擇一個入口設備",
      );
    }
    if (
      exitDoorIds !== undefined &&
      (!Array.isArray(exitDoorIds) || exitDoorIds.length === 0)
    ) {
      throwApiError(
        C.PEOPLE_COUNTING_VALIDATION_FAILED,
        "至少需要選擇一個出口設備",
      );
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
        throwApiError(
          C.PEOPLE_COUNTING_VALIDATION_FAILED,
          "入口和出口不能包含同一個設備",
        );
      }
    }
  } else {
    if (effectiveDataSource === "access_control") {
      if (
        !isUpdate &&
        (!Array.isArray(entryDeviceIds) || entryDeviceIds.length === 0)
      ) {
        throwApiError(
          C.PEOPLE_COUNTING_VALIDATION_FAILED,
          "至少需要選擇一個門禁入口設備",
        );
      }
      if (
        !isUpdate &&
        (!Array.isArray(exitDeviceIds) || exitDeviceIds.length === 0)
      ) {
        throwApiError(
          C.PEOPLE_COUNTING_VALIDATION_FAILED,
          "至少需要選擇一個門禁出口設備",
        );
      }
      if (
        isUpdate &&
        entryDeviceIds !== undefined &&
        (!Array.isArray(entryDeviceIds) || entryDeviceIds.length === 0)
      ) {
        throwApiError(
          C.PEOPLE_COUNTING_VALIDATION_FAILED,
          "至少需要選擇一個門禁入口設備",
        );
      }
      if (
        isUpdate &&
        exitDeviceIds !== undefined &&
        (!Array.isArray(exitDeviceIds) || exitDeviceIds.length === 0)
      ) {
        throwApiError(
          C.PEOPLE_COUNTING_VALIDATION_FAILED,
          "至少需要選擇一個門禁出口設備",
        );
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
          throwApiError(
            C.PEOPLE_COUNTING_VALIDATION_FAILED,
            "入口和出口不能包含同一個設備",
          );
        }
      }
      optionalPositiveDeviceId(
        entryEventCameraDeviceId,
        "入口事件調閱攝影機",
      );
      optionalPositiveDeviceId(
        exitEventCameraDeviceId,
        "出口事件調閱攝影機",
      );
    }
    if (effectiveDataSource === "isapi_camera") {
      const mode = normalizeCameraMode(cameraMode);
      if (cameraMode !== undefined) {
        const raw = String(cameraMode || "").trim();
        if (
          raw !== "" &&
          raw !== CAMERA_MODE.PEOPLE_COUNTING &&
          raw !== CAMERA_MODE.FACE_RECOGNITION
        ) {
          throwApiError(
            C.PEOPLE_COUNTING_VALIDATION_FAILED,
            "攝影機模式須為 people_counting 或 face_recognition",
          );
        }
      }

      if (mode === CAMERA_MODE.FACE_RECOGNITION) {
        const entryCam = ensureIntArray(entryCameraDeviceIds);
        const exitCam = ensureIntArray(exitCameraDeviceIds);
        const touchingEntryExit =
          entryCameraDeviceIds !== undefined ||
          exitCameraDeviceIds !== undefined ||
          !isUpdate;

        if (touchingEntryExit) {
          if (entryCam.length === 0) {
            throwApiError(
              C.PEOPLE_COUNTING_VALIDATION_FAILED,
              "人臉辨識模式至少需要選擇一台入口攝影機",
            );
          }
          if (exitCam.length === 0) {
            throwApiError(
              C.PEOPLE_COUNTING_VALIDATION_FAILED,
              "人臉辨識模式至少需要選擇一台出口攝影機",
            );
          }
          const entrySet = new Set(entryCam);
          for (const id of exitCam) {
            if (entrySet.has(id)) {
              throwApiError(
                C.PEOPLE_COUNTING_VALIDATION_FAILED,
                "入口與出口攝影機不能為同一設備",
              );
            }
          }
        }
      } else {
        const cameraIds = ensureIntArray(cameraDeviceIds);
        if (!isUpdate && cameraIds.length === 0) {
          throwApiError(
            C.PEOPLE_COUNTING_VALIDATION_FAILED,
            "至少需要選擇一台攝影機設備",
          );
        }
        if (
          isUpdate &&
          cameraDeviceIds !== undefined &&
          cameraIds.length === 0
        ) {
          throwApiError(
            C.PEOPLE_COUNTING_VALIDATION_FAILED,
            "至少需要選擇一台攝影機設備",
          );
        }
      }
    }
  }
}

/**
 * 驗證 DB system_config（snake_case），供 location_systems 寫入前使用
 * @param {object} systemConfig
 * @param {{ name: string, zoneId?: number|string, isUpdate?: boolean }} context
 */
function validatePeopleCountingSystemConfig(systemConfig, context) {
  const cfg = systemConfig && typeof systemConfig === "object" ? systemConfig : {};
  validateLocationData(
    {
      name: context.name,
      zoneId: context.zoneId,
      personGroupIds: ensureIntArray(cfg.person_group_ids),
      entryDoorIds: ensureIntArray(cfg.entry_door_ids),
      exitDoorIds: ensureIntArray(cfg.exit_door_ids),
      dataSource: cfg.data_source || "yscp",
      entryDeviceIds: ensureIntArray(cfg.entry_device_ids),
      exitDeviceIds: ensureIntArray(cfg.exit_device_ids),
      cameraDeviceIds: ensureIntArray(cfg.camera_device_ids),
      entryCameraDeviceIds: ensureIntArray(cfg.entry_camera_device_ids),
      exitCameraDeviceIds: ensureIntArray(cfg.exit_camera_device_ids),
      preferRegion: cfg.prefer_region,
      cameraMode: normalizeCameraMode(cfg.camera_mode),
      entryEventCameraDeviceId: cfg.entry_event_camera_device_id,
      exitEventCameraDeviceId: cfg.exit_event_camera_device_id,
    },
    context.isUpdate === true,
  );
}

module.exports = {
  validateLocationData,
  validatePeopleCountingSystemConfig,
};
