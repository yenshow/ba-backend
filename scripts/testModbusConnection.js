const net = require("net");
const ModbusRTU = require("modbus-serial");

const [host, port = "502"] = process.argv.slice(2);

if (!host) {
	console.log(`
用法: node scripts/testModbusConnection.js <host> [port]
範例: node scripts/testModbusConnection.js 192.168.2.204 502
	`);
	process.exit(1);
}

const testPort = parseInt(port, 10);

async function testTCPConnection() {
	return new Promise((resolve) => {
		const socket = new net.Socket();
		socket.setTimeout(3000);

		socket.on("connect", () => {
			console.log(`✓ TCP 連接成功：${host}:${testPort}`);
			socket.destroy();
			resolve(true);
		});

		socket.on("timeout", () => {
			console.log(`✗ TCP 連接超時：${host}:${testPort}`);
			socket.destroy();
			resolve(false);
		});

		socket.on("error", (err) => {
			const messages = {
				ECONNREFUSED: `✗ TCP 連接被拒絕：${host}:${testPort}`,
				EHOSTUNREACH: `✗ 無法到達設備：${host}:${testPort}`,
				ENETUNREACH: `✗ 無法到達設備：${host}:${testPort}`
			};
			console.log(messages[err.code] || `✗ TCP 連接錯誤：${err.message}`);
			resolve(false);
		});

		socket.connect(testPort, host);
	});
}

async function findUnitId() {
	const unitIdsToTest = [1, 204, 205, 247];
	
	for (const unitId of unitIdsToTest) {
		const client = new ModbusRTU();
		try {
			await client.connectTCP(host, { port: testPort });
			client.setID(unitId);
			client.setTimeout(2000);
			await client.readHoldingRegisters(0, 1);
			await client.close();
			return unitId;
		} catch (error) {
			if (client.isOpen) await client.close();
			if (error.message.includes("Illegal data address")) {
				return unitId;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return null;
}

async function testRegisterTypes(unitId) {
	const client = new ModbusRTU();
	const tests = [
		{ key: "holding", fn: () => client.readHoldingRegisters(0, 1), name: "Holding Registers (FC03)" },
		{ key: "input", fn: () => client.readInputRegisters(0, 1), name: "Input Registers (FC04)" },
		{ key: "coils", fn: () => client.readCoils(0, 1), name: "Coils (FC01)" },
		{ key: "discrete", fn: () => client.readDiscreteInputs(0, 1), name: "Discrete Inputs (FC02)" }
	];
	const results = {};

	try {
		await client.connectTCP(host, { port: testPort });
		client.setID(unitId);
		client.setTimeout(2000);

		for (const test of tests) {
			try {
				const response = await test.fn();
				results[test.key] = { success: true, value: response.data[0], name: test.name };
			} catch (err) {
				results[test.key] = { success: false, error: err.message, name: test.name };
			}
		}

		await client.close();
		return results;
	} catch (error) {
		if (client.isOpen) await client.close();
		throw error;
	}
}

async function main() {
	console.log(`\n${"=".repeat(60)}`);
	console.log(`Modbus 連接診斷工具`);
	console.log(`${"=".repeat(60)}\n`);
	console.log(`目標設備：${host}:${testPort}\n`);

	console.log(`[步驟 1] 測試 TCP 連接...`);
	const tcpConnected = await testTCPConnection();
	console.log();

	if (!tcpConnected) {
		console.log(`\n⚠️  TCP 連接失敗，無法繼續測試 Modbus 協議。`);
		process.exit(1);
	}

	console.log(`[步驟 2] 自動檢測 Unit ID...\n`);
	const unitId = await findUnitId();

	if (!unitId) {
		console.log(`⚠️  無法找到正確的 Unit ID`);
		process.exit(1);
	}

	console.log(`✓ 找到 Unit ID: ${unitId}\n`);

	console.log(`[步驟 3] 測試寄存器類型...\n`);
	try {
		const results = await testRegisterTypes(unitId);

		Object.values(results).forEach((result) => {
			console.log(`${result.name}:`);
			if (result.success) {
				const isRegister = result.name.includes("Register");
				const display = isRegister ? `值：${result.value}` : `狀態：${result.value ? "ON" : "OFF"}`;
				console.log(`  ✓ 可用 - 地址 0 的 ${display}`);
			} else {
				console.log(`  ✗ ${result.error}`);
			}
			console.log();
		});

		console.log(`${"=".repeat(60)}`);
		console.log(`診斷完成！建議配置：`);
		console.log(`  host: ${host}`);
		console.log(`  port: ${testPort}`);
		console.log(`  unitId: ${unitId}`);
		console.log(`${"=".repeat(60)}\n`);
	} catch (error) {
		console.log(`\n✗ 測試寄存器時發生錯誤：${error.message}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(`\n錯誤：${error.message}`);
	process.exit(1);
});
