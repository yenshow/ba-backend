/**
 * 警報自動清理服務
 * 自動備份並清理超過 30 天的已解決警報
 * 自動刪除超過 1 年的備份檔案
 */

const db = require("../../database/db");
const fs = require("fs").promises;
const path = require("path");

const BACKUP_DIR = path.join(__dirname, "../../backups/alerts");
const ARCHIVE_PREFIX = "alerts_archive_";

// 資料庫保留天數（前端可追溯的時間）
const DB_RETENTION_DAYS = 30;

// 備份檔案保留天數
const BACKUP_RETENTION_DAYS = 365;

/**
 * 確保備份目錄存在
 */
async function ensureBackupDir() {
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
  } catch (error) {
    console.error("[alertCleanup] 創建備份目錄失敗:", error);
    throw error;
  }
}

/**
 * 備份並刪除超過保留期的警報
 */
async function archiveOldAlerts() {
  try {
    await ensureBackupDir();

    // 查詢超過保留期的已解決警報
    const alertsToArchive = await db.query(
      `SELECT * FROM alerts
      WHERE status = 'resolved'
        AND resolved_at < NOW() - INTERVAL '${DB_RETENTION_DAYS} days'`
    );

    if (!alertsToArchive || alertsToArchive.length === 0) {
      console.log("[alertCleanup] 沒有需要備份的警報");
      return { archived: 0, deleted: 0 };
    }

    // 生成備份檔案名稱（使用日期）
    const today = new Date().toISOString().split("T")[0].replace(/-/g, "");
    const backupFileName = `${ARCHIVE_PREFIX}${today}.json`;
    const backupPath = path.join(BACKUP_DIR, backupFileName);

    // 如果檔案已存在，讀取現有資料並合併
    let existingAlerts = [];
    try {
      const existingContent = await fs.readFile(backupPath, "utf8");
      existingAlerts = JSON.parse(existingContent);
    } catch (error) {
      // 檔案不存在，這是正常的（第一次備份）
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    // 合併資料
    const allAlerts = [...existingAlerts, ...alertsToArchive];

    // 寫入備份檔案
    await fs.writeFile(backupPath, JSON.stringify(allAlerts, null, 2), "utf8");

    console.log(
      `[alertCleanup] 已備份 ${alertsToArchive.length} 筆警報到 ${backupFileName}`
    );

    // 從資料庫刪除已備份的警報
    const deleteResult = await db.query(
      `DELETE FROM alerts
      WHERE status = 'resolved'
        AND resolved_at < NOW() - INTERVAL '${DB_RETENTION_DAYS} days'
      RETURNING id`
    );

    const deletedCount = deleteResult ? deleteResult.length : 0;
    console.log(`[alertCleanup] 已從資料庫刪除 ${deletedCount} 筆警報`);

    return { archived: alertsToArchive.length, deleted: deletedCount };
  } catch (error) {
    console.error("[alertCleanup] 備份警報失敗:", error);
    throw error;
  }
}

/**
 * 刪除超過保留期的備份檔案
 */
async function deleteOldBackups() {
  try {
    await ensureBackupDir();

    const files = await fs.readdir(BACKUP_DIR);
    const oneYearAgo = new Date();
    oneYearAgo.setDate(oneYearAgo.getDate() - BACKUP_RETENTION_DAYS);

    let deletedCount = 0;

    for (const file of files) {
      if (file.startsWith(ARCHIVE_PREFIX) && file.endsWith(".json")) {
        const filePath = path.join(BACKUP_DIR, file);
        try {
          const stats = await fs.stat(filePath);

          if (stats.mtime < oneYearAgo) {
            await fs.unlink(filePath);
            console.log(`[alertCleanup] 已刪除超過 1 年的備份檔案: ${file}`);
            deletedCount++;
          }
        } catch (error) {
          console.error(`[alertCleanup] 刪除備份檔案失敗 ${file}:`, error);
        }
      }
    }

    return deletedCount;
  } catch (error) {
    console.error("[alertCleanup] 刪除舊備份檔案失敗:", error);
    throw error;
  }
}

/**
 * 執行完整的清理流程
 */
async function runCleanup() {
  try {
    console.log("[alertCleanup] 開始執行警報清理...");

    const archiveResult = await archiveOldAlerts();
    const deletedBackups = await deleteOldBackups();

    console.log(
      `[alertCleanup] 清理完成: 備份 ${archiveResult.archived} 筆警報, 刪除 ${archiveResult.deleted} 筆資料庫記錄, 刪除 ${deletedBackups} 個舊備份檔案`
    );

    return {
      archived: archiveResult.archived,
      deleted: archiveResult.deleted,
      deletedBackups,
    };
  } catch (error) {
    console.error("[alertCleanup] 清理過程發生錯誤:", error);
    throw error;
  }
}

/**
 * 啟動定時清理任務（每天執行一次）
 */
function startCleanupScheduler() {
  // 每天執行一次（24 小時 = 86400000 毫秒）
  const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;

  // 立即執行一次（可選）
  // runCleanup().catch(console.error);

  // 設定定時任務
  setInterval(() => {
    runCleanup().catch((error) => {
      console.error("[alertCleanup] 定時清理任務失敗:", error);
    });
  }, CLEANUP_INTERVAL);

  console.log(
    `[alertCleanup] 已啟動定時清理任務，每 ${CLEANUP_INTERVAL / 1000 / 60 / 60} 小時執行一次`
  );
}

module.exports = {
  runCleanup,
  archiveOldAlerts,
  deleteOldBackups,
  startCleanupScheduler,
  DB_RETENTION_DAYS,
  BACKUP_RETENTION_DAYS,
};

