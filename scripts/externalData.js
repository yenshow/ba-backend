const axios = require("axios");
const config = require("../src/config");
const db = require("../src/database/db");
const fs = require("fs");
const path = require("path");
const systemMapping = require("../src/services/externalData/systemMapping");

const BASE_URL = `http://localhost:${config.serverPort}`;
const API_BASE = `${BASE_URL}/api/external-data`;

let authToken = null;

/**
 * 從資料庫取得第一個管理員帳號
 */
async function getFirstAdmin() {
  try {
    const admins = await db.query(
      "SELECT username FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1"
    );
    return admins.length > 0 ? admins[0].username : null;
  } catch (error) {
    console.warn("⚠️  無法從資料庫查詢管理員:", error.message);
    return null;
  }
}

/**
 * 取得認證資訊（從 .env 或資料庫）
 */
async function getAuthInfo() {
  // 優先使用 API 專用的環境變數
  let username = process.env.API_USER;
  let password = process.env.API_PASSWORD;

  // 如果沒有設定，從資料庫取得管理員帳號
  if (!username) {
    console.log("📡 查詢資料庫中的管理員帳號...");
    username = await getFirstAdmin();
    if (!username) {
      throw new Error(
        "找不到可用的管理員帳號。請先建立管理員: npm run admin:create"
      );
    }
  }

  // 如果沒有密碼，提示用戶設定
  if (!password) {
    throw new Error(
      "請在 .env 中設定 API_PASSWORD（用於 API 登入的密碼）\n" +
        "注意：這應該是 users 表中管理員帳號的密碼，不是資料庫密碼"
    );
  }

  return { username, password };
}

/**
 * 登入取得 token
 */
async function login(username, password) {
  try {
    const response = await axios.post(`${BASE_URL}/api/users/login`, {
      username,
      password,
    });
    if (response.data.token) {
      authToken = response.data.token;
      return true;
    }
    return false;
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message);
  }
}

/**
 * 呼叫 API
 */
async function callAPI(method, url, params = null) {
  const config = {
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
    // 設定超時時間（60 秒），避免資料量過大時無限等待
    timeout: 60000,
  };

  let response;
  if (method === "GET") {
    response = await axios.get(url, { ...config, params });
  } else if (method === "POST") {
    response = await axios.post(url, params, config);
  }

  return response.data;
}

/**
 * 測試 API 端點
 */
async function testAPI(method, url, params = null, description = "") {
  try {
    const data = await callAPI(method, url, params);

    console.log(`\n✅ ${description || url}`);
    console.log(`   狀態: 200`);
    if (data.success !== undefined) {
      console.log(`   成功: ${data.success}`);
    }
    if (data.data) {
      if (Array.isArray(data.data)) {
        console.log(`   資料筆數: ${data.data.length}`);
        if (data.data.length > 0) {
          console.log(`   範例資料欄位:`, Object.keys(data.data[0]).join(", "));
        }
      } else if (data.data.count !== undefined) {
        console.log(`   總筆數: ${data.data.count}`);
      } else {
        console.log(`   資料:`, JSON.stringify(data.data, null, 2));
      }
    }
    if (data.pagination) {
      console.log(`   分頁資訊:`, data.pagination);
    }
    return true;
  } catch (error) {
    console.error(`\n❌ ${description || url}`);
    console.error(`   錯誤: ${error.response?.data?.message || error.message}`);
    if (error.response?.data?.error) {
      console.error(`   詳細: ${error.response.data.error}`);
    }
    return false;
  }
}

/**
 * 取得資料
 */
async function fetchData(schema, table, options = {}) {
  const params = {
    limit: options.limit || 10,
    offset: options.offset || 0,
    ...options.filters,
  };

  if (options.columns) {
    params.columns = Array.isArray(options.columns)
      ? options.columns.join(",")
      : options.columns;
  }

  if (options.orderBy) {
    params.orderBy = options.orderBy;
    params.orderDirection = options.orderDirection || "ASC";
  }

  return await callAPI("GET", `${API_BASE}/${schema}/${table}`, params);
}

/**
 * 取得資料總數
 */
async function fetchCount(schema, table, filters = {}) {
  return await callAPI("GET", `${API_BASE}/${schema}/${table}/count`, filters);
}

/**
 * 儲存資料到檔案
 */
