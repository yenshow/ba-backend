const ModbusRTU = require("modbus-serial");
const EventEmitter = require("events");
const config = require("../../config");
const modbusGlobalLimiter = require("./modbusGlobalLimiter");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrors");

class ModbusClient extends EventEmitter {
  constructor(modbusConfig) {
    super();
    this.timeout = modbusConfig?.timeout ?? 10000;
    this.connecting = new Map();
    this.lastConnectedAt = new Map();
    this.clientConnections = new Map();
    this.inflightReads = new Map();
    /** @type {Map<string, Promise<void>>} host:port:unitId → 尾端 chain */
    this.endpointQueues = new Map();
  }

  getConnectionKey(host, port, unitId) {
    return `${host}:${port}:${unitId}`;
  }

  /**
   * 同端點 FIFO；錯誤不打斷後續工作。
   * @template T
   * @param {{ host: string, port: number, unitId: number }} deviceConfig
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  runOnEndpoint(deviceConfig, fn) {
    const key = this.getConnectionKey(
      deviceConfig.host,
      deviceConfig.port,
      deviceConfig.unitId,
    );
    const prev = this.endpointQueues.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => fn());
    this.endpointQueues.set(
      key,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  checkConnection(client, deviceConfig) {
    if (!client.isOpen) {
      throw createApiError(
        C.MODBUS_CONNECTION_CLOSED,
        `連接已斷開: Modbus 設備 ${deviceConfig.host}:${deviceConfig.port} 的連接已關閉，請重新連接。`,
      );
    }
  }

  cleanupConnection(deviceConfig) {
    const key = this.getConnectionKey(
      deviceConfig.host,
      deviceConfig.port,
      deviceConfig.unitId,
    );
    this.clientConnections.delete(key);
    this.lastConnectedAt.delete(key);
    this.invalidateReads(deviceConfig);
  }

  invalidateReads(deviceConfig, registerType = null) {
    const { host, port, unitId } = deviceConfig;
    const key = this.getConnectionKey(host, port, unitId);
    const kind = registerType === "coil" ? "coils" : registerType;
    const prefix = kind ? `${key}|${kind}|` : `${key}|`;
    for (const readKey of this.inflightReads.keys()) {
      if (readKey.startsWith(prefix)) this.inflightReads.delete(readKey);
    }
  }

  handleOperationError(error, client, deviceConfig, operationType) {
    if (
      !client.isOpen ||
      error.code === "ECONNRESET" ||
      error.code === "EPIPE"
    ) {
      this.cleanupConnection(deviceConfig);
      const operationName = operationType === "read" ? "讀取" : "寫入";
      throw createApiError(
        C.MODBUS_CONNECTION_INTERRUPTED,
        `連接已斷開: ${operationName}過程中連接被中斷，請檢查設備狀態。`,
      );
    }
    throw error;
  }

  formatConnectionError(error, host, port) {
    if (error.code === "ETIMEDOUT") {
      return createApiError(
        C.MODBUS_CONNECTION_TIMEOUT,
        `連接超時: 無法連接到 Modbus 設備 ${host}:${port}。請檢查設備是否已開啟，網路連線是否正常。`,
      );
    }
    if (error.code === "ECONNREFUSED") {
      return createApiError(
        C.MODBUS_CONNECTION_REFUSED,
        `連接被拒絕: Modbus 設備 ${host}:${port} 拒絕連接。請確認設備已開啟且 Modbus 服務正在運行。`,
      );
    }
    if (error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH") {
      return createApiError(
        C.MODBUS_CONNECTION_UNREACHABLE,
        `無法到達設備: Modbus 設備 ${host}:${port} 無法訪問。請檢查網路連線和 IP 位址是否正確。`,
      );
    }
    if (error?.code === C.MODBUS_CONNECTION_TIMEOUT) {
      return error;
    }
    if (error.message && error.message.includes("連接超時")) {
      return createApiError(C.MODBUS_CONNECTION_TIMEOUT, error.message);
    }
    return createApiError(
      C.MODBUS_CONNECTION_FAILED,
      `無法連接到 Modbus 設備 ${host}:${port} - ${error.message || error.code || "未知錯誤"}`,
    );
  }

  isTimeoutError(err) {
    return err?.message && /timed?\s*out/i.test(err.message);
  }

  async withTimeout(promise, timeout, errorMessage, errorCode = C.MODBUS_CONNECTION_TIMEOUT) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(createApiError(errorCode, errorMessage));
      }, timeout);
    });

    try {
      return await Promise.race([
        promise.finally(() => {
          if (timeoutId) clearTimeout(timeoutId);
        }),
        timeoutPromise,
      ]);
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      throw error;
    }
  }

  getClient(host, port, unitId) {
    const key = this.getConnectionKey(host, port, unitId);
    if (this.clientConnections.has(key)) {
      return this.clientConnections.get(key);
    }

    const newClient = new ModbusRTU();
    newClient.on("error", (err) => {
      this.emit("error", { connection: key, error: err });
    });

    this.clientConnections.set(key, newClient);
    return newClient;
  }

  /**
   * 建立或取得連線。呼叫端須已持有全域 limiter 席位（連線不另佔席）。
   */
  async ensureConnection(deviceConfig) {
    if (
      !deviceConfig ||
      !deviceConfig.host ||
      deviceConfig.port === undefined ||
      deviceConfig.unitId === undefined
    ) {
      throw createApiError(
        C.MODBUS_DEVICE_CONFIG_REQUIRED,
        "device configuration is required: { host, port, unitId }",
      );
    }

    const { host, port, unitId } = deviceConfig;
    const client = this.getClient(host, port, unitId);
    const key = this.getConnectionKey(host, port, unitId);

    if (client.isOpen) {
      if (client.getID() !== unitId) {
        client.setID(unitId);
      }
      return client;
    }

    if (this.connecting.has(key)) {
      return this.connecting.get(key);
    }

    const connectPromise = this.withTimeout(
      client.connectTCP(host, { port }),
      this.timeout,
      `連接超時: 無法在 ${this.timeout}ms 內連接到 ${host}:${port}`,
      C.MODBUS_CONNECTION_TIMEOUT,
    )
      .then(() => {
        client.setID(unitId);
        client.setTimeout(this.timeout);
        this.lastConnectedAt.set(key, new Date());
        this.emit("connected", { host, port, unitId });
        return client;
      })
      .catch((error) => {
        if (client.isOpen) {
          client.close().catch(() => {});
        }
        this.cleanupConnection({ host, port, unitId });
        this.emit("connection-error", { connection: key, error });
        throw this.formatConnectionError(error, host, port);
      })
      .finally(() => {
        this.connecting.delete(key);
      });

    this.connecting.set(key, connectPromise);
    return connectPromise;
  }

