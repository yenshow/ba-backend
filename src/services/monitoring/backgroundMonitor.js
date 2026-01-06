/**
 * 背景監控服務
 * 統一管理所有系統的背景監控任務
 * 支持多系統擴展，易於添加新系統的監控邏輯
 */

const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");

// 監控間隔（毫秒）- 每 15 秒檢查一次
// 使用 WebSocket 後可提升更新頻率，從 30 秒調整為 15 秒以提升即時性
// 注意：執行時間約 10 秒，設置 15 秒間隔確保任務有足夠時間完成
const MONITORING_INTERVAL = 15000;

// 監控任務註冊表
const monitoringTasks = [];

let monitoringTimer = null;
let isRunning = false;

/**
 * 註冊監控任務
 * @param {string} systemName - 系統名稱（用於日誌）
 * @param {Function} taskFunction - 監控任務函數（返回 Promise）
 * @param {number} interval - 可選的自定義間隔（毫秒），預設使用全局間隔
 */
function registerMonitoringTask(systemName, taskFunction, interval = null) {
	if (typeof taskFunction !== "function") {
		throw new Error(`監控任務必須是一個函數: ${systemName}`);
	}

	monitoringTasks.push({
		systemName,
		taskFunction,
		interval: interval || MONITORING_INTERVAL,
		lastRun: null,
		errorCount: 0
	});

	console.log(`[backgroundMonitor] 已註冊監控任務: ${systemName}`);
}

/**
 * 執行單個監控任務
 */
async function runTask(task) {
	const startTime = Date.now();
	
	try {
		await task.taskFunction();
		task.lastRun = new Date();
		task.errorCount = 0;
		
		const duration = Date.now() - startTime;
		if (duration > 1000) {
			console.log(
				`[backgroundMonitor] ${task.systemName} 監控完成（耗時: ${duration}ms）`
			);
		}
	} catch (error) {
		task.errorCount++;
		const duration = Date.now() - startTime;
		
		console.error(
			`[backgroundMonitor] ${task.systemName} 監控失敗（錯誤次數: ${task.errorCount}, 耗時: ${duration}ms）:`,
			error.message
		);
		
		// 如果連續錯誤超過 5 次，記錄警告
		if (task.errorCount >= 5) {
			console.warn(
				`[backgroundMonitor] ${task.systemName} 連續 ${task.errorCount} 次監控失敗，請檢查系統狀態`
			);
		}
	}
}

/**
 * 執行所有監控任務
 */
async function runAllTasks() {
	if (monitoringTasks.length === 0) {
		return;
	}

	isRunning = true;
	const startTime = Date.now();

	try {
		// 並行執行所有監控任務（提高效率）
		await Promise.all(monitoringTasks.map(task => runTask(task)));
		
		const totalDuration = Date.now() - startTime;
		if (totalDuration > 2000) {
			console.log(
				`[backgroundMonitor] 所有監控任務完成（總耗時: ${totalDuration}ms）`
			);
		}

		// 註解：前端不需要 monitoring:status 事件
		// 如需監控任務狀態，可透過 REST API 查詢，或實作管理員專用的監控面板
		/*
		// 推送 WebSocket 事件：監控任務執行摘要
		websocketService.emitMonitoringStatus({
			timestamp: new Date().toISOString(),
			totalDuration,
			tasks: monitoringTasks.map(task => ({
				systemName: task.systemName,
				lastRun: task.lastRun,
				errorCount: task.errorCount,
			})),
		});
		*/
	} catch (error) {
		console.error("[backgroundMonitor] 執行監控任務時發生未預期的錯誤:", error);
	} finally {
		isRunning = false;
	}
}

/**
 * 啟動背景監控服務
 */
function startMonitoring() {
	if (monitoringTimer) {
		console.warn("[backgroundMonitor] 監控服務已在運行中");
		return;
	}

	if (monitoringTasks.length === 0) {
		console.warn("[backgroundMonitor] 沒有註冊任何監控任務，跳過啟動");
		return;
	}

	console.log(
		`[backgroundMonitor] 啟動背景監控服務（間隔: ${MONITORING_INTERVAL / 1000}秒，任務數: ${monitoringTasks.length}）`
	);

	// 立即執行一次
	void runAllTasks();

	// 設置定時器
	monitoringTimer = setInterval(() => {
		// 如果上次執行還在進行中，跳過本次執行（避免重疊）
		if (!isRunning) {
			void runAllTasks();
		} else {
			console.warn("[backgroundMonitor] 上次監控任務仍在執行中，跳過本次執行");
		}
	}, MONITORING_INTERVAL);
}

/**
 * 停止背景監控服務
 */
function stopMonitoring() {
	if (monitoringTimer) {
		clearInterval(monitoringTimer);
		monitoringTimer = null;
		isRunning = false;
		console.log("[backgroundMonitor] 背景監控服務已停止");
	}
}

/**
 * 取得監控狀態
 */
function getMonitoringStatus() {
	return {
		isRunning: !!monitoringTimer,
		taskCount: monitoringTasks.length,
		tasks: monitoringTasks.map(task => ({
			systemName: task.systemName,
			lastRun: task.lastRun,
			errorCount: task.errorCount
		}))
	};
}

module.exports = {
	registerMonitoringTask,
	startMonitoring,
	stopMonitoring,
	getMonitoringStatus,
	MONITORING_INTERVAL
};

