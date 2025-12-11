const net = require("net");
const ModbusRTU = require("modbus-serial");

const [host, port, unitId, type, startAddr, endAddr] = process.argv.slice(2);

if (!host || !port || !unitId || !type || !startAddr || !endAddr) {
	console.log(`
用法: node scripts/scanModbusAddresses.js <host> <port> <unitId> <type> <startAddress> <endAddress>

類型: discrete-inputs | coils | input-registers | holding-registers
範例: node scripts/scanModbusAddresses.js 192.168.2.202 502 1 holding-registers 0 100
	`);
	process.exit(1);
}

const client = new ModbusRTU();
const start = parseInt(startAddr, 10);
const end = parseInt(endAddr, 10);

const typeMap = {
	"discrete-inputs": { fc: "readDiscreteInputs", name: "Discrete Inputs (FC02)" },
	coils: { fc: "readCoils", name: "Coils (FC01)" },
	"input-registers": { fc: "readInputRegisters", name: "Input Registers (FC04)" },
	"holding-registers": { fc: "readHoldingRegisters", name: "Holding Registers (FC03)" }
};

const config = typeMap[type];
if (!config) {
	console.error(`錯誤：不支援的類型 "${type}"`);
	process.exit(1);
}

async function testTCPConnection() {
	return new Promise((resolve) => {
		const socket = new net.Socket();
		socket.setTimeout(3000);
		
		socket.on("connect", () => {
			socket.destroy();
			resolve(true);
		});

		socket.on("timeout", () => {
			socket.destroy();
			resolve(false);
		});

		socket.on("error", () => {
			resolve(false);
		});

		socket.connect(parseInt(port, 10), host);
	});
}

async function scan() {
	try {
		console.log(`\n開始掃描...`);
		console.log(`設備：${host}:${port}, Unit ID: ${unitId}`);
		console.log(`類型：${config.name}`);
		console.log(`地址範圍：${start} - ${end}`);
		console.log(`\n${"─".repeat(60)}\n`);

		console.log("測試 TCP 連接...");
		const tcpConnected = await testTCPConnection();
		if (!tcpConnected) {
			console.error("✗ TCP 連接失敗，請檢查設備是否在線");
			process.exit(1);
		}
		console.log("✓ TCP 連接成功\n");

		await client.connectTCP(host, { port: parseInt(port, 10) });
		client.setID(parseInt(unitId, 10));
		client.setTimeout(2000);

		console.log("✓ 已連接到設備\n");

		const foundAddresses = [];
		const batchSize = 10;

		for (let addr = start; addr <= end; addr += batchSize) {
			const length = Math.min(batchSize, end - addr + 1);

			try {
				const data = await client[config.fc](addr, length);

				if (data?.data?.length > 0) {
					for (let i = 0; i < length; i++) {
						foundAddresses.push({
							address: addr + i,
							value: data.data[i]
						});
					}
					process.stdout.write(`✓ 地址 ${addr}-${addr + length - 1}: 可用\n`);
				}
			} catch (error) {
				if (error.message.includes("Illegal data address")) {
					process.stdout.write(`✗ 地址 ${addr}-${addr + length - 1}: 不可用\n`);
				} else {
					process.stdout.write(`✗ 地址 ${addr}-${addr + length - 1}: 錯誤 - ${error.message}\n`);
				}
			}

			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		console.log(`\n${"─".repeat(60)}\n`);
		console.log(`掃描完成！找到 ${foundAddresses.length} 個可用的地址\n`);

		if (foundAddresses.length > 0) {
			console.log("可用的地址：\n");
			foundAddresses.slice(0, 20).forEach((item) => {
				const isRegister = type.includes("register");
				const display = isRegister ? `值 = ${item.value}` : `狀態 = ${item.value ? "ON" : "OFF"}`;
				console.log(`  地址 ${item.address}: ${display}`);
			});

			if (foundAddresses.length > 20) {
				console.log(`  ... 還有 ${foundAddresses.length - 20} 個地址`);
			}
		} else {
			console.log("⚠️  沒有找到可用的地址");
		}

		await client.close();
		process.exit(0);
	} catch (error) {
		console.error("\n錯誤：", error.message);
		process.exit(1);
	}
}

scan();
