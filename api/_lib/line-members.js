"use strict";

const { sqlClient, dataSourceMode } = require("./database");

const LINE_ID_TOKEN_VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
const LINE_USER_ID = /^U[0-9a-f]{32}$/i;

function configured(name, { publicValue = false } = {}) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw Object.assign(new Error(`${name} is not configured`), { code: publicValue ? "liff_not_configured" : "member_not_configured" });
  return value;
}

function assertSqlMembers() {
  if (dataSourceMode() !== "sql") throw Object.assign(new Error("LINE members require SQL"), { code: "member_unavailable" });
}

function publicMemberConfig() {
  return { liffId: configured("LINE_LIFF_ID", { publicValue: true }) };
}

async function verifyLineIdToken(idToken) {
  const token = String(idToken || "").trim();
  if (!token || token.length > 12000) throw Object.assign(new Error("missing_line_id_token"), { code: "unauthorized" });
  const clientId = configured("LINE_LOGIN_CHANNEL_ID");
  const body = new URLSearchParams({ id_token: token, client_id: clientId });
  let response;
  try {
    response = await fetch(LINE_ID_TOKEN_VERIFY_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  } catch {
    throw Object.assign(new Error("line_verification_unavailable"), { code: "member_unavailable" });
  }
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok || String(payload.aud || "") !== clientId || !LINE_USER_ID.test(String(payload.sub || ""))) {
    throw Object.assign(new Error("invalid_line_id_token"), { code: "unauthorized" });
  }
  return { lineUserId: String(payload.sub), displayName: String(payload.name || "").slice(0, 160), pictureUrl: String(payload.picture || "").slice(0, 2000) };
}

async function memberFromIdToken(idToken) {
  assertSqlMembers();
  const identity = await verifyLineIdToken(idToken);
  const sql = sqlClient();
  const rows = await sql`
    INSERT INTO customer_members (line_user_id, line_display_name, picture_url, updated_at)
    VALUES (${identity.lineUserId}, ${identity.displayName}, ${identity.pictureUrl}, now())
    ON CONFLICT (line_user_id) DO UPDATE SET
      line_display_name = CASE WHEN EXCLUDED.line_display_name = '' THEN customer_members.line_display_name ELSE EXCLUDED.line_display_name END,
      picture_url = CASE WHEN EXCLUDED.picture_url = '' THEN customer_members.picture_url ELSE EXCLUDED.picture_url END,
      updated_at = now()
    RETURNING id, line_user_id, line_display_name, picture_url, contact_name, contact_phone, created_at, updated_at
  `;
  return memberShape(rows[0]);
}

function memberShape(row = {}) {
  return {
    id: String(row.id || ""), lineDisplayName: String(row.line_display_name || ""), pictureUrl: String(row.picture_url || ""),
    contactName: String(row.contact_name || ""), contactPhone: String(row.contact_phone || ""),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : "", updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : ""
  };
}

function customerStatus(selection, appointment) {
  const selectionStatus = String(selection?.status || "");
  if (["rejected", "cancelled"].includes(selectionStatus)) return { code: "cancelled", label: selectionStatus === "rejected" ? "未安排" : "已取消" };
  if (!appointment && selectionStatus === "confirmed") return { code: "updated", label: "預約已更新，請聯絡店家" };
  if (!appointment) return { code: "pending", label: "待確認" };
  const stage = String(appointment.booking_stage || "");
  if (stage === "cancelled") return { code: "cancelled", label: "已取消" };
  if (stage === "completed" || appointment.is_completed) return { code: "completed", label: "服務完成" };
  if (["pre_notice", "service_report"].includes(stage)) return { code: "pre_notice", label: "行前處理" };
  return { code: "confirmed", label: "已確認" };
}

function selectionShape(selection, appointment) {
  const status = customerStatus(selection, appointment);
  return {
    id: String(selection.id || ""), date: String(selection.date || appointment?.date || ""), time: String(selection.time || appointment?.time || "").slice(0, 5),
    service: String(selection.serviceName || selection.service || appointment?.service || ""),
    therapistName: String(selection.selectedTherapistName || appointment?.therapist_name || ""), status, appointmentId: String(selection.appointmentId || appointment?.id || "")
  };
}