function saveToFile(data, filename) {
  const outputDir = path.join(__dirname, "..", "output");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonFile = path.join(outputDir, `${filename}-${timestamp}.json`);
  const txtFile = path.join(outputDir, `${filename}-${timestamp}.txt`);

  // 儲存 JSON
  fs.writeFileSync(jsonFile, JSON.stringify(data, null, 2), "utf8");

  // 儲存文字格式
  let txtContent = `資料表: ${data.schema}.${data.table}\n`;
  txtContent += `時間: ${data.timestamp}\n`;
  txtContent += `成功: ${data.success}\n`;
  txtContent += `筆數: ${data.count}\n`;
  if (data.pagination) {
    txtContent += `分頁: limit=${data.pagination.limit}, offset=${data.pagination.offset}\n`;
  }
  txtContent += "\n" + "=".repeat(60) + "\n\n";

  if (data.data && data.data.length > 0) {
    data.data.forEach((item, index) => {
      txtContent += `記錄 ${index + 1}:\n`;
      txtContent += JSON.stringify(item, null, 2);
      txtContent += "\n" + "-".repeat(60) + "\n\n";
    });
  } else {
    txtContent += "無資料\n";
  }

  fs.writeFileSync(txtFile, txtContent, "utf8");

  console.log(`✅ 資料已儲存至:`);
  console.log(`   JSON: ${jsonFile}`);
  console.log(`   TXT:  ${txtFile}`);
}

/**
 * 測試模式：測試所有 API 端點
 */
async function runTests() {
  console.log("=".repeat(60));
  console.log("外部資料庫 API 測試");
  console.log("=".repeat(60));

  // 測試 platform.person
  console.log("\n" + "=".repeat(60));
  console.log("測試 platform.person");
  console.log("=".repeat(60));

  await testAPI(
    "GET",
    `${API_BASE}/platform/person`,
    { limit: 5, offset: 0, orderBy: "id", orderDirection: "ASC" },
    "取得人員列表（前 5 筆）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/platform/person`,
    { limit: 5, columns: "id,person_group_id,full_name" },
    "取得人員列表（指定欄位）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/platform/person`,
    { limit: 5, person_group_id: 1 },
    "取得人員列表（篩選群組 ID = 1）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/platform/person`,
    { limit: 5, search: "Tony" },
    "取得人員列表（搜尋姓名包含 'Tony'）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/platform/person/2`,
    null,
    "取得單一人員（ID = 2）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/platform/person/count`,
    null,
    "取得人員總數"
  );

  // 測試 platform.person_group
  console.log("\n" + "=".repeat(60));
  console.log("測試 platform.person_group");
  console.log("=".repeat(60));

  await testAPI(
    "GET",
    `${API_BASE}/platform/person_group`,
    { limit: 5, offset: 0 },
    "取得群組列表（前 5 筆）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/platform/person_group`,
    { limit: 5, columns: "id,name,is_deleted" },
    "取得群組列表（指定欄位）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/platform/person_group`,
    { limit: 5, is_deleted: 0 },
    "取得群組列表（篩選未刪除）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/platform/person_group/35`,
    null,
    "取得單一群組（ID = 35）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/platform/person_group/count`,
    null,
    "取得群組總數"
  );

  // 測試 platform.person_head_pic
  console.log("\n" + "=".repeat(60));
  console.log("測試 platform.person_head_pic");
  console.log("=".repeat(60));

  await testAPI(
    "GET",
    `${API_BASE}/platform/person_head_pic`,
    { limit: 3, offset: 0 },
    "取得人員照片列表（前 3 筆）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/platform/person_head_pic`,
    { limit: 3, columns: "id,person_id,thumbnail_head_portrait" },
    "取得人員照片列表（指定欄位，不包含大圖）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/platform/person_head_pic/1`,
    null,
    "取得單一人員照片（ID = 1）"
  );

  // 測試 baseacs.slot_card_records
  console.log("\n" + "=".repeat(60));
  console.log("測試 baseacs.slot_card_records");
  console.log("=".repeat(60));

  await testAPI(
    "GET",
    `${API_BASE}/baseacs/slot_card_records`,
    {
      limit: 5,
      offset: 0,
      timeRange: "today",
      orderBy: "swip_card_rev_time",
      orderDirection: "DESC",
    },
    "取得刷卡紀錄列表（今天，前 5 筆，依時間降序）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/baseacs/slot_card_records`,
    {
      limit: 5,
      columns: "person_id,is_deleted,swip_card_rev_time,snap_pic_url",
    },
    "取得刷卡紀錄列表（指定欄位）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/baseacs/slot_card_records`,
    { limit: 5, person_id: 1, is_deleted: 0 },
    "取得刷卡紀錄列表（篩選 person_id = 1 且未刪除）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/baseacs/slot_card_records`,
    { limit: 5, timeRange: "today" },
    "取得刷卡紀錄列表（今天）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/baseacs/slot_card_records/count`,
    { timeRange: "today" },
    "取得刷卡紀錄總數（今天）"
  );

  // 測試安全性
  console.log("\n" + "=".repeat(60));
  console.log("測試安全性（白名單驗證）");
  console.log("=".repeat(60));

  await testAPI(
    "GET",
    `${API_BASE}/platform/invalid_table`,
    null,
    "嘗試存取未授權的資料表（應失敗）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/invalid_schema/person`,
    null,
    "嘗試存取未授權的 schema（應失敗）"
  );

  console.log("\n" + "=".repeat(60));
  console.log("✅ 測試完成");
  console.log("=".repeat(60));
}

