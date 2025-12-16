# 照明系統後端修改總結

## 修改日期

2024 年（根據前端架構精簡後的修改）

## 修改目的

根據前端架構精簡，確保後端能夠：

1. 保留區域 ID（更新而非刪除重建）
2. 支援批次處理儲存
3. 與前端資料結構完全匹配

## 已完成的修改

### 1. 移除多餘的方法和欄位

#### 移除分類點相關方法（已不再使用）

- ❌ `getCategories()` - 取得分類點列表
- ❌ `getCategoryById()` - 取得單一分類點
- ❌ `createCategory()` - 建立分類點
- ❌ `updateCategory()` - 更新分類點
- ❌ `deleteCategory()` - 刪除分類點
- ❌ `updateBatchPositions()` - 批次更新分類點位置

**原因**：前端已統一使用樓層管理，區域（areas）直接通過樓層管理，不再需要獨立的分類點 API。

#### 移除 description 欄位

- ❌ 從 `formatArea()` 中移除 `description`
- ❌ 從 `validateAndCreateArea()` 中移除 `description` 參數和 SQL 欄位
- ❌ 從 `validateAndUpdateArea()` 中移除 `description` 參數和 SQL 欄位

**原因**：前端架構中不使用 description 欄位，為保持一致性已移除。

### 2. 後端服務修改 (`src/services/lightingService.js`)

#### 新增函數：`validateAndUpdateArea`

- 用於更新現有區域（保留 ID）
- 驗證區域名稱、設備、modbus 配置
- 更新區域的所有欄位

#### 修改函數：`validateAndCreateArea`

- 現在返回新建立的區域 ID
- 用於建立新區域（沒有 ID 的區域）

#### 修改函數：`updateFloor`

**重要變更**：從「刪除重建」改為「智能更新」

**舊邏輯**：

```javascript
// 刪除所有現有區域
await query("DELETE FROM lighting_areas WHERE floor_id = $1", [id]);
// 建立新區域
for (const area of areas) {
  await validateAndCreateArea(query, id, area, userId);
}
```

**新邏輯**：

```javascript
// 智能更新：保留 ID，更新/新增/刪除
const existingAreas = await query(
  "SELECT id FROM lighting_areas WHERE floor_id = $1",
  [id]
);
const existingAreaIds = new Set(existingAreas.map((a) => String(a.id)));

const updatedAreaIds = new Set();
for (const area of areas) {
  const areaId = area.id ? String(area.id) : null;

  if (areaId && existingAreaIds.has(areaId)) {
    // 更新現有區域（保留 ID）
    await validateAndUpdateArea(query, parseInt(areaId), area, userId);
    updatedAreaIds.add(areaId);
  } else {
    // 建立新區域
    const newAreaId = await validateAndCreateArea(query, id, area, userId);
    updatedAreaIds.add(String(newAreaId));
  }
}

// 刪除不在更新列表中的區域
const areasToDelete = Array.from(existingAreaIds).filter(
  (id) => !updatedAreaIds.has(id)
);
if (areasToDelete.length > 0) {
  await query("DELETE FROM lighting_areas WHERE id = ANY($1::int[])", [
    areasToDelete.map((id) => parseInt(id)),
  ]);
}
```

### 2. 資料庫結構確認

#### `lighting_floors` 表

- ✅ 結構正確，無需修改
- 欄位：id, name, image_url, created_by, created_at, updated_at

#### `lighting_areas` 表

- ✅ 結構正確，無需修改
- 欄位：id, floor_id, name, location_x, location_y, description, device_id, modbus_config, created_by, created_at, updated_at
- 約束：`unique_floor_area_name` (floor_id, name) - 確保同一樓層內區域名稱唯一

## 前端與後端對應關係

### 資料格式轉換

#### 前端 → 後端

```javascript
// LightingFloor
{
  id: "1",              → id: 1 (整數)
  name: "1F",           → name: "1F"
  imageUrl: "base64...", → image_url: "base64..."
  areas: [...]          → lighting_areas 表
}

// LightingArea
{
  id: "1",              → id: 1 (整數)
  name: "主燈開關",      → name: "主燈開關"
  location: {x: 50, y: 50} → location_x: 50.00, location_y: 50.00
  deviceId: 1,          → device_id: 1
  modbus: {...}        → modbus_config: JSONB
}
```

#### 後端 → 前端

```javascript
// formatFloor 和 formatArea 函數處理轉換
{
  id: 1                 → id: "1" (字串)
  name: "1F",           → name: "1F"
  image_url: "base64..." → imageUrl: "base64..."
  location_x: 50.00     → location: {x: 50, y: 50}
  location_y: 50.00
  device_id: 1          → deviceId: 1
  modbus_config: {...}  → modbus: {...}
}
```

## API 端點

### 樓層管理

- `GET /lighting/floors` - 取得所有樓層（包含區域）
- `GET /lighting/floors/:id` - 取得單一樓層
- `POST /lighting/floors` - 建立新樓層
- `PUT /lighting/floors/:id` - 更新樓層（**智能更新區域**）
- `DELETE /lighting/floors/:id` - 刪除樓層（級聯刪除區域）

### 已移除的 API（分類點管理）

以下 API 已移除，統一使用樓層管理 API：

- ❌ `GET /lighting/categories` - 已移除
- ❌ `GET /lighting/categories/:id` - 已移除
- ❌ `POST /lighting/categories` - 已移除
- ❌ `PUT /lighting/categories/:id` - 已移除
- ❌ `DELETE /lighting/categories/:id` - 已移除
- ❌ `PUT /lighting/categories/batch/positions` - 已移除

## 測試建議

1. **區域 ID 保留測試**：

   - 建立樓層和區域
   - 更新樓層（修改區域名稱）
   - 確認區域 ID 不變

2. **新增區域測試**：

   - 更新樓層時添加新區域（沒有 ID）
   - 確認新區域被建立並獲得 ID

3. **刪除區域測試**：

   - 更新樓層時移除某個區域
   - 確認該區域被刪除

4. **批次更新測試**：
   - 同時更新多個區域
   - 確認所有變更都在同一事務中完成

## 注意事項

1. **事務處理**：所有區域更新都在事務中完成，確保數據一致性
2. **ID 類型**：前端使用字串 ID，後端使用整數 ID，轉換由 `formatFloor` 和 `formatArea` 處理
3. **唯一性約束**：同一樓層內區域名稱必須唯一（`unique_floor_area_name` 約束）
4. **已移除欄位**：`description` 欄位已從所有區域相關操作中移除，與前端架構保持一致
5. **已移除 API**：所有分類點相關的 API 端點已移除，統一使用樓層管理 API

## 相關文件

- `FRONTEND_ARCHITECTURE.md` - 前端架構文檔
- `DATABASE_DOCUMENTATION.md` - 資料庫文檔
- `API_DOCUMENTATION.md` - API 文檔
