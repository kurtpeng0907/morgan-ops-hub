"use strict";

const { sqlClient } = require("./database");

const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
const TAIPEI_TIME_ZONE = "Asia/Taipei";

function taipeiParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TAIPEI_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(value).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return parts;
}

function taipeiDate(value = new Date()) {
  const parts = taipeiParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function taipeiMinute(value = new Date()) {
  const parts = taipeiParts(value);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function configured(value) {
  const result = String(value || "").trim();
  if (!result) throw Object.assign(new Error("LINE is not configured"), { code: "line_not_configured" });
  return result;
}

async function boundGroupId() {
  const rows = await sqlClient()`SELECT recipient_id FROM line_staff_recipients WHERE recipient_key = 'staff-group' LIMIT 1`;
  return rows[0] ? String(rows[0].recipient_id) : "";
}

async function bindStaffGroup(groupId) {
  const id = String(groupId || "").trim();
  if (!id || id.length > 255) return { status: "invalid" };
  const sql = sqlClient();
  const inserted = await sql`
    INSERT INTO line_staff_recipients (recipient_key, recipient_id)
    VALUES ('staff-group', ${id})
    ON CONFLICT (recipient_key) DO NOTHING
    RETURNING recipient_id
  `;
  if (inserted[0]) return { status: "bound" };
  const existing = await boundGroupId();
  return { status: existing === id ? "already_bound" : "different_group_bound" };
}

async function lineApi(url, payload) {
  const token = configured(process.env.LINE_CHANNEL_ACCESS_TOKEN);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw Object.assign(new Error(`LINE API returned ${response.status}`), { code: "line_api_failed" });
}

async function replyLine(replyToken, text) {
  if (!replyToken) return;
  await lineApi(LINE_REPLY_ENDPOINT, { replyToken: String(replyToken), messages: [{ type: "text", text: String(text).slice(0, 5000) }] });
}

async function pushMessages(recipientId, messages) {
  const list = Array.isArray(messages) ? messages.slice(0, 5) : [];
  if (!list.length) return;
  await lineApi(LINE_PUSH_ENDPOINT, { to: String(recipientId), messages: list });
}

async function pushLine(groupId, text) {
  await pushMessages(groupId, [{ type: "text", text: String(text).slice(0, 5000) }]);
}

async function dailyBrief(now = new Date()) {
  const date = taipeiDate(now);
  const rows = await sqlClient()`
    SELECT a.id, a.time, a.customer_name, a.service, a.room, a.is_completed, a.therapist_id,
           coalesce(t.display_name, '') AS therapist_name
    FROM appointments a
    LEFT JOIN therapists t ON t.therapist_id = a.therapist_id
    WHERE a.date = ${date}::date
    ORDER BY a.time, a.id
  `;
  const minute = taipeiMinute(now);
  const active = rows.filter((row) => !row.is_completed);
  const next = active.filter((row) => {
    const match = String(row.time || "").match(/^(\d{1,2}):(\d{2})/);
    return match && Number(match[1]) * 60 + Number(match[2]) >= minute;
  }).slice(0, 3);
  const attention = active.filter((row) => !row.customer_name || !row.therapist_id || !row.time || !row.room);
  const lines = [`☀️ 今日營運重點｜${date}`, `預約 ${rows.length} 筆｜待服務 ${active.length} 筆｜已完成 ${rows.length - active.length} 筆`];
  lines.push("", "接下來行程：");
  if (!next.length) lines.push("• 今日已無待服務預約");
  next.forEach((row) => lines.push(`• ${String(row.time).slice(0, 5)} ${String(row.customer_name || "未填姓名")}｜${String(row.therapist_name || row.therapist_id || "未排師傅")}｜${String(row.service || "未填服務")}｜${String(row.room || "未排房")}`));
  if (attention.length) lines.push("", `⚠️ 待確認 ${attention.length} 筆：缺少必要排程欄位`);
  return lines.join("\n");
}

function appointmentMinute(row) {
  const match = String(row.time || "").match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

async function sendDailyBrief(now = new Date()) {
  const groupId = await boundGroupId();
  if (!groupId) return { sent: false, reason: "recipient_not_bound" };
  await pushLine(groupId, await dailyBrief(now));
  return { sent: true };
}

async function sendUpcomingAlerts(now = new Date()) {
  const groupId = await boundGroupId();
  if (!groupId) return { sent: 0, reason: "recipient_not_bound" };
  const date = taipeiDate(now);
  const nowMinute = taipeiMinute(now);
  const lead = Math.max(15, Math.min(180, Number(process.env.LINE_REMINDER_LEAD_MINUTES || 60)));
  const rows = await sqlClient()`
    SELECT a.id, a.date, a.time, a.customer_name, a.service, a.room, a.therapist_id,
           coalesce(t.display_name, '') AS therapist_name
    FROM appointments a LEFT JOIN therapists t ON t.therapist_id = a.therapist_id
    WHERE a.date = ${date}::date AND a.is_completed = false
    ORDER BY a.time, a.id
  `;
  let sent = 0;
  for (const row of rows) {
    const minute = appointmentMinute(row);
    if (minute === null || minute - nowMinute > lead || minute - nowMinute < 0) continue;
    const slot = `${date}T${String(row.time).slice(0, 5)}:00+08:00`;
    const reservation = await sqlClient()`
      INSERT INTO line_staff_alerts (appointment_id, alert_kind, scheduled_at)
      VALUES (${String(row.id)}, 'upcoming', ${slot}::timestamptz)
      ON CONFLICT (appointment_id, alert_kind, scheduled_at) DO NOTHING
      RETURNING appointment_id
    `;
    if (!reservation[0]) continue;
    try {
      await pushLine(groupId, `⏰ 即將開始｜${String(row.time).slice(0, 5)} ${String(row.customer_name || "未填姓名")}｜${String(row.therapist_name || row.therapist_id || "未排師傅")}｜${String(row.service || "未填服務")}｜${String(row.room || "未排房")}`);
      await sqlClient()`UPDATE line_staff_alerts SET sent_at = now() WHERE appointment_id = ${String(row.id)} AND alert_kind = 'upcoming' AND scheduled_at = ${slot}::timestamptz`;
      sent += 1;
    } catch (error) {
      await sqlClient()`DELETE FROM line_staff_alerts WHERE appointment_id = ${String(row.id)} AND alert_kind = 'upcoming' AND scheduled_at = ${slot}::timestamptz AND sent_at IS NULL`;
      throw error;
    }
  }
  return { sent };
}

function bookingAdminUrl(selection) {
  const base = String(process.env.OPS_HUB_PUBLIC_URL || "https://morgan-ops-hub.vercel.app").trim().replace(/\/$/, "");
  const params = new URLSearchParams({
    tab: "overview",
    selection: String(selection.id || ""),
    date: String(selection.date || "")
  });
  return `${base}/?${params.toString()}`;
}

function bookingAlertFlex(selection) {
  const date = String(selection.date || "");
  const time = String(selection.time || "").slice(0, 5);
  const service = String(selection.serviceName || selection.service || "未填服務");
  const therapist = String(selection.selectedTherapistName || selection.selectedTherapistId || "未指定");
  const customer = String(selection.customerName || "未留姓名");
  const contact = String(selection.customerContact || "未留聯絡方式");
  return {
    type: "flex",
    altText: `新的預約需求待處理｜${date} ${time}`.slice(0, 400),
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#65725E",
        paddingAll: "16px",
        contents: [
          { type: "text", text: "MODERN MORGAN", color: "#E8EEE4", size: "xs", weight: "bold" },
          { type: "text", text: "新的預約需求待處理", color: "#FFFFFF", size: "lg", weight: "bold", margin: "sm" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "16px",
        contents: [
          { type: "text", text: `${date}  ${time}`, size: "lg", weight: "bold", color: "#242922" },
          { type: "text", text: service, size: "sm", weight: "bold", color: "#46513F", wrap: true },
          { type: "separator", margin: "sm" },
          { type: "box", layout: "baseline", spacing: "sm", contents: [{ type: "text", text: "師傅", size: "xs", color: "#7A8276", flex: 2 }, { type: "text", text: therapist, size: "sm", color: "#242922", flex: 5, wrap: true }] },
          { type: "box", layout: "baseline", spacing: "sm", contents: [{ type: "text", text: "顧客", size: "xs", color: "#7A8276", flex: 2 }, { type: "text", text: customer, size: "sm", color: "#242922", flex: 5, wrap: true }] },
          { type: "box", layout: "baseline", spacing: "sm", contents: [{ type: "text", text: "聯絡", size: "xs", color: "#7A8276", flex: 2 }, { type: "text", text: contact, size: "sm", color: "#242922", flex: 5, wrap: true }] },
          { type: "box", layout: "baseline", spacing: "sm", contents: [{ type: "text", text: "狀態", size: "xs", color: "#7A8276", flex: 2 }, { type: "text", text: "待確認", size: "sm", weight: "bold", color: "#8A641D", flex: 5 }] }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "12px",
        contents: [{
          type: "button",
          style: "primary",
          color: "#65725E",
          height: "sm",
          action: { type: "uri", label: "開啟 Ops Hub 處理", uri: bookingAdminUrl(selection) }
        }]
      }
    }
  };
}

// A public request is an internal operational event, not a customer broadcast.
// Failure is intentionally non-blocking: the verified pending request remains in
// the admin queue even when LINE is unavailable.
async function sendPublicBookingAlert(selection) {
  const groupId = await boundGroupId();
  if (!groupId) return { sent: false, reason: "recipient_not_bound" };
  if (!String(process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim()) return { sent: false, reason: "line_not_configured" };

  const selectionId = String(selection.id || "").trim();
  if (!selectionId) return { sent: false, reason: "selection_id_missing" };
  const scheduledAt = `${String(selection.date || taipeiDate())}T${String(selection.time || "00:00").slice(0, 5)}:00+08:00`;
  const reservation = await sqlClient()`
    INSERT INTO line_staff_alerts (appointment_id, alert_kind, scheduled_at)
    VALUES (${selectionId}, 'public_booking', ${scheduledAt}::timestamptz)
    ON CONFLICT (appointment_id, alert_kind, scheduled_at) DO NOTHING
    RETURNING appointment_id
  `;
  if (!reservation[0]) return { sent: false, reason: "duplicate" };

  try {
    await pushMessages(groupId, [bookingAlertFlex(selection)]);
    await sqlClient()`
      UPDATE line_staff_alerts
      SET sent_at = now()
      WHERE appointment_id = ${selectionId}
        AND alert_kind = 'public_booking'
        AND scheduled_at = ${scheduledAt}::timestamptz
    `;
    return { sent: true };
  } catch (error) {
    await sqlClient()`
      DELETE FROM line_staff_alerts
      WHERE appointment_id = ${selectionId}
        AND alert_kind = 'public_booking'
        AND scheduled_at = ${scheduledAt}::timestamptz
        AND sent_at IS NULL
    `;
    throw error;
  }
}

module.exports = { bindStaffGroup, replyLine, sendDailyBrief, sendUpcomingAlerts, sendPublicBookingAlert, taipeiDate, taipeiMinute };
