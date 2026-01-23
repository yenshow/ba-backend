# 人流統計系統架構檢視與優化總結

## 檢視日期
2026-01-23

## 架構概述

人流統計系統主要透過記錄（`baseacs.slot_card_records`）來呈現整個頁面，核心邏輯圍繞著：
1. **記錄查詢**：從外部資料庫查詢刷卡記錄
2. **統計計算**：計算進場/出場人數
3. **狀態判斷**：判斷人員是否在場
4. **資料展示**：將資料呈現給前端

## 已完成的優化

### 1. ✅ 統一資料庫查詢方法

**優化前**：
- `getSites()` 使用 `getTodayRecords()` 查詢「兩天前開始」的所有記錄
- `getSiteStats()` 使用 `getTodayRecordsOnly()` 查詢今日記錄
- 兩者查詢範圍不一致

**優化後**：
- 統一使用 `getTodayRecordsOnly()` 查詢今日記錄
- 確保 `getSites()` 和 `getSiteStats()` 使用相同的查詢邏輯

**效果**：
- ✅ 查詢範圍一致
- ✅ 減少資料傳輸量
- ✅ 提高查詢效率

### 2. ✅ 修正時區問題

**優化前**：
- `getTodayTimeRange()` 使用本地時間
- SQL 查詢使用 `toISOString()` 轉換為 UTC
- 可能導致時區不一致

**優化後**：
- `getTodayTimeRange()` 使用 UTC 時間計算
- 確保時間範圍與資料庫時區一致

**效果**：
- ✅ 解決時區不一致問題
- ✅ 確保統計準確性

### 3. ✅ 改進去重邏輯（基於事件序列）

**優化前**：
- 使用 1 分鐘時間窗口去重
- 可能導致統計不準確

**優化後**：
- 使用事件序列邏輯：確保先進後出
- 同一人的連續相同事件類型只計算一次

**效果**：
- ✅ 確保先進後出的邏輯正確
- ✅ 更準確地處理重複刷卡情況

### 4. ✅ 優化人員列表查詢邏輯

**優化前**：
- 在每個人的循環中重複過濾 `todayRecords`
- 每次都要查找該人員的今日記錄

**優化後**：
- 預先建立 `personTodayRecordsMap`，避免重複過濾
- 減少時間複雜度（從 O(n*m) 降低到 O(n+m)）

**效果**：
- ✅ 提高查詢效率
- ✅ 減少重複計算

### 5. ✅ 修正離場時間顯示邏輯

**優化前**：
- 顯示最近出場時間（可能是昨天的）
- 今日進場時可能顯示錯誤的離場時間

**優化後**：
- 今日進場時，只顯示今日的離場時間
- 今日沒有離場時，顯示 "- -"
- 非今日進場時，顯示最近離場時間

**效果**：
- ✅ 確保離場時間顯示正確
- ✅ 符合用戶需求

### 6. ✅ 簡化變數和邏輯

**優化內容**：
- 移除多餘的 `lastEntryDateTime` 變數
- 簡化 `isPresent` 判斷邏輯
- 優化變數使用

**效果**：
- ✅ 代碼更簡潔
- ✅ 邏輯更清晰

## 架構分析

### 核心資料流

```
外部資料庫 (baseacs.slot_card_records)
    ↓
getTodayRecordsOnly() / getLatestEntryExitRecords()
    ↓
calculateTodayStatsByPhysicalId() / calculateCurrentCount()
    ↓
getSites() / getSiteStats() / getUnitPersonnel()
    ↓
前端 API
    ↓
前端展示
```

### 關鍵函數

1. **查詢函數**：
   - `getTodayRecordsOnly()` - 查詢今日記錄（統一使用）
   - `getLatestEntryExitRecords()` - 查詢最近進出場記錄（不受時間限制）

2. **計算函數**：
   - `calculateTodayStatsByPhysicalId()` - 計算今日統計（事件序列邏輯）
   - `calculateCurrentCount()` - 計算當前在場人數

3. **業務函數**：
   - `getSites()` - 取得所有地點列表（含統計）
   - `getSiteStats()` - 取得單一地點統計
   - `getUnitPersonnel()` - 取得單位人員列表（含狀態）

### 資料查詢策略

**今日記錄查詢**：
- 統一使用 `getTodayRecordsOnly()` 
- 在 SQL 層面過濾時間範圍（00:00:00 - 23:59:59.999 UTC）
- 減少資料傳輸量

**最近記錄查詢**：
- 使用 `getLatestEntryExitRecords()` 查詢所有記錄
- 在應用層面提取最近進場和出場記錄
- 用於顯示最近進場日期（非今日進場的情況）

## 可進一步優化的部分

### 1. ⚠️ 查詢優化（可選）

**當前**：
- `getUnitPersonnel()` 中同時調用 `getTodayRecordsOnly()` 和 `getLatestEntryExitRecords()`
- 兩個查詢都是必要的（今日記錄用於統計和今日狀態，最近記錄用於非今日進場的情況）

**建議**：
- 當前架構已經合理，兩個查詢各有用途
- 如果未來需要進一步優化，可以考慮合併查詢（但會增加複雜度）

### 2. ⚠️ Deprecated 函數（保留）

**當前**：
- `getTodayRecords()` - 已標記為 deprecated，但保留以確保向後兼容
- `calculateTodayStats()` - 已標記為 deprecated，但保留以確保向後兼容
- `getTwoDaysAgo()` - 已標記為 deprecated，但在 `baseacsSlotCardRecordsHandler.js` 中使用

**建議**：
- 保留這些函數以確保向後兼容
- 未來可以逐步遷移並移除

## 架構優勢

1. **統一查詢**：所有今日記錄查詢都使用 `getTodayRecordsOnly()`
2. **時區一致**：使用 UTC 時間確保與資料庫一致
3. **邏輯清晰**：事件序列邏輯確保先進後出
4. **性能優化**：預先建立 Map 避免重複過濾
5. **職責分離**：查詢、計算、業務邏輯分離清晰

## 相關檔案

### 後端
- `src/services/systems/peopleCountingService.js` - 核心服務
- `src/routes/peopleCountingRoutes.js` - API 路由

### 前端
- `app/composables/systems/usePeopleCountingApi.ts` - API 層
- `app/composables/systems/peopleCounting/usePeopleCountingState.ts` - 狀態管理
- `app/composables/systems/peopleCounting/usePeopleCountingWebSocket.ts` - WebSocket 處理
- `app/pages/construction-monitoring/people-counting.vue` - 主頁面

## 總結

經過優化後，人流統計系統的架構已經：
- ✅ **統一**：查詢方法統一，邏輯一致
- ✅ **準確**：時區處理正確，統計準確
- ✅ **高效**：減少重複查詢和計算
- ✅ **清晰**：邏輯清晰，易於維護

系統現在主要透過記錄來呈現整個頁面，架構已經精簡且高效。

