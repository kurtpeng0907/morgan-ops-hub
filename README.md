# 管理營運系統

內部營運管理中樞網站，包含後台營運管理與獨立前台師傅排班系統。

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
- `screenshot-overview.png`：總覽截圖
- `screenshot-appointment.png`：預約截圖
