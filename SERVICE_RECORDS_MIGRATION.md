# ServiceRecords 雙寫遷移手冊

## 固定目標

- 正式試算表：`按摩師排班資料庫` (`1mbkoZzPpJJcK03v5GVJoyJzThFO-Lt2NMAz-4ixmLxE`)
- 每批處理 100 位一般客戶，批次間隔 1–2 秒。
- `SYS_*` 不遷移。
- `Customers.records` 在完成兩個營業日觀察前不得刪除。
- 舊 JSON 超過 45,000 字元時不再增長；相容讀取由 ServiceRecords 重建。

## 上線順序

1. 複製整份正式試算表作為不可修改備份，記錄備份 ID、建立時間及原始列數。
2. 將本分支的 Apps Script 增量合併到實際線上專案；不得覆蓋 LINE 或其他未提交函式。
3. 設定 Apps Script `GATEWAY_SECRET`，部署新 Web App 版本。
4. 設定 Vercel Preview 的 `MORGAN_SESSION_SECRET`、`MORGAN_GATEWAY_SECRET`、`MORGAN_APPS_SCRIPT_URL`。
5. 用 `/api/cloud` 的 `backfillServiceRecords` 由 cursor `0` 開始，每次嚴格處理最多 100 筆服務紀錄，直到 `nextCursor` 為 `null`。
6. 每批後執行 `/api/service-records-audit`；遷移完成時 `mismatchCount` 必須為 `0`。
7. Preview 驗證管理員／師傅登入、客戶紀錄分頁、預約、回報、班表與 mutation 重送。
8. Shadow 雙寫觀察一個完整營業日，再申請 Production 推送。

## 寫入契約

每次寫入帶唯一 `mutationId`。若 HTTP timeout，不得直接重送；先查：

```text
GET /api/mutation-status?mutationId=<id>
```

只有 `found: false` 才能由人工決定重送。`status: verified` 視為完成。

## 驗收與回滾

- `ServiceRecords` 與舊 records 的 ID／日期／師傅／服務／回款／備註差異為 0。
- 最大舊 records 儲存格不得再超過 45,000 字元。
- 失敗時將 Vercel 指回上一個 READY deployment，Apps Script 切回上一版本；保留新工作表與備份，不刪資料。
