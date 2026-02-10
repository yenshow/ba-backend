# 警報系統重構方案

**版本**：1.0  
**日期**：2026-02-10  
**狀態**：供嚴密審查用；Phase 1～3 已實作；已精簡為僅 `updated_at`（無 `resolved_at`）  
**目標**：建立語意清晰、可稽核、當天有效且時間戳一致的警報架構。

---

## 一、現有設計問題整理

### 1.1 語意與稽核問題

| 問題 | 說明 | 審查風險 |
|------|------|----------|
| **一筆解決、多筆同時間** | 原為對同一 (source, source_id, alert_type) 的**所有** active 做一次 UPDATE，多筆得到相同 `updated_at`。 | 不利稽核。 |
| **列表聚合隱藏明細** | `getAlerts` 依 `(source, source_id, alert_type, status)` **GROUP BY**，回傳 MIN(created_at)、MAX(updated_at) 等，前端看到的是「合併後的一張卡」，不是「一筆一筆事件」。 | 與實際資料列不一致，篩選創建時間時易產生「為何更新/解決時間相同」的困惑。 |
| **跨日未結案** | 創建為「當天有效」（同天同來源同類型只一筆 active），但解決不限制「當天」，可出現 1 月創建、2 月才解決。 | 與「當天有效」直覺不符，且易堆積陳年 active。 |

### 1.2 架構層面

- **解決**：批次 UPDATE，條件僅 (source_id, source, alert_type)，不區分「當天／歷史」。
- **列表**：以「群組」為單位回傳，非以「單一事件」為單位。
- **限天**：只刪已解決且 `updated_at` 超過保留天數；無每日結案時易堆積歷史 active。

---

## 二、目標架構原則

1. **一列一事件**：每筆 `alerts` 列對應一個可解釋的「事件」—— 發生於 `created_at`，結束由 `status=resolved` 與當時的 `updated_at` 表示。
2. **時間戳可稽核**：解決時間即該筆變為 resolved 時的 `updated_at`，每筆獨立。
3. **當天有效一貫**：同一天同來源同類型僅一筆 active；隔天再發生則為新一筆。歷史未結案的 active 由**每日排程**在固定時點結案，不依「問題恢復」一次全部解決。
4. **列表與資料一致**：列表 API 以「一列一筆」為單位回傳（不依 status 等做 GROUP BY 合併），方便與 DB 與報表對應。

---

## 三、重構方案總覽

| 項目 | 現狀 | 目標 |
|------|------|------|
| **解決時機** | 問題恢復時，一次解決該 (source, source_id, alert_type) **全部** active。 | 問題恢復時，只解決「**當前**」一筆 active（例如 `created_at` 最新的一筆）；其餘由每日排程結案。 |
| **每日排程** | 無。 | 備份前將「`created_at` 早於今日 00:00 且仍 active」的列標記為已解決，`updated_at` = 執行時。 |
| **列表 API** | GROUP BY 回傳聚合。 | 一列一筆，不 GROUP BY。 |
| **時間語意** | 多筆可共用同一 `updated_at`。 | 只解最新一筆，該筆 `updated_at` 即解決時間；無 `resolved_at` 欄位。 |

---

## 四、詳細設計

### 4.1 解決邏輯（問題恢復時）

- **觸發**：設備／環境恢復時，現有呼叫保持不變（如 `errorTracker.clearError`、`alertService.updateAlertStatus`、environment 閾值恢復等）。
- **行為變更**：由「更新所有符合 (source_id, source, alert_type) 且 status != resolved 的列」改為「**只更新其中 created_at 最大的那一筆 active**」。
- **實作要點**：`resolveLatestActiveAlert(source, sourceId, alertType)` 查詢最新一筆 active，`UPDATE status='resolved', updated_at=CURRENT_TIMESTAMP WHERE id=?`。`updateAlertStatus(..., RESOLVED)` 呼叫此函數。

### 4.2 每日排程（歷史 active 結案）