/**
 * 取得資料表的預設抓取選項
 */
function getDefaultOptionsForTable(schema, table) {
  const defaults = {
    "platform.person": {
      limit: 100,
        columns: ["id", "person_group_id", "person_type", "full_name"],
      },
    "platform.person_group": {
      limit: 100,
        columns: ["id", "name", "is_deleted"],
      },
    "platform.person_head_pic": {
      limit: 50,
        columns: ["id", "person_id", "standard_head_portrait"],
      },
    "baseacs.slot_card_records": {
      limit: 1000,
        columns: ["person_id", "swip_card_rev_time", "snap_pic_url"],
        filters: { timeRange: "today" },
        orderBy: "swip_card_rev_time",
        orderDirection: "DESC",
      },
    "deviceaccess.door": {
      limit: 100,
      columns: ["id", "device_id", "dev_name", "door_index", "is_deleted"],
    },
  };

  return defaults[`${schema}.${table}`] || { limit: 50 };
}

/**
 * 抓取指定系統的資料
 */
async function runFetchBySystem(systemType) {
  console.log("=".repeat(60));
  console.log(`外部資料抓取 - ${systemType} 系統`);
  console.log("=".repeat(60));

  if (!systemMapping.hasSystem(systemType)) {
    console.error(`\n❌ 找不到系統 ${systemType}`);
    console.log(`\n可用的系統類型：`);
    systemMapping.getAllSystemTypes().forEach((type) => {
      console.log(`   - ${type}`);
    });
    return;
  }

  const tables = systemMapping.getTablesBySystem(systemType);

  console.log(`\n📋 系統 ${systemType} 使用的資料表：`);
  tables.forEach(({ schema, table }) => {
    console.log(`   - ${schema}.${table}`);
  });

  // 使用預設選項
  const tableConfigs = tables.map(({ schema, table }) => ({
    schema,
    table,
    options: getDefaultOptionsForTable(schema, table),
  }));

  await fetchTables(tableConfigs, systemType);
}

/**
 * 抓取模式：抓取資料並儲存到檔案（預設：人流統計系統）
 */
async function runFetch() {
  console.log("=".repeat(60));
  console.log("外部資料抓取（預設：人流統計系統）");
  console.log("=".repeat(60));

  // 預設使用人流統計系統
  const defaultSystem = "people_counting";
  const tables = systemMapping.getTablesBySystem(defaultSystem);

  const tableConfigs = tables.map(({ schema, table }) => ({
    schema,
    table,
    options: getDefaultOptionsForTable(schema, table),
  }));

  await fetchTables(tableConfigs, defaultSystem);
}

/**
 * 執行資料抓取
 */
