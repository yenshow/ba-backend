const axios = require("axios");
const config = require("../src/config");
const db = require("../src/database/db");

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
 * 測試 API 端點
 */
async function testAPI(method, url, params = null, description = "") {
  try {
    const config = {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    };

    let response;
    if (method === "GET") {
      response = await axios.get(url, { ...config, params });
    } else if (method === "POST") {
      response = await axios.post(url, params, config);
    }

    console.log(`\n✅ ${description || url}`);
    console.log(`   狀態: ${response.status}`);
    if (response.data.success !== undefined) {
      console.log(`   成功: ${response.data.success}`);
    }
    if (response.data.data) {
      if (Array.isArray(response.data.data)) {
        console.log(`   資料筆數: ${response.data.data.length}`);
        if (response.data.data.length > 0) {
          console.log(
            `   範例資料:`,
            JSON.stringify(response.data.data[0], null, 2)
          );
        }
      } else if (response.data.data.count !== undefined) {
        console.log(`   總筆數: ${response.data.data.count}`);
      } else {
        console.log(`   資料:`, JSON.stringify(response.data.data, null, 2));
      }
    }
    if (response.data.pagination) {
      console.log(`   分頁資訊:`, response.data.pagination);
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
 * 主測試函數
 */
async function runTests() {
  console.log("=".repeat(60));
  console.log("外部資料庫 API 測試");
  console.log("=".repeat(60));

  // 1. 取得登入帳號（優先使用命令列參數，否則從資料庫查詢）
  let username = process.argv[2];
  let password = process.argv[3];

  // 從環境變數或資料庫取得帳號
  if (!username) {
    username = process.env.EXTERNAL_DB_USER;
    if (!username) {
      console.log("\n📡 查詢資料庫中的管理員帳號...");
      username = await getFirstAdmin();
      if (!username) {
        console.error("\n❌ 找不到可用的管理員帳號");
        console.log("\n請先建立管理員: npm run admin:create");
        process.exit(1);
      }
    }
  }

  // 從環境變數取得密碼
  if (!password) {
    password = process.env.EXTERNAL_DB_PASSWORD;
    if (!password) {
      console.error("\n❌ 請提供密碼");
      console.log(
        "方式 2: 命令列參數: node scripts/testExternalDataAPI.js <username> <password>"
      );
      process.exit(1);
    }
  }

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

  // 2. 測試 platform.person
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

  await testAPI(
    "GET",
    `${API_BASE}/platform/person/count`,
    { person_group_id: 1 },
    "取得人員總數（篩選群組 ID = 1）"
  );

  // 3. 測試 platform.person_group
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

  // 4. 測試 platform.person_head_pic
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

  // 5. 測試 baseaccs.slot_card_records
  console.log("\n" + "=".repeat(60));
  console.log("測試 baseaccs.slot_card_records");
  console.log("=".repeat(60));

  await testAPI(
    "GET",
    `${API_BASE}/baseaccs/slot_card_records`,
    {
      limit: 5,
      offset: 0,
      orderBy: "swip_card_rev_time",
      orderDirection: "DESC",
    },
    "取得刷卡紀錄列表（前 5 筆，依時間降序）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/baseaccs/slot_card_records`,
    {
      limit: 5,
      columns: "person_id,is_deleted,swip_card_rev_time,snap_pic_url",
    },
    "取得刷卡紀錄列表（指定欄位）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/baseaccs/slot_card_records`,
    { limit: 5, person_id: 1, is_deleted: 0 },
    "取得刷卡紀錄列表（篩選 person_id = 1 且未刪除）"
  );

  await testAPI(
    "GET",
    `${API_BASE}/baseaccs/slot_card_records/count`,
    null,
    "取得刷卡紀錄總數"
  );

  // 6. 測試安全性（嘗試存取未授權的資源）
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

// 執行測試
runTests().catch((error) => {
  console.error("\n❌ 測試過程發生錯誤:", error);
  process.exit(1);
});