async function memberBootstrap(member, { cursor = "", limit = 30 } = {}) {
  const sql = sqlClient();
  const memberId = String(member.id);
  const max = Math.max(1, Math.min(60, Number(limit || 30)));
  const selectionRows = await sql`
    SELECT notes FROM system_records
    WHERE key LIKE 'SYS_CLIENT_SELECTION_%' AND notes::jsonb ->> 'memberId' = ${memberId}
    ORDER BY updated_at DESC LIMIT ${max}
  `;
  const selections = selectionRows.map((row) => { try { return JSON.parse(String(row.notes || "{}")); } catch { return null; } }).filter((value) => value?.id);
  const appointmentIds = selections.map((selection) => String(selection.appointmentId || "")).filter(Boolean);
  const appointmentRows = appointmentIds.length ? await sql`
    SELECT a.id, a.date::text AS date, a.time::text AS time, a.service, a.booking_stage, a.is_completed,
           coalesce(t.display_name, '') AS therapist_name
    FROM appointments a LEFT JOIN therapists t ON t.therapist_id = a.therapist_id
    WHERE a.id = ANY(${appointmentIds})
  ` : [];
  const byAppointment = new Map(appointmentRows.map((row) => [String(row.id), row]));
  const progress = selections.map((selection) => selectionShape(selection, byAppointment.get(String(selection.appointmentId || "")))).sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  const historyRows = await sql`
    SELECT a.id, a.date::text AS date, a.time::text AS time, a.service, a.booking_stage, a.is_completed,
           coalesce(t.display_name, '') AS therapist_name
    FROM appointments a
    JOIN member_legacy_links l ON l.customer_key_legacy = a.customer_key_legacy
    LEFT JOIN therapists t ON t.therapist_id = a.therapist_id
    WHERE l.member_id = ${memberId}
    ORDER BY a.date DESC, a.time DESC LIMIT ${max}
  `;
  const history = historyRows.map((row) => ({ id: String(row.id), date: String(row.date), time: String(row.time || "").slice(0, 5), service: String(row.service || ""), therapistName: String(row.therapist_name || ""), status: customerStatus(null, row) }));
  return { member, progress, history, nextCursor: cursor ? null : null };
}

async function updateMemberProfile(member, data = {}) {
  const contactName = String(data.contactName || "").trim().slice(0, 80);
  const contactPhone = String(data.contactPhone || "").trim().slice(0, 120);
  if (!contactPhone) throw Object.assign(new Error("contact_phone_required"), { code: "validation_error" });
  const rows = await sqlClient()`UPDATE customer_members SET contact_name = ${contactName}, contact_phone = ${contactPhone}, updated_at = now() WHERE id = ${String(member.id)} RETURNING id, line_display_name, picture_url, contact_name, contact_phone, created_at, updated_at`;
  return memberShape(rows[0]);
}

async function memberLinkInfo(customerKey) {
  const rows = await sqlClient()`SELECT m.id, m.line_display_name, m.contact_name, m.contact_phone, m.picture_url, l.linked_at FROM member_legacy_links l JOIN customer_members m ON m.id = l.member_id WHERE l.customer_key_legacy = ${String(customerKey)} LIMIT 1`;
  if (!rows[0]) return null;
  return { ...memberShape(rows[0]), linkedAt: new Date(rows[0].linked_at).toISOString() };
}

async function searchMembers(query) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  const rows = await sqlClient()`SELECT id, line_display_name, picture_url, contact_name, contact_phone, created_at, updated_at FROM customer_members WHERE line_display_name ILIKE ${`%${q}%`} OR contact_name ILIKE ${`%${q}%`} OR contact_phone ILIKE ${`%${q}%`} ORDER BY updated_at DESC LIMIT 10`;
  return rows.map(memberShape);
}

async function linkLegacyCustomer({ actorId, memberId, customerKey }) {
  const sql = sqlClient();
  const [member, customer] = await sql.transaction([
    sql`SELECT id FROM customer_members WHERE id = ${String(memberId)} LIMIT 1`,
    sql`SELECT customer_key_legacy FROM customers WHERE customer_key_legacy = ${String(customerKey)} LIMIT 1`
  ], { readOnly: true });
  if (!member[0] || !customer[0]) throw Object.assign(new Error("member_or_customer_not_found"), { code: "not_found" });
  await sql.transaction([
    sql`INSERT INTO member_legacy_links (member_id, customer_key_legacy, linked_by, linked_at) VALUES (${String(memberId)}::uuid, ${String(customerKey)}, ${String(actorId)}, now()) ON CONFLICT (customer_key_legacy) DO UPDATE SET member_id = EXCLUDED.member_id, linked_by = EXCLUDED.linked_by, linked_at = now()`,
    sql`INSERT INTO audit_log(actor_id, action, entity_type, entity_id, metadata) VALUES (${String(actorId)}, 'link_line_member', 'customer_member_link', ${String(customerKey)}, ${JSON.stringify({ memberId: String(memberId) })}::jsonb)`
  ]);
  return memberLinkInfo(customerKey);
}

async function unlinkLegacyCustomer({ actorId, customerKey }) {
  const sql = sqlClient();
  await sql.transaction([
    sql`DELETE FROM member_legacy_links WHERE customer_key_legacy = ${String(customerKey)}`,
    sql`INSERT INTO audit_log(actor_id, action, entity_type, entity_id, metadata) VALUES (${String(actorId)}, 'unlink_line_member', 'customer_member_link', ${String(customerKey)}, '{}'::jsonb)`
  ]);
}

module.exports = { publicMemberConfig, memberFromIdToken, memberBootstrap, updateMemberProfile, memberLinkInfo, searchMembers, linkLegacyCustomer, unlinkLegacyCustomer, verifyLineIdToken, customerStatus };
