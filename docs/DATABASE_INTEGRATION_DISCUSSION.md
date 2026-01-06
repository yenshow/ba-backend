# 資料庫整合架構討論文件

## 📋 目錄

1. [背景說明](#背景說明)
2. [目前狀況](#目前狀況)
3. [問題分析](#問題分析)
4. [解決方案](#解決方案)
5. [技術選型比較](#技術選型比較)
6. [實作建議](#實作建議)
7. [待討論事項](#待討論事項)

---

## 背景說明

### 專案需求

本專案（BA 系統後端）需要整合兩個 PostgreSQL 資料庫：

1. **主資料庫 (ba_system)**
   - 用途：BA 系統的核心資料庫
   - 位置：本機 (127.0.0.1)
   - Port：5432（預設）
   - 包含：用戶、設備、警報、環境監控等資料

2. **外部資料庫 (cms/bi)**
   - 用途：人流統計、監控點配置等資料
   - 目前位置：外部伺服器 (192.168.2.2)
   - Port：5432
   - 包含：`bi` schema 下的各種人流統計資料表
   - 主要資料表：
     - `bi.hcl_camera_passenger_config` - 监控点客流配置
     - `bi.hcl_group_real_time_count_ex` - 实时人数扩展数据
     - `bi.people_count` - 人數統計
     - `bi.people_count_by_day` - 每日人數統計
     - `bi.people_count_by_hour` - 每小時人數統計
     - 以及其他相關統計資料表

### 未來規劃

- 外部資料庫將遷移到本機運行
- 兩個資料庫都將在本機運行
- 需要建立資料庫間的互通機制

---

## 目前狀況

### 現有架構

```
應用程式 (Node.js)
    ├─ 主資料庫連線 (ba_system)
    │   └─ Port: 5432
    │   └─ Host: 127.0.0.1
    │
    └─ 外部資料庫連線 (cms)
        └─ Port: 5432
        └─ Host: 192.168.2.2 (外部伺服器)
```

### 現有實作

#### 1. 配置檔案 (`src/config.js`)

```javascript
database: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: toNumber(process.env.DB_PORT, 5432),
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
    database: process.env.DB_NAME || "ba_system",
    connectionLimit: toNumber(process.env.DB_CONNECTION_LIMIT, 10)
},
externalDatabase: {
    host: process.env.EXTERNAL_DB_HOST || "192.168.2.2",
    port: toNumber(process.env.EXTERNAL_DB_PORT, 5432),
    user: process.env.EXTERNAL_DB_USER || "postgres",
    password: process.env.EXTERNAL_DB_PASSWORD || "",
    database: process.env.EXTERNAL_DB_NAME || "cms",
    connectionLimit: toNumber(process.env.EXTERNAL_DB_CONNECTION_LIMIT, 5)
}
```

#### 2. 資料庫連線模組

- `src/database/db.js` - 主資料庫連線池
- `src/database/externalDb.js` - 外部資料庫連線池

#### 3. 外部資料服務

- `src/services/externalDataService.js` - 外部資料查詢服務
- `src/routes/externalDataRoutes.js` - 外部資料 API 路由

#### 4. 測試腳本

- `scripts/testExternalDatabase.js` - 外部資料庫測試腳本
- `scripts/test-external-db-config.json` - 測試配置檔案

---

## 問題分析

### 問題 1: Port 重疊問題 ⚠️

**問題描述：**

當兩個 PostgreSQL 資料庫都在本機運行時，預設都會使用 **5432** port，導致衝突。

**影響：**

- 無法同時啟動兩個資料庫
- 需要手動修改其中一個資料庫的 port 設定

**目前狀態：**

- 主資料庫：Port 5432
- 外部資料庫：Port 5432（目前在外部伺服器，無衝突）

**未來狀態（預期問題）：**

- 主資料庫：Port 5432
- 外部資料庫：Port 5432 ❌ **衝突！**

---

### 問題 2: 資料庫互通需求 🔄

**需求描述：**

需要讓兩個資料庫能夠互通，以便：

1. **統一查詢介面**
   - 應用程式只需連接到主資料庫
   - 透過主資料庫查詢外部資料庫的資料

2. **資料關聯查詢**
   - 可以將本地資料與外部資料進行 JOIN
   - 例如：將設備資料與人流統計資料關聯

3. **效能優化**
   - 減少應用程式的資料庫連線數
   - 利用資料庫層級的查詢優化

**目前狀態：**

- 應用程式需要維護兩個獨立的連線池
- 無法進行跨資料庫的 JOIN 查詢
- 需要在應用層處理資料整合

---

### 問題 3: 架構複雜度 📊

**目前架構：**

```
應用程式
    ├─ 主資料庫連線池
    └─ 外部資料庫連線池
```

**問題：**

- 需要管理兩個連線池
- 應用程式邏輯分散在多個服務層
- 難以進行跨資料庫的事務處理

---

## 解決方案

### 方案 A: 使用不同 Port + Foreign Data Wrapper (FDW) ⭐ 推薦

#### 架構設計

```
應用程式 (Node.js)
    └─ 主資料庫連線 (ba_system) - Port 5432
            └─ Foreign Data Wrapper
                └─ 外部資料庫 (cms) - Port 5433
                    └─ bi schema (人流統計資料)
```

#### 實作步驟

1. **設定不同的 Port**
   ```env
   # 主資料庫
   DB_PORT=5432
   
   # 外部資料庫
   EXTERNAL_DB_PORT=5433
   ```

2. **在主資料庫中啟用 postgres_fdw**
   ```sql
   CREATE EXTENSION IF NOT EXISTS postgres_fdw;
   ```

3. **建立外部伺服器定義**
   ```sql
   CREATE SERVER external_cms_server
   FOREIGN DATA WRAPPER postgres_fdw
   OPTIONS (
       host '127.0.0.1',
       port '5433',
       dbname 'cms'
   );
   ```

4. **建立使用者映射**
   ```sql
   CREATE USER MAPPING FOR postgres
   SERVER external_cms_server
   OPTIONS (
       user 'postgres',
       password 'your_password'
   );
   ```

5. **建立外部資料表（視需要）**
   ```sql
   CREATE FOREIGN TABLE bi_people_count (
       id bigint,
       camera_id integer,
       enter_num integer,
       exit_num integer,
       trigger_local_time timestamp,
       create_time timestamp
   )
   SERVER external_cms_server
   OPTIONS (
       schema_name 'bi',
       table_name 'people_count'
   );
   ```

#### 優點

- ✅ 統一查詢介面：應用程式只需連接到主資料庫
- ✅ 支援 JOIN：可以將本地資料與外部資料 JOIN
- ✅ 透明存取：外部資料表看起來像本地資料表
- ✅ 效能優化：FDW 會優化查詢
- ✅ 事務支援：可以在同一個事務中操作兩個資料庫

#### 缺點

- ⚠️ 需要修改外部資料庫的 port 設定
- ⚠️ 需要維護外部資料表定義
- ⚠️ 初次設定較複雜

---

### 方案 B: 使用不同 Port + dblink

#### 架構設計

```
應用程式 (Node.js)
    └─ 主資料庫連線 (ba_system) - Port 5432
            └─ dblink 函數
                └─ 外部資料庫 (cms) - Port 5433
```

#### 實作步驟

1. **設定不同的 Port**（同方案 A）

2. **在主資料庫中啟用 dblink**
   ```sql
   CREATE EXTENSION IF NOT EXISTS dblink;
   ```

3. **使用 dblink 查詢**
   ```sql
   SELECT * FROM dblink(
       'host=127.0.0.1 port=5433 dbname=cms user=postgres password=xxx',
       'SELECT * FROM bi.people_count LIMIT 10'
   ) AS t(
       id bigint,
       camera_id integer,
       enter_num integer,
       exit_num integer,
       trigger_local_time timestamp,
       create_time timestamp
   );
   ```

#### 優點

- ✅ 不需要建立外部資料表
- ✅ 適合一次性查詢
- ✅ 設定較簡單

#### 缺點

- ⚠️ 每次查詢都需要指定連線資訊
- ⚠️ 不支援直接 JOIN（需要子查詢）
- ⚠️ SQL 語法較複雜
- ⚠️ 效能較差（每次查詢都建立新連線）

---

### 方案 C: 保持現狀（兩個獨立連線池）

#### 架構設計

```
應用程式 (Node.js)
    ├─ 主資料庫連線池 (ba_system) - Port 5432
    └─ 外部資料庫連線池 (cms) - Port 5433
```

#### 實作步驟

1. **設定不同的 Port**
   ```env
   DB_PORT=5432
   EXTERNAL_DB_PORT=5433
   ```

2. **保持現有的兩個連線池**

3. **在應用層處理資料整合**

#### 優點

- ✅ 不需要修改資料庫設定
- ✅ 架構簡單直接
- ✅ 易於理解和維護

#### 缺點

- ⚠️ 無法進行跨資料庫的 JOIN
- ⚠️ 需要維護兩個連線池
- ⚠️ 應用層邏輯較複雜
- ⚠️ 無法進行跨資料庫的事務處理

---

## 技術選型比較

| 特性 | 方案 A: FDW | 方案 B: dblink | 方案 C: 雙連線池 |
|------|------------|----------------|------------------|
| **設定複雜度** | 中等 | 低 | 低 |
| **查詢效能** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| **JOIN 支援** | ✅ 完整支援 | ⚠️ 需子查詢 | ❌ 不支援 |
| **事務支援** | ✅ 支援 | ⚠️ 部分支援 | ❌ 不支援 |
| **維護成本** | 中等 | 低 | 低 |
| **擴展性** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| **適用場景** | 長期整合 | 臨時查詢 | 獨立運作 |

---

## 實作建議

### 推薦方案：方案 A (FDW)

**理由：**

1. **長期維護性**
   - 一旦設定完成，後續維護成本低
   - 外部資料表定義可以版本控制

2. **查詢效能**
   - FDW 會優化查詢計劃
   - 支援查詢下推（query pushdown）

3. **功能完整性**
   - 支援 JOIN、子查詢、聚合函數等
   - 可以像本地資料表一樣使用

4. **未來擴展**
   - 如果未來需要整合更多資料庫，FDW 架構更容易擴展

### 實作時程建議

#### 階段 1: Port 設定（立即執行）

1. 修改外部資料庫的 `postgresql.conf`：
   ```conf
   port = 5433
   ```

2. 更新 `.env` 檔案：
   ```env
   EXTERNAL_DB_PORT=5433
   ```

3. 重啟外部資料庫

#### 階段 2: FDW 設定（短期）

1. 在主資料庫中啟用 postgres_fdw
2. 建立外部伺服器定義
3. 建立使用者映射
4. 測試連線

#### 階段 3: 外部資料表建立（中期）

1. 識別常用的人流統計資料表
2. 建立對應的外部資料表定義
3. 測試查詢效能

#### 階段 4: 應用程式重構（中期）

1. 簡化應用程式連線邏輯
2. 移除 `externalDb.js` 連線池（或保留作為備用）
3. 更新服務層使用 FDW 查詢
4. 測試和優化

---

## 待討論事項

### 1. 技術選型 ⚠️ 重要

**問題：** 選擇哪個方案？

**選項：**
- [ ] 方案 A: Foreign Data Wrapper (FDW)
- [ ] 方案 B: dblink
- [ ] 方案 C: 保持雙連線池

**建議：** 方案 A (FDW)

**需要討論：**
- 團隊對 FDW 的熟悉程度
- 未來是否有更多資料庫整合需求
- 效能要求

---

### 2. Port 分配

**問題：** 如何分配 Port？

**建議：**
- 主資料庫：5432（保持不變）
- 外部資料庫：5433

**需要討論：**
- 是否有其他服務使用這些 port？
- 是否需要考慮未來擴展？

---

### 3. 外部資料表範圍

**問題：** 需要建立哪些外部資料表？

**建議優先建立：**
- `bi.people_count` - 人數統計
- `bi.people_count_by_day` - 每日人數統計
- `bi.people_count_by_hour` - 每小時人數統計
- `bi.hcl_camera_passenger_config` - 监控点客流配置
- `bi.hcl_group_real_time_count_ex` - 实时人数扩展数据

**需要討論：**
- 哪些資料表最常使用？
- 是否需要建立所有資料表？
- 是否使用動態查詢（不建立外部資料表）？

---

### 4. 遷移時程

**問題：** 何時進行遷移？

**建議：**
- Port 設定：立即執行（無風險）
- FDW 設定：1-2 週內
- 應用程式重構：2-4 週內

**需要討論：**
- 是否有其他優先事項？
- 是否可以分階段進行？
- 回滾計劃？

---

### 5. 備援方案

**問題：** 如果 FDW 設定失敗，是否有備援方案？

**建議：**
- 保留現有的 `externalDb.js` 作為備用
- 可以透過配置切換查詢方式

**需要討論：**
- 是否需要實作自動切換機制？
- 如何監控 FDW 連線狀態？

---

### 6. 安全性考量

**問題：** 使用者映射的安全性？

**需要討論：**
- 是否使用專用的資料庫使用者？
- 密碼如何管理？
- 是否需要加密連線？

---

### 7. 效能測試

**問題：** 如何驗證效能提升？

**建議：**
- 建立效能測試腳本
- 比較 FDW 與直接連線的效能
- 監控查詢執行時間

**需要討論：**
- 效能目標是什麼？
- 如何進行壓力測試？

---

### 8. 文件與知識轉移

**問題：** 如何確保團隊了解新架構？

**建議：**
- 建立詳細的設定文件
- 提供範例查詢
- 進行技術分享

**需要討論：**
- 誰負責維護 FDW 設定？
- 如何培訓團隊成員？

---

## 參考資料

### PostgreSQL 官方文件

- [Foreign Data Wrappers](https://www.postgresql.org/docs/current/postgres-fdw.html)
- [dblink](https://www.postgresql.org/docs/current/dblink.html)
- [CREATE SERVER](https://www.postgresql.org/docs/current/sql-createserver.html)
- [CREATE FOREIGN TABLE](https://www.postgresql.org/docs/current/sql-createforeigntable.html)

### 相關文件

- `docs/DATABASE_DOCUMENTATION.md` - 資料庫完整文檔
- `scripts/test-external-db-README.md` - 外部資料庫測試說明

---

## 附錄：快速參考

### 環境變數設定

```env
# 主資料庫
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=ba_system

# 外部資料庫（未來本機運行）
EXTERNAL_DB_HOST=127.0.0.1
EXTERNAL_DB_PORT=5433
EXTERNAL_DB_USER=postgres
EXTERNAL_DB_PASSWORD=your_password
EXTERNAL_DB_NAME=cms
```

### FDW 設定 SQL 範例

```sql
-- 1. 啟用擴展
CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- 2. 建立外部伺服器
CREATE SERVER external_cms_server
FOREIGN DATA WRAPPER postgres_fdw
OPTIONS (
    host '127.0.0.1',
    port '5433',
    dbname 'cms'
);

-- 3. 建立使用者映射
CREATE USER MAPPING FOR postgres
SERVER external_cms_server
OPTIONS (
    user 'postgres',
    password 'your_password'
);

-- 4. 建立外部資料表
CREATE FOREIGN TABLE bi_people_count (
    id bigint,
    camera_id integer,
    enter_num integer,
    exit_num integer,
    trigger_local_time timestamp,
    create_time timestamp
)
SERVER external_cms_server
OPTIONS (
    schema_name 'bi',
    table_name 'people_count'
);
```

---

**文件建立日期：** 2026-01-05  
**最後更新：** 2026-01-05  
**負責人：** 待討論

