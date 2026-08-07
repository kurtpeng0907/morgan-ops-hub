# Morgan Ops Hub 效能改造部署手冊

## 目標與驗收門檻

- 登入至可操作首屏：P95 小於 2.5 秒。
- `/api/session`：P95 小於 1.5 秒。
- `/api/bootstrap`：暖快取 P95 小於 1 秒，回應不得包含實際 PIN。
- 首屏不得下載完整歷史資料；完整資料只在使用者進入需要的功能後載入。
- 寫入必須由 `/api/cloud` 回傳 `verified: true`，否則前端視為失敗。
- 管理員與師傅的既有登入、前台回報、班表送審、預約與客戶資料流程不得退化。

## 架構

瀏覽器只持有 30 分鐘、HttpOnly、SameSite=Lax 的簽章工作階段。Vercel Functions 代替瀏覽器向 Apps Script 傳送閘道密鑰；Apps Script 仍是 Google Sheets 的唯一資料寫入端。

首屏使用日期視窗化的 `bootstrap` 資料，Apps Script 以資料版本鍵做短期快取。所有成功寫入會提升版本，因此下一次讀取不會使用舊版本。完整資料由 `/api/full-data` 延後取得。

## 必要環境變數

在 Vercel Preview 與 Production 設定：

- `MORGAN_SESSION_SECRET`：至少 32 字元的隨機值。
- `MORGAN_GATEWAY_SECRET`：至少 24 字元，必須與 Apps Script 的 Script Property `GATEWAY_SECRET` 完全相同。
- `MORGAN_APPS_SCRIPT_URL`：目前 Web App 的 `/exec` URL。

密鑰不得寫入 Git、HTML、瀏覽器儲存空間或操作紀錄。

## 分階段上線

1. 將 Apps Script 變更合併進目前綁定資料庫的專案，設定 `GATEWAY_SECRET`，部署新 Web App 版本。
2. 以唯讀 `authenticate`、`bootstrap`、`fullData` 呼叫確認：前導零帳號可登入、回應無實際 PIN、既有公開選擇頁仍可讀。
3. 部署本分支到 Vercel Preview，設定 Preview 環境變數。
4. 在 Preview 驗證管理員及師傅登入、首屏、延後載入、寫入後雲端讀回，以及手機寬度版面。
5. 觀察至少一個營運時段；符合門檻後才合併並部署 Production。

## 觀測

- `/api/session`、`/api/bootstrap`、`/api/full-data`、`/api/cloud` 會輸出結構化延遲、上游延遲、狀態碼與回應大小；不記錄 PIN 或客戶內容。
- 前端將 `page_load`、`login_to_bootstrap`、`login_to_first_view`、`full_data` 傳到 `/api/performance`。
- 正式驗收以 Vercel 日誌的 P50/P95、錯誤率與回應大小為準，不以單次本機測量代替。

## 回滾

- 前端代理不可用時，登入會回到既有 Apps Script 路徑；不得以種子帳密替代雲端驗證。
- 若 Preview 驗證失敗，不合併 Production；刪除 Preview 環境變數並停用該 Preview 即可。
- 若 Production 上線後退化，將 Vercel Production 指回上一個 READY deployment。Apps Script 新增的閘道路由不改變舊版呼叫契約，可保留；必要時另部署回上一版 Apps Script。

## 本機驗證

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run dev:mock
```

本機模擬帳號僅存在測試伺服器中，不得當成正式登入備援。
