const ModbusRTU = require("modbus-serial");
const EventEmitter = require("events");
const config = require("../../config");

class ModbusClient extends EventEmitter {
	constructor(modbusConfig) {
		super();
		this.client = new ModbusRTU();
		this.timeout = modbusConfig?.timeout || 2000;
		this.connecting = new Map(); // 追蹤每個連接的連線狀態
		this.lastConnectedAt = new Map(); // 追蹤每個連接的最後連線時間
		this.clientConnections = new Map(); // 儲存多個設備連接
		this.client.on("error", (err) => {
			this.emit("error", err);
		});
	}

	// 產生連接的 key
	getConnectionKey(host, port, unitId) {
		return `${host}:${port}:${unitId}`;
	}

	// 檢查連接狀態
	checkConnection(client, deviceConfig) {
		if (!client.isOpen) {
			throw new Error(`連接已斷開: Modbus 設備 ${deviceConfig.host}:${deviceConfig.port} 的連接已關閉，請重新連接。`);
		}
	}

	// 清理連接狀態
	cleanupConnection(deviceConfig) {
		const key = this.getConnectionKey(deviceConfig.host, deviceConfig.port, deviceConfig.unitId);
		this.clientConnections.delete(key);
		this.lastConnectedAt.delete(key);
	}

	// 處理操作錯誤（連接斷開檢測）
	handleOperationError(error, client, deviceConfig, operationType) {
		if (!client.isOpen || error.code === "ECONNRESET" || error.code === "EPIPE") {
			this.cleanupConnection(deviceConfig);
			const operationName = operationType === "read" ? "讀取" : "寫入";
			throw new Error(`連接已斷開: ${operationName}過程中連接被中斷，請檢查設備狀態。`);
		}
		throw error;
	}

	// 格式化連接錯誤訊息
	formatConnectionError(error, host, port) {
		if (error.code === "ETIMEDOUT") {
			return new Error(`連接超時: 無法連接到 Modbus 設備 ${host}:${port}。請檢查設備是否已開啟，網路連線是否正常。`);
		}
		if (error.code === "ECONNREFUSED") {
			return new Error(`連接被拒絕: Modbus 設備 ${host}:${port} 拒絕連接。請確認設備已開啟且 Modbus 服務正在運行。`);
		}
		if (error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH") {
			return new Error(`無法到達設備: Modbus 設備 ${host}:${port} 無法訪問。請檢查網路連線和 IP 位址是否正確。`);
		}
		if (error.message && error.message.includes("連接超時")) {
			return new Error(error.message);
		}
		return new Error(`無法連接到 Modbus 設備 ${host}:${port} - ${error.message || error.code || "未知錯誤"}`);
	}

	// 為 Promise 添加超時處理
	async withTimeout(promise, timeout, errorMessage) {
		let timeoutId;
		const timeoutPromise = new Promise((_, reject) => {
			timeoutId = setTimeout(() => {
				reject(new Error(errorMessage));
			}, timeout);
		});

		try {
			return await Promise.race([
				promise.finally(() => {
					if (timeoutId) clearTimeout(timeoutId);
				}),
				timeoutPromise
			]);
		} catch (error) {
			if (timeoutId) clearTimeout(timeoutId);
			throw error;
		}
	}

	// 取得或建立客戶端連接
	getClient(host, port, unitId) {
		const key = this.getConnectionKey(host, port, unitId);

		// 如果已經有這個連接的客戶端，直接回傳
		if (this.clientConnections.has(key)) {
			return this.clientConnections.get(key);
		}

		// 建立新的客戶端連接
		const newClient = new ModbusRTU();
		newClient.on("error", (err) => {
			this.emit("error", { connection: key, error: err });
		});

		this.clientConnections.set(key, newClient);
		return newClient;
	}

	async ensureConnection(deviceConfig) {
		if (!deviceConfig || !deviceConfig.host || deviceConfig.port === undefined || deviceConfig.unitId === undefined) {
			throw new Error("device configuration is required: { host, port, unitId }");
		}

		const { host, port, unitId } = deviceConfig;
		const client = this.getClient(host, port, unitId);
		const key = this.getConnectionKey(host, port, unitId);

		if (client.isOpen) {
			// 如果已經連線，檢查是否需要更新 unitId
			if (client.getID() !== unitId) {
				client.setID(unitId);
			}
			return client;
		}

		// 檢查是否正在連線中
		if (this.connecting.has(key)) {
			return this.connecting.get(key);
		}

		// 創建帶有超時的連接 Promise
		const connectPromise = this.withTimeout(client.connectTCP(host, { port }), this.timeout, `連接超時: 無法在 ${this.timeout}ms 內連接到 ${host}:${port}`)
			.then(() => {
				client.setID(unitId);
				client.setTimeout(this.timeout);
				this.lastConnectedAt.set(key, new Date());
				this.emit("connected", {
					host,
					port,
					unitId
				});
				return client;
			})
			.catch((error) => {
				// 連接失敗時，清理連接狀態
				if (client.isOpen) {
					client.close().catch(() => {
						// 忽略關閉錯誤
					});
				}
				this.cleanupConnection({ host, port, unitId });
				this.emit("connection-error", { connection: key, error });
				// 改善錯誤訊息，提供更友好的提示
				throw this.formatConnectionError(error, host, port);
			})
			.finally(() => {
				this.connecting.delete(key);
			});

		this.connecting.set(key, connectPromise);

		return connectPromise;
	}

