# Morgan Production System Baseline

> 本文件是 Phase 0 的可追溯基準。Production 網站的網路／瀏覽器讀取尚待可用環境完成；未標記為 verified 的項目不可視為已驗證。

## Candidate source

- Candidate Production checkout: `morgan_performance_api_20260807`
- Public hostname: `https://morgan-ops-hub.vercel.app`
- Admin entry: `/` → `index.html`
- Therapist entry: `/frontdesk.html`
- Customer selection entry: `/client-selection.html`
- Primary data source switch: `MORGAN_DATA_SOURCE`
- Legacy adapter: Google Apps Script
- SQL adapter: `api/_lib/sql-repository.js`

## Role and route map

| Actor | Entry | Read scope | Write scope |
|---|---|---|---|
| admin | `/` | operational workspace | approved admin mutations |
| therapist | `/frontdesk.html` | own schedule, appointments and required customer context | own schedule, service records and approved own context |
| customer | `/client-selection.html` | one selection context | selection submission only |
| LINE / cron | API routes | notification-specific | notification-specific |

## Functional traceability

| Capability | UI source | API boundary | Verification |
|---|---|---|---|
| Daily operations | `index.html`, `app.js` | `/api/bootstrap`, `/api/full-data` | authenticated browser read |
| Booking lifecycle | `app.js` | `/api/cloud`, `/api/appointments` | transition + read-back |
| Customer records | `app.js`, `frontdesk.html` | `/api/customer-records` | scope and pagination tests |
| Therapist portal | `frontdesk.html` | `/api/session`, `/api/cloud` | ownership tests |
| Customer selection | `client-selection.html` | cloud adapter | duplicate/expired-link tests |
| Notifications | API cron/webhook files | LINE routes | signature and delivery checks |

## Verification status

- Local source inspection: verified 2026-08-11.
- Public asset-to-source mapping: pending network/browser access.
- Authenticated Production flow: pending authorized browser access.
- Production deployment identity: pending Vercel/API access.