async function fetchTables(tableConfigs, systemType = null) {

  console.log("\n" + "=".repeat(60));
  console.log("開始抓取資料...");
  console.log("=".repeat(60));

  const results = [];

  for (const { schema, table, options } of tableConfigs) {
    try {
      console.log(`\n📊 抓取 ${schema}.${table}...`);

      // 取得總數
      const countResult = await fetchCount(
        schema,
        table,
        options.filters || {}
      );
      console.log(`   總數: ${countResult.data?.count || 0}`);

      // 取得資料
      const data = await fetchData(schema, table, options);
      const formatted = {
        schema,
        table,
        timestamp: new Date().toISOString(),
        success: data.success,
        count: data.data?.length || 0,
        pagination: data.pagination || null,
        data: data.data || [],
      };

      console.log(`   成功: ${formatted.success}`);
      console.log(`   筆數: ${formatted.count}`);

      if (formatted.data.length > 0) {
        console.log(
          `   範例資料欄位:`,
          Object.keys(formatted.data[0]).join(", ")
        );
      }

      results.push(formatted);

      // 儲存個別檔案（加入系統前綴）
      const filename = systemType
        ? `${systemType}-${schema}-${table}`
        : `${schema}-${table}`;
      saveToFile(formatted, filename);
    } catch (error) {
      console.error(`   ❌ 錯誤: ${error.message}`);

      // 顯示更詳細的錯誤資訊
      if (error.response) {
        console.error(`   HTTP 狀態: ${error.response.status}`);
        if (error.response.data) {
          const errorMsg =
            error.response.data.message ||
            error.response.data.error ||
            "未知錯誤";
          console.error(`   錯誤訊息: ${errorMsg}`);
          if (error.response.data.details) {
            console.error(`   詳細資訊:`, error.response.data.details);
          }
        }
      } else if (error.code === "ECONNREFUSED") {
        console.error(`   ⚠️  無法連接到後端服務`);
        console.error(`   建議：確認後端服務是否已啟動 (npm start)`);
      } else if (
        error.code === "ETIMEDOUT" ||
        error.message.includes("timeout")
      ) {
        console.error(`   ⚠️  請求超時`);
        console.error(`   可能原因：資料量過大或查詢時間過長`);
        console.error(`   建議：嘗試減少 limit 或增加查詢條件`);
      } else if (error.code) {
        console.error(`   錯誤代碼: ${error.code}`);
      }

      results.push({
        schema,
        table,
        success: false,
        error: error.message,
        errorDetails: error.response?.data || null,
      });
    }
  }

  // 顯示摘要
  const successCount = results.filter((r) => r.success !== false).length;
  const failedCount = results.filter((r) => r.success === false).length;

  console.log("\n" + "=".repeat(60));
  console.log("✅ 資料抓取完成");
  if (systemType) {
    console.log(`   系統: ${systemType}`);
  }
  console.log(`   成功: ${successCount}`);
  console.log(`   失敗: ${failedCount}`);
  console.log("=".repeat(60));
}

/**
 * 顯示使用說明
 */
function showUsage() {
  console.log("外部資料工具腳本");
  console.log("=".repeat(60));
  console.log("\n使用方式:");
  console.log("  npm run external-data:test              - 測試所有 API 端點");
  console.log("  npm run external-data:fetch             - 抓取資料（預設：人流統計系統）");
  console.log("  npm run external-data:fetch --system=SYSTEM - 抓取指定系統的資料");
  console.log("\n可用的系統類型:");
  systemMapping.getAllSystemTypes().forEach((type) => {
    const tables = systemMapping.getTablesBySystem(type);
    console.log(`  - ${type} (${tables.length} 個資料表)`);
  });
  console.log("\n認證資訊:");
  console.log("  從 .env 檔案讀取:");
  console.log("  - API_USER (或從資料庫查詢管理員)");
  console.log("  - API_PASSWORD (必填，users 表中管理員帳號的密碼)");
  console.log("\n注意:");
  console.log("  請確保後端服務已啟動 (npm start)");
}

/**
 * 主函數
 */
async function main() {
  const mode = process.argv[2] || "help";

  try {
    // 取得認證資訊
    const { username, password } = await getAuthInfo();

    // 登入
    console.log(`\n📡 登入 (${username})...`);
    try {
      await login(username, password);
      console.log("✅ 登入成功");
    } catch (error) {
      console.error(`❌ 登入失敗: ${error.message}`);
      process.exit(1);
    } finally {
      await db.close();
    }

    // 根據模式執行
    switch (mode) {
      case "test":
        await runTests();
        break;
      case "fetch":
        // 檢查是否有指定系統
        const systemArg = process.argv.find((arg) => arg.startsWith("--system="));
        if (systemArg) {
          const systemType = systemArg.split("=")[1];
          await runFetchBySystem(systemType);
        } else {
        await runFetch();
        }
        break;
      case "help":
      default:
        showUsage();
        break;
    }
  } catch (error) {
    console.error("\n❌ 執行過程發生錯誤:", error.message);
    if (error.message.includes("找不到可用的管理員帳號")) {
      console.log("\n請先建立管理員: npm run admin:create");
    }
    if (error.message.includes("API_PASSWORD")) {
      console.log(
        "\n請在 .env 中設定 API_PASSWORD（這是 users 表中管理員帳號的密碼）"
      );
    }
    process.exit(1);
  }
}

// 執行
main().catch((error) => {
  console.error("\n❌ 執行過程發生錯誤:", error);
  process.exit(1);
});