- **目的**：昨日及更早的 active 標記為已解決，`updated_at` = 執行時。
- **介面**：`alertService.resolveStaleActiveAlerts()`，無參數，以 `getTodayDateRange().todayStart` 為界；在備份排程開頭執行。

### 4.3 列表 API（一列一筆）

- **查詢**：移除 `GROUP BY a.source, a.source_id, a.alert_type, a.status`；改為對 `alerts` 單表（及必要 JOIN）直接分頁篩選，每列對應一筆警報。
- **SELECT**：每列回傳該筆的 `id, source, source_id, alert_type, severity, message, status, created_at, updated_at, ignored_at, ignored_by` 及 JOIN 來源名稱等。
- **排序**：依 `created_at` 或 `updated_at` 等，以列為單位排序。
- **總數**：`COUNT(*)` 為列數，與分頁結果一致。
- **相容性**：若前端或報表曾依「群組」顯示，需一併調整為「一筆一卡」或由前端自行依需求做群組；後端以「一列一筆」為準，利於審查與匯出。

### 4.4 其他行為不變

- **創建**：維持「當天同來源同類型僅一筆 active」邏輯（`findExistingActiveAlert` + `getTodayDateRange`）。
- **忽視／取消忽視**：仍可依 (source_id, source, alert_type) 批次更新；若未來要與「一列一事件」完全一致，可再考慮改為單筆操作，非本階段必要。
- **限天**：僅刪除「已解決且 `updated_at` 超過保留天數」的列。
- **備份／報表**：依列匯出，創建/更新/忽視時間與新列表一致。

---

## 五、實作順序建議與狀態

1. **Phase 1：解決邏輯** ✅ 已實作  
   - `resolveLatestActiveAlert(source, sourceId, alertType)` 已實作；`updateAlertStatus(..., RESOLVED)` 只更新最新一筆 active。

2. **Phase 2：每日排程** ✅ 已實作  
   - `resolveStaleActiveAlerts()` 無參數，內部以 `getTodayDateRange().todayStart`（今日 00:00 UTC）為界，將更早的 active 標記為已解決；在 `backupScheduler.runBackup()` 開頭執行，結果寫入 `results.staleAlertsResolved`。

3. **Phase 3：列表 API** ✅ 已實作  
   - `getAlerts` 已改為一列一筆：移除 GROUP BY，`buildAlertSelectQuery()` 改為每列回傳單筆警報欄位，總數為 `COUNT(*)`。

4. **Phase 4：文件與測試**  
   - 更新 `ALERT_IMPLEMENTATION_GUIDE.md`，反映「一列一事件、只解決當前、每日結案、列表一列一筆」。  
   - 補充單元／整合測試：創建多筆跨日 active → 問題恢復只解最新一筆 → 排程結案其餘 → 列表與 DB 一致。

---

## 六、資料庫與介面影響

- **Schema**：無 `resolved_at`，僅 `created_at`、`updated_at`、`ignored_at` 等。
- **API 回傳**：列表從「群組聚合」改為「一列一筆」，回傳筆數可能增加（同一來源多天多筆），前端需能依 `id` 或 `created_at` 區分。
- **WebSocket**：若目前依群組推送，可改為依「單筆警報」推送，與新列表一致。

---

## 七、審查檢查清單（重構後）

- [ ] 每筆警報列是否對應單一可解釋事件（發生時間、結束時間或未結束）？
- [ ] 問題恢復時是否僅更新「當前」一筆 active，其餘由每日排程結案？
- [ ] 每日結案是否在備份前執行，將昨日及更早的 active 標記為已解決？
- [ ] 列表 API 是否一列一筆，與 DB 及報表一致？
- [ ] 解決時間是否以 status=resolved 時的 `updated_at` 表示，無多筆同時間戳？

---

## 八、參考

- 現有實作：`src/services/alerts/alertService.js`、`errorTracker.js`、`systemAlertHelper.js`
- 監控與恢復：`environmentMonitor.js`、`lightingMonitor.js`
- 規範說明：`docs/ALERT_IMPLEMENTATION_GUIDE.md`
