/**
 * 設備資料記錄服務
 * 負責記錄設備的實際數值到 device_data_logs 表
 */

const db = require("../../database/db");
const { parseConfig } = require("../../utils/deviceHelpers");

class DeviceDataLogger {
  constructor() {
    this.writeBuffer = []; // 寫入緩衝區
    this.batchSize = 100; // 批次大小
    this.flushInterval = 5000; // 刷新間隔（毫秒）
    this.flushTimer = null;
    this.isFlushing = false;
    this.configCache = new Map(); // 配置快取
  }

  /**
   * 啟動定時刷新
   */
  start() {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setInterval(() => {
      if (!this.isFlushing && this.writeBuffer.length > 0) {
        this.flushBuffer().catch((error) => {
          console.error("[deviceDataLogger] 定時刷新失敗:", error);
        });
      }
    }, this.flushInterval);

    console.log("[deviceDataLogger] 已啟動定時刷新（間隔:", this.flushInterval, "ms）");
  }

  /**
   * 停止定時刷新
   */
  stop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // 刷新剩餘的緩衝區
    if (this.writeBuffer.length > 0) {
      this.flushBuffer().catch((error) => {
        console.error("[deviceDataLogger] 停止時刷新失敗:", error);
      });
    }
  }

  /**
   * 取得設備記錄配置
   * @param {number} deviceId - 設備 ID
   * @returns {Promise<Object>} 記錄配置
   */
  async getDeviceLoggingConfig(deviceId) {
    // 檢查快取
    if (this.configCache.has(deviceId)) {
      return this.configCache.get(deviceId);
    }

    try {
      // 讀取設備配置
      const device = await db.query(
        `SELECT d.config, dm.config as model_config
         FROM devices d
         LEFT JOIN device_models dm ON d.model_id = dm.id
         WHERE d.id = $1`,
        [deviceId]
      );

      if (!device || device.length === 0) {
        return { enabled: false, interval: 60, values: [] };
      }

      // 合併配置（設備配置優先）
      const deviceConfig = parseConfig(device[0].config);
      const modelConfig = parseConfig(device[0].model_config);

      const loggingConfig = {
        enabled:
          deviceConfig?.logging?.enabled ?? modelConfig?.logging?.enabled ?? false,
        interval:
          deviceConfig?.logging?.interval ?? modelConfig?.logging?.interval ?? 60,
        values:
          deviceConfig?.logging?.values ?? modelConfig?.logging?.values ?? [],
      };

      // 快取配置（5 分鐘過期）
      this.configCache.set(deviceId, loggingConfig);
      setTimeout(() => {
        this.configCache.delete(deviceId);
      }, 5 * 60 * 1000);

      return loggingConfig;
    } catch (error) {
      console.error(`[deviceDataLogger] 取得設備配置失敗 (deviceId: ${deviceId}):`, error);
      return { enabled: false, interval: 60, values: [] };
    }
  }

  /**
   * 從 Modbus 讀數轉換為實際數值
   * @param {Array} modbusData - Modbus 讀數資料
   * @param {Object} config - 記錄配置
   * @returns {Object} 轉換後的數值物件
   */
  convertModbusToValues(modbusData, config) {
    const values = {};

    if (!config || !config.values || !Array.isArray(config.values)) {
      return values;
    }

    for (const valueConfig of config.values) {
      if (!valueConfig.enabled) continue;

      // 從 Modbus 資料中提取對應的讀數
      const rawValue = this.extractModbusValue(modbusData, valueConfig);

      if (rawValue === null || rawValue === undefined) continue;

      // 套用轉換公式
      const convertedValue = this.applyConversion(rawValue, valueConfig.conversion);

      values[valueConfig.name] = {
        value: convertedValue,
        unit: valueConfig.conversion?.unit || null,
      };
    }

    return values;
  }

  /**
   * 從 Modbus 資料中提取數值
   * @param {Array} modbusData - Modbus 資料陣列
   * @param {Object} valueConfig - 數值配置
   * @returns {number|Array|null} 提取的數值
   */
  extractModbusValue(modbusData, valueConfig) {
    const { address, length = 1 } = valueConfig;

    if (Array.isArray(modbusData)) {
      if (address < modbusData.length) {
        return length === 1
          ? modbusData[address]
          : modbusData.slice(address, address + length);
      }
    }

    return null;
  }

  /**
   * 套用數值轉換
   * @param {number} rawValue - 原始數值
   * @param {Object} conversion - 轉換配置
   * @returns {number} 轉換後的數值
   */
  applyConversion(rawValue, conversion) {
    if (!conversion) return rawValue;

    let value = rawValue;

    // 套用縮放和偏移
    if (conversion.scale !== undefined) {
      value = value * conversion.scale;
    }
    if (conversion.offset !== undefined) {
      value = value + conversion.offset;
    }

    // 套用公式（如果提供）
    if (conversion.formula) {
      try {
        // 將公式中的 value 替換為實際數值
        const formula = conversion.formula.replace(/value/g, value);
        // 使用 Function 構造函數安全地執行公式（避免 eval 的安全問題）
        value = new Function("return " + formula)();
      } catch (error) {
        console.error(`[deviceDataLogger] 公式轉換失敗 (formula: ${conversion.formula}):`, error);
        return rawValue;
      }
    }

    return value;
  }

  /**
   * 記錄設備數值
   * @param {number} deviceId - 設備 ID
   * @param {Object} values - 數值物件 { name: { value, unit }, ... }
   * @param {Object} config - 可選的記錄配置（如果提供則跳過查詢）
   * @returns {Promise<void>}
   */
  async logDeviceValues(deviceId, values, config = null) {
    try {
      // 檢查配置（如果未提供則查詢）
      const loggingConfig = config || await this.getDeviceLoggingConfig(deviceId);
      if (!loggingConfig.enabled) {
        return;
      }

      // 將數值轉換為記錄格式
      const timestamp = new Date();
      for (const [valueName, valueData] of Object.entries(values)) {
        // 檢查是否需要記錄此數值
        const valueConfig = loggingConfig.values?.find((v) => v.name === valueName);
        if (!valueConfig || !valueConfig.enabled) continue;

        // 加入緩衝區
        this.writeBuffer.push({
          device_id: deviceId,
          register_type: valueConfig.register_type,
          address: valueConfig.address,
          value: JSON.stringify({
            name: valueName,
            value: valueData.value,
            unit: valueData.unit || null,
            timestamp: timestamp.toISOString(),
          }),
          recorded_at: timestamp,
        });
      }

      // 如果達到批次大小，立即寫入
      if (this.writeBuffer.length >= this.batchSize) {
        await this.flushBuffer();
      }
    } catch (error) {
      console.error(`[deviceDataLogger] 記錄設備數值失敗 (deviceId: ${deviceId}):`, error);
    }
  }

  /**
   * 批次寫入緩衝區
   * @returns {Promise<void>}
   */
  async flushBuffer() {
    if (this.isFlushing || this.writeBuffer.length === 0) {
      return;
    }

    this.isFlushing = true;
    const batch = [...this.writeBuffer];
    this.writeBuffer = [];

    try {
      // 批次寫入
      if (batch.length > 0) {
        const placeholders = batch
          .map((_, i) => {
            const base = i * 5;
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
          })
          .join(", ");

        const params = batch.flatMap((r) => [
          r.device_id,
          r.register_type,
          r.address,
          r.value,
          r.recorded_at,
        ]);

        await db.query(
          `INSERT INTO device_data_logs (device_id, register_type, address, value, recorded_at)
           VALUES ${placeholders}`,
          params
        );

        console.log(`[deviceDataLogger] 批次寫入 ${batch.length} 筆記錄`);
      }
    } catch (error) {
      console.error(`[deviceDataLogger] 批次寫入失敗:`, error);
      // 可選：將失敗的記錄加入重試佇列（目前先記錄錯誤）
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * 清除配置快取
   * @param {number} deviceId - 設備 ID（可選，不提供則清除所有）
   */
  clearCache(deviceId = null) {
    if (deviceId) {
      this.configCache.delete(deviceId);
    } else {
      this.configCache.clear();
    }
  }
}

// 建立單例
const deviceDataLogger = new DeviceDataLogger();

module.exports = deviceDataLogger;

