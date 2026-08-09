# Morgan SQL 遷移與切換手冊

## 已完成的安全基準（2026-08-10）

- 正式來源：`按摩師排班資料庫`，ID `1mbkoZzPpJJcK03v5GVJoyJzThFO-Lt2NMAz-4ixmLxE`。
- 遷移前完整 Drive 複本：[`按摩師排班資料庫_SQL遷移前完整備份_2026-08-10`](https://docs.google.com/spreadsheets/d/1FX-pXKuN609OdsavpcLZXm3rSJtS56K4JVhd9wotRvQ/edit)。複本 ID 與來源不同，8 個工作表及 sheetId 已核對一致。
- 唯讀 JSON 快照 SHA-256：`fbc7a2596c105a19adbe2797c7237fd894952c6f07210f7066d1ee48d40b9f1a`，560,431 bytes，檔案權限 `0600`。
- 轉換基準：28 users、25 therapists、2,268 schedules、530 customers、804 appointments、54 service records、78 system records。
- 核心雜湊：appointments `c2f0ddfbfe43557c039d43c54a2a12ebc8ab652602aefe6c0982b2273b456e7e`；customers `237b5095c09fb56788a464628493c3a9b4c4b132faadd7f76d52643f3cefdf18`；service records `a2c99efa95a7c5f55a3b9a1a152cf284ccf829f3355b3ad1be5c9cf16e8e94c5`。
- 來源 Apps Script/LINE 檔案未修改。SQL migration、匯入器與 API 不包含 LINE Token、收件者、Webhook 或觸發器。

含明碼 PIN 的 JSON 快照只能留在受限 `/tmp`，匯入和驗證完成後刪除；不得加入 Git、Vercel build output 或雲端備份。

## 資料來源旗標

| `MORGAN_DATA_SOURCE` | 行為 |
|---|---|
| `apps-script` | 現行正式路徑；作為回滾來源。 |
| `shadow` | 使用 Sheets 回應瀏覽器，同一登入請求並行讀 SQL，日誌只記 counts 與 SHA-256 差異。 |
| `sql` | Neon 是唯一正式讀寫來源；不自動 fallback 到 Apps Script。 |

Preview 與 Production 必須使用不同 Neon branch／連線字串。`DATABASE_URL` 只能存在 Vercel 加密環境變數，不得放入 HTML 或公開前綴環境變數。

## 建立資料庫後的執行順序

以下命令都從專案根目錄執行，`DATABASE_URL` 由環境注入：

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run db:migrate
pnpm run db:import -- --input /tmp/morgan-sql-migration-2026-08-10.json
pnpm run db:verify -- --input /tmp/morgan-sql-migration-2026-08-10.json
```

匯入器只接受空資料庫，偵測到既有 users、appointments 或 customers 就停止，不會覆寫。PIN 在記憶體中轉成 Argon2id 後寫入 `pin_hash`；日誌只有帳數、雜湊與 migration run ID。

## Preview 驗收

1. Marketplace Neon 建在亞洲區，Vercel Functions region 為 `hkg1`。
2. Preview 先設 `MORGAN_DATA_SOURCE=shadow`。檢查 `morgan_sql_shadow` 日誌，所有請求 `match=true`；差異只以 counts／SHA-256 顯示。
3. 再把 Preview 設為 `sql`，測試管理員與師傅：登入、指定日首屏、月預約、顧客服務歷史、班表、預約、服務回報、回款、報表、登出。
4. 重送相同 `mutation_id`，確認 mutations 只有一列、核心資料不重複。
5. 驗證停用帳號、未登入、跨師傅讀寫均為 401/403。
6. 驗證 `002`、`0007` 保持字串；API、日誌、export 都沒有 PIN／pin_hash。
7. 連續 100 次混合測試不得出現 Apps Script fallback；以 `Server-Timing` 與結構化日誌計算 P95。

只有資料差異為 0 且功能／效能門檻全部通過，才能 promote 同一個 READY Preview。不要重新 build Production。

## 寫入與逾時

- `/api/cloud` 每次寫入必須有 `mutationId`。
- `apply_morgan_mutation` 在同一 Postgres transaction 內取得 transaction advisory lock、查舊結果、執行 actions、寫 mutations 與 audit log。
- HTTP timeout 後不得重送；前端依序在 1 秒、3 秒查 `/api/mutation-status`。
- SQL 成功即 `verified=true`，不再下載完整資料驗證。
- 一般 UI 不再呼叫 `/api/full-data`；該端點只允許管理員匯出。

## 回滾

1. 將 Production 指回切換前的 READY deployment，或把 `MORGAN_DATA_SOURCE` 切回 `apps-script`。
2. 不刪除 SQL 資料與 mutations；保存切換期間 mutation 清單供補回。
3. 七日穩定期內 Sheets 同步鏡像只作回滾；之後停止即時鏡像，改成每日唯讀匯出。
4. 原始含 PIN Sheet 受限保存 30 天後輪替帳密並封存。

## LINE 不變保證

本次不得部署或修改 `apps-script-secure-Code.gs`。LINE 常數、Script Properties、Token、收件者、Webhook、回覆／推播函式與既有觸發器均不在變更範圍。驗收時以 Git blob SHA 與線上 Apps Script 版本清單核對，不以目視判定。
