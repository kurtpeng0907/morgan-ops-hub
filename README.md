# 管理營運系統

內部營運管理中樞網站，包含後台營運管理、獨立前台師傅排班系統，以及 Neon Postgres 資料層。

SQL 遷移與回滾程序見 [`MORGAN_SQL_ROLLOUT.md`](./MORGAN_SQL_ROLLOUT.md)。Production 預設仍使用 `apps-script`；只有通過 Preview shadow 比對後才把 `MORGAN_DATA_SOURCE` 切為 `sql`。

## 使用方式

直接開啟 `index.html`，或用本機伺服器啟動：

```bash
python3 -m http.server 4173
```

後台管理頁：

```text
http://localhost:4173/
```

前台師傅排班頁：

```text
http://localhost:4173/frontdesk.html
```

## 檔案

- `index.html`：後台管理頁
- `frontdesk.html`：前台師傅排班系統
- `styles.css`：介面樣式
- `app.js`：後台系統功能邏輯
- `api/_lib/sql-repository.js`：Neon SQL 讀寫、權限與分頁資料層
- `drizzle/0000_morgan_sql.sql`：Drizzle 管理的初始 SQL migration
- `scripts/import-sheets.js`：Sheets 快照匯入（PIN 直接轉 Argon2id，不輸出明碼）
- `scripts/verify-migration.js`：遷移後列數與欄位雜湊比對
- `screenshot-overview.png`：總覽截圖
- `screenshot-appointment.png`：預約截圖