  /**
   * 在端點佇列＋全域 limiter 下執行一次 FC（含必要連線）。
   * @param {object} args
   * @param {{ host: string, port: number, unitId: number }} args.deviceConfig
   * @param {"read"|"write"} args.operationType
   * @param {string} args.timeoutMsg
   * @param {string} args.timeoutCode
   * @param {(client: import("modbus-serial")) => Promise<any>} args.execute
   */
  runFc({ deviceConfig, operationType, timeoutMsg, timeoutCode, execute }) {
    return this.runOnEndpoint(deviceConfig, () =>
      modbusGlobalLimiter.run(async () => {
        const client = await this.ensureConnection(deviceConfig);
        this.checkConnection(client, deviceConfig);
        try {
          return await this.withTimeout(
            execute(client),
            this.timeout,
            timeoutMsg,
            timeoutCode,
          );
        } catch (error) {
          if (this.isTimeoutError(error) || error?.code === timeoutCode) {
            throw createApiError(timeoutCode, timeoutMsg);
          }
          this.handleOperationError(error, client, deviceConfig, operationType);
        }
      }),
    );
  }

  async readHoldingRegisters(address, length, deviceConfig) {
    return this.readWithCoalescing(
      "holding",
      address,
      length,
      deviceConfig,
      (client) => client.readHoldingRegisters(address, length),
      `讀取超時: 無法在 ${this.timeout}ms 內讀取保持暫存器。設備可能無回應或連接已斷開。`,
    );
  }

  async readInputRegisters(address, length, deviceConfig) {
    return this.readWithCoalescing(
      "input",
      address,
      length,
      deviceConfig,
      (client) => client.readInputRegisters(address, length),
      `讀取超時: 無法在 ${this.timeout}ms 內讀取輸入暫存器。設備可能無回應或連接已斷開。`,
    );
  }

  async readCoils(address, length, deviceConfig) {
    return this.readWithCoalescing(
      "coils",
      address,
      length,
      deviceConfig,
      (client) => client.readCoils(address, length),
      `讀取超時: 無法在 ${this.timeout}ms 內讀取線圈。設備可能無回應或連接已斷開。`,
    );
  }

  async readDiscreteInputs(address, length, deviceConfig) {
    return this.readWithCoalescing(
      "discrete",
      address,
      length,
      deviceConfig,
      (client) => client.readDiscreteInputs(address, length),
      `讀取超時: 無法在 ${this.timeout}ms 內讀取離散輸入。設備可能無回應或連接已斷開。`,
    );
  }

