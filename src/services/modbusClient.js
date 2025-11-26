const ModbusRTU = require("modbus-serial");
const EventEmitter = require("events");
const config = require("../config");

class ModbusClient extends EventEmitter {
	constructor(modbusConfig) {
		super();
		this.client = new ModbusRTU();
		this.timeout = modbusConfig?.timeout || 2000; // 只保留 timeout 作為全域設定
		this.connecting = new Map(); // 追蹤每個連接的連線狀態
		this.lastConnectedAt = null;
		this.clientConnections = new Map(); // 儲存多個設備連接
		this.client.on("error", (err) => {
			this.emit("error", err);
		});
	}

	// 產生連接的 key
	getConnectionKey(host, port, unitId) {
		return `${host}:${port}:${unitId}`;
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

		const connectPromise = client
			.connectTCP(host, { port })
			.then(() => {
				client.setID(unitId);
				client.setTimeout(this.timeout);
				this.lastConnectedAt = new Date();
				this.emit("connected", {
					host,
					port,
					unitId
				});
				return client;
			})
			.catch((error) => {
				this.emit("connection-error", { connection: key, error });
				throw error;
			})
			.finally(() => {
				this.connecting.delete(key);
			});

		this.connecting.set(key, connectPromise);

		return connectPromise;
	}

	async readHoldingRegisters(address, length, deviceConfig) {
		const client = await this.ensureConnection(deviceConfig);
		const response = await client.readHoldingRegisters(address, length);
		return response.data;
	}

	async readInputRegisters(address, length, deviceConfig) {
		const client = await this.ensureConnection(deviceConfig);
		const response = await client.readInputRegisters(address, length);
		return response.data;
	}

	async readCoils(address, length, deviceConfig) {
		const client = await this.ensureConnection(deviceConfig);
		const response = await client.readCoils(address, length);
		return response.data;
	}

	async readDiscreteInputs(address, length, deviceConfig) {
		const client = await this.ensureConnection(deviceConfig);
		const response = await client.readDiscreteInputs(address, length);
		return response.data;
	}

	async writeCoil(address, value, deviceConfig) {
		const client = await this.ensureConnection(deviceConfig);
		const response = await client.writeCoil(address, value);
		return response.value === value;
	}

	async writeCoils(address, values, deviceConfig) {
		const client = await this.ensureConnection(deviceConfig);
		const response = await client.writeCoils(address, values);
		return response.address === address && response.length === values.length;
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
			lastConnectedAt: this.lastConnectedAt
		};
	}

	async close(deviceConfig = null) {
		if (deviceConfig && deviceConfig.host && deviceConfig.port !== undefined && deviceConfig.unitId !== undefined) {
			// 關閉特定連接
			const { host, port, unitId } = deviceConfig;
			const key = this.getConnectionKey(host, port, unitId);
			const client = this.clientConnections.get(key);

			if (client && client.isOpen) {
				await client.close();
				this.clientConnections.delete(key);
				this.emit("closed", { connection: key });
			}
		} else {
			// 關閉所有連接
			const closePromises = [];
			for (const [key, client] of this.clientConnections.entries()) {
				if (client.isOpen) {
					closePromises.push(
						client.close().then(() => {
							this.clientConnections.delete(key);
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
