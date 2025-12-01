#!/usr/bin/env node

/**
 * 診斷後端伺服器連接問題
 * 檢查伺服器狀態、網路連接、防火牆等
 */

const os = require("os");
const http = require("http");
const { execSync } = require("child_process");

const TARGET_IP = process.argv[2] || "192.168.2.7";
const TARGET_PORT = parseInt(process.argv[3] || "4000", 10);

console.log("🔍 BA 後端連接診斷工具\n");
console.log(`目標地址: ${TARGET_IP}:${TARGET_PORT}\n`);

// 1. 檢查本機 IP 地址
console.log("📍 步驟 1: 檢查本機網路介面");
const interfaces = os.networkInterfaces();
const localIPs = [];

for (const name of Object.keys(interfaces)) {
	for (const iface of interfaces[name]) {
		if (iface.family === "IPv4" && !iface.internal) {
			localIPs.push(iface.address);
			console.log(`   ✓ ${name}: ${iface.address}`);
		}
	}
}

if (localIPs.length === 0) {
	console.log("   ⚠️  未找到區域網路 IP 地址");
} else {
	const isLocalIP = localIPs.includes(TARGET_IP);
	if (isLocalIP) {
		console.log(`\n   ✅ 目標 IP ${TARGET_IP} 是本機地址`);
	} else {
		console.log(`\n   ⚠️  目標 IP ${TARGET_IP} 不是本機地址`);
		console.log(`   本機 IP 地址: ${localIPs.join(", ")}`);
	}
}

// 2. 檢查伺服器是否在運行
console.log("\n📍 步驟 2: 檢查後端伺服器進程");
try {
	const platform = os.platform();
	let command;
	
	if (platform === "darwin" || platform === "linux") {
		command = `lsof -i :${TARGET_PORT} || echo "未找到進程"`;
	} else if (platform === "win32") {
		command = `netstat -ano | findstr :${TARGET_PORT} || echo 未找到進程`;
	} else {
		command = "echo 不支援的作業系統";
	}
	
	const result = execSync(command, { encoding: "utf-8", stdio: "pipe" });
	if (result.includes("未找到進程") || result.trim() === "") {
		console.log(`   ❌ 端口 ${TARGET_PORT} 沒有進程在監聽`);
		console.log(`   💡 請確認後端伺服器是否已啟動: npm start 或 npm run dev`);
	} else {
		console.log(`   ✅ 端口 ${TARGET_PORT} 有進程在監聽:`);
		console.log(`   ${result.split("\n").filter(l => l.trim()).join("\n   ")}`);
	}
} catch (error) {
	console.log(`   ⚠️  無法檢查進程狀態: ${error.message}`);
}

// 3. 測試本地連接
console.log("\n📍 步驟 3: 測試本地連接 (localhost)");
testConnection("localhost", TARGET_PORT, (success) => {
	if (success) {
		console.log("   ✅ 本地連接成功");
	} else {
		console.log("   ❌ 本地連接失敗 - 伺服器可能未啟動或配置錯誤");
	}
	
	// 4. 測試目標 IP 連接
	console.log(`\n📍 步驟 4: 測試目標 IP 連接 (${TARGET_IP})`);
	testConnection(TARGET_IP, TARGET_PORT, (success) => {
		if (success) {
			console.log(`   ✅ 目標 IP 連接成功`);
		} else {
			console.log(`   ❌ 目標 IP 連接失敗`);
			console.log(`\n💡 可能的解決方案:`);
			console.log(`   1. 確認後端伺服器正在運行`);
			console.log(`   2. 確認伺服器監聽在 0.0.0.0 而不是 127.0.0.1`);
			console.log(`   3. 檢查防火牆是否阻擋端口 ${TARGET_PORT}`);
			console.log(`   4. 確認前端和後端在同一網路`);
			console.log(`   5. 檢查 .env 文件中的 HOST 設定（應為 0.0.0.0）`);
		}
		
		// 5. 檢查配置建議
		console.log("\n📍 步驟 5: 配置檢查建議");
		console.log("   請確認以下配置:");
		console.log(`   - HOST=0.0.0.0 (允許外部連接)`);
		console.log(`   - PORT=${TARGET_PORT}`);
		console.log(`   - CORS_ORIGINS 包含前端地址`);
		
		console.log("\n✅ 診斷完成\n");
	});
});

function testConnection(host, port, callback) {
	const req = http.request(
		{
			hostname: host,
			port: port,
			path: "/api/users/login",
			method: "GET",
			timeout: 3000
		},
		(res) => {
			callback(true);
		}
	);
	
	req.on("error", () => {
		callback(false);
	});
	
	req.on("timeout", () => {
		req.destroy();
		callback(false);
	});
	
	req.end();
}