	async readHoldingRegisters(address, length, deviceConfig) {
		const client = await this.ensureConnection(deviceConfig);
		this.checkConnection(client, deviceConfig);
		try {
			const response = await this.withTimeout(
				client.readHoldingRegisters(address, length),
				this.timeout,
				`讀取超時: 無法在 ${this.timeout}ms 內讀取保持暫存器。設備可能無回應或連接已斷開。`
			);
			return response.data;
		} catch (error) {
			this.handleOperationError(error, client, deviceConfig, "read");
		}
	}

	async readInputRegisters(address, length, deviceConfig) {
		const client = await this.ensureConnection(deviceConfig);
		this.checkConnection(client, deviceConfig);
		try {
			const response = await this.withTimeout(
				client.readInputRegisters(address, length),
				this.timeout,
				`讀取超時: 無法在 ${this.timeout}ms 內讀取輸入暫存器。設備可能無回應或連接已斷開。`
			);
			return response.data;
		} catch (error) {
			this.handleOperationError(error, client, deviceConfig, "read");
		}
	}

	async readCoils(address, length, deviceConfig) {
		const client = await this.ensureConnection(deviceConfig);
		this.checkConnection(client, deviceConfig);
		try {
			const response = await this.withTimeout(
				client.readCoils(address, length),
				this.timeout,
				`讀取超時: 無法在 ${this.timeout}ms 內讀取線圈。設備可能無回應或連接已斷開。`
			);
			return response.data;
		} catch (error) {
			this.handleOperationError(error, client, deviceConfig, "read");
		}
	}

	async readDiscreteInputs(address, length, deviceConfig) {
		const client = await this.ensureConnection(deviceConfig);
		this.checkConnection(client, deviceConfig);
		try {
			const response = await this.withTimeout(
				client.readDiscreteInputs(address, length),
				this.timeout,
				`讀取超時: 無法在 ${this.timeout}ms 內讀取離散輸入。設備可能無回應或連接已斷開。`
			);
			return response.data;
		} catch (error) {
			this.handleOperationError(error, client, deviceConfig, "read");
		}
	}

	async writeCoil(address, value, deviceConfig) {
		const client = await this.ensureConnection(deviceConfig);
		this.checkConnection(client, deviceConfig);
		try {
			const response = await this.withTimeout(
				client.writeCoil(address, value),
				this.timeout,
				`寫入超時: 無法在 ${this.timeout}ms 內寫入線圈。設備可能無回應或連接已斷開。`
			);
			return response.value === value;
		} catch (error) {
			this.handleOperationError(error, client, deviceConfig, "write");
		}
	}

	async writeCoils(address, values, deviceConfig) {
		const client = await this.ensureConnection(deviceConfig);
		this.checkConnection(client, deviceConfig);
		try {
			const response = await this.withTimeout(
				client.writeCoils(address, values),
				this.timeout,
				`寫入超時: 無法在 ${this.timeout}ms 內寫入多個線圈。設備可能無回應或連接已斷開。`
			);
			return response.address === address && response.length === values.length;
		} catch (error) {
			this.handleOperationError(error, client, deviceConfig, "write");
		}
	}

	getStatus(deviceConfig) {
		if (!deviceConfig || !deviceConfig.host || deviceConfig.port === undefined || deviceConfig.unitId === undefined) {
			throw new Error("device configuration is required: { host, port, unitId }");
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
				lastConnectedAt: null
			};
		}

		return {
			isOpen: client.isOpen,
			host,
			port,
			unitId,
			lastConnectedAt: this.lastConnectedAt.get(key) || null
		};
	}

	async close(deviceConfig = null) {
		if (deviceConfig && deviceConfig.host && deviceConfig.port !== undefined && deviceConfig.unitId !== undefined) {
			// 關閉特定連接
			const key = this.getConnectionKey(deviceConfig.host, deviceConfig.port, deviceConfig.unitId);
			const client = this.clientConnections.get(key);

			if (client && client.isOpen) {
				await client.close();
				this.cleanupConnection(deviceConfig);
				this.emit("closed", { connection: key });
			}
		} else {
			// 關閉所有連接
			const closePromises = [];
			for (const [key, client] of this.clientConnections.entries()) {
				if (client.isOpen) {
					const [host, port, unitId] = key.split(":");
					closePromises.push(
						client.close().then(() => {
							this.cleanupConnection({ host, port: parseInt(port, 10), unitId: parseInt(unitId, 10) });
						})
					);
				}
			}
			if (this.client.isOpen) {
				closePromises.push(this.client.close());
			}
			await Promise.all(closePromises);
			this.emit("closed");
		}
	}
}

module.exports = new ModbusClient(config.modbus);