  getReadKey(kind, address, length, deviceConfig) {
    const key = this.getConnectionKey(
      deviceConfig.host,
      deviceConfig.port,
      deviceConfig.unitId,
    );
    return `${key}|${kind}|${address}|${length}`;
  }

  async readWithCoalescing(kind, address, length, deviceConfig, reader, timeoutMsg) {
    const readKey = this.getReadKey(kind, address, length, deviceConfig);
    if (this.inflightReads.has(readKey)) {
      return this.inflightReads.get(readKey);
    }

    const promise = this.runFc({
      deviceConfig,
      operationType: "read",
      timeoutMsg,
      timeoutCode: C.MODBUS_READ_TIMEOUT,
      execute: async (client) => {
        const response = await reader(client);
        return response.data;
      },
    }).finally(() => {
      if (this.inflightReads.get(readKey) === promise) {
        this.inflightReads.delete(readKey);
      }
    });

    this.inflightReads.set(readKey, promise);
    return promise;
  }

  async writeCoil(address, value, deviceConfig) {
    const timeoutMsg = `寫入超時: 無法在 ${this.timeout}ms 內寫入線圈。設備可能無回應或連接已斷開。`;
    return this.runFc({
      deviceConfig,
      operationType: "write",
      timeoutMsg,
      timeoutCode: C.MODBUS_WRITE_TIMEOUT,
      execute: async (client) => {
        const response = await client.writeCoil(address, value);
        // modbus-serial FC5 回傳 { address, state }；舊碼讀 value 會讓 ON 永遠誤判失敗
        const echoed = response?.state ?? response?.value;
        if (echoed === undefined) {
          return response != null;
        }
        return Boolean(echoed) === Boolean(value);
      },
    });
  }

  async writeCoils(address, values, deviceConfig) {
    const timeoutMsg = `寫入超時: 無法在 ${this.timeout}ms 內寫入多個線圈。設備可能無回應或連接已斷開。`;
    return this.runFc({
      deviceConfig,
      operationType: "write",
      timeoutMsg,
      timeoutCode: C.MODBUS_WRITE_TIMEOUT,
      execute: async (client) => {
        const response = await client.writeCoils(address, values);
        return response.address === address && response.length === values.length;
      },
    });
  }

  async writeRegister(address, value, deviceConfig) {
    return this.writeRegisters(address, [value], deviceConfig);
  }

  async writeRegisters(address, values, deviceConfig) {
    const timeoutMsg = `寫入超時: 無法在 ${this.timeout}ms 內寫入暫存器。設備可能無回應或連接已斷開。`;
    return this.runFc({
      deviceConfig,
      operationType: "write",
      timeoutMsg,
      timeoutCode: C.MODBUS_WRITE_TIMEOUT,
      execute: async (client) => {
        const response = await client.writeRegisters(address, values);
        return response.address === address && response.length === values.length;
      },
    });
  }

  getStatus(deviceConfig) {
    if (
      !deviceConfig ||
      !deviceConfig.host ||
      deviceConfig.port === undefined ||
      deviceConfig.unitId === undefined
    ) {
      throw createApiError(
        C.MODBUS_DEVICE_CONFIG_REQUIRED,
        "device configuration is required: { host, port, unitId }",
      );
    }

    const { host, port, unitId } = deviceConfig;
    const key = this.getConnectionKey(host, port, unitId);
    const client = this.clientConnections.get(key);

    if (!client) {
      return {
        isOpen: false,
        host,
        port,
        unitId,
        lastConnectedAt: null,
      };
    }

    return {
      isOpen: client.isOpen,
      host,
      port,
      unitId,
      lastConnectedAt: this.lastConnectedAt.get(key) || null,
    };
  }

  async close(deviceConfig = null) {
    if (
      deviceConfig &&
      deviceConfig.host &&
      deviceConfig.port !== undefined &&
      deviceConfig.unitId !== undefined
    ) {
      const key = this.getConnectionKey(
        deviceConfig.host,
        deviceConfig.port,
        deviceConfig.unitId,
      );
      const client = this.clientConnections.get(key);

      if (client && client.isOpen) {
        await client.close();
        this.cleanupConnection(deviceConfig);
        this.emit("closed", { connection: key });
      }
      return;
    }

    const closePromises = [];
    for (const [key, client] of this.clientConnections.entries()) {
      if (client.isOpen) {
        const [host, port, unitId] = key.split(":");
        closePromises.push(
          client.close().then(() => {
            this.cleanupConnection({
              host,
              port: parseInt(port, 10),
              unitId: parseInt(unitId, 10),
            });
          }),
        );
      }
    }
    await Promise.all(closePromises);
    this.emit("closed");
  }
}

module.exports = new ModbusClient(config.modbus);
