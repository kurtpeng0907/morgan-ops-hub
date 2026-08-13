"use strict";

const { sqlClient } = require("./database");
const { hashPin, verifyPin } = require("./pin");

function dateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : new Date().toISOString().slice(0, 10);
}

function sqlDate(value) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value || "").slice(0, 10);
}

function numericString(value) {
  return value === null || value === undefined ? "" : String(value).replace(/\.00$/, "");
}

function appointmentShape(row) {
  return {
    id: String(row.id),
    date: sqlDate(row.date),
    time: String(row.time || "").slice(0, 5),
    therapistId: String(row.therapist_id || ""),
    customerName: String(row.customer_name || ""),
    phone: String(row.customer_key_legacy || ""),
    service: String(row.service || ""),
    duration: Number(row.duration || 60),
    room: String(row.room || "R"),
    price: numericString(row.price),
    collectedPrice: numericString(row.collected_price),
    isCompleted: row.is_completed === true,
    notes: String(row.notes || ""),
    bookingStage: String(row.booking_stage || ""),
    remittanceDue: numericString(row.remittance_due),
    remittancePaid: row.remittance_paid === true,
    remittanceMethod: String(row.remittance_method || "")
  };
}

function serviceRecordShape(row) {
  return {
    id: String(row.appointment_id || row.record_id),
    record_id: String(row.record_id),
    appointment_id: row.appointment_id ? String(row.appointment_id) : "",
    date: sqlDate(row.date),
    therapistId: String(row.therapist_id || ""),
    therapistName: String(row.therapist_name || ""),
    service: String(row.service || ""),
    collectedPrice: numericString(row.collected_price),
    notes: String(row.notes || ""),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : "",
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : "",
    schema_version: "service-record-v2"
  };
}

function safeSystemRecord(row) {
  const result = { name: String(row.name || ""), notes: String(row.notes || ""), records: Array.isArray(row.records) ? row.records : [] };
  if (String(row.key).startsWith("SYS_THERAPIST_PROFILE_")) {
    try {
      const profile = JSON.parse(result.notes || "{}");
      delete profile.pin;
      result.notes = JSON.stringify(profile);
    } catch { result.notes = "{}"; }
  }
  return result;
}

function opaqueCursor(row) {
  return Buffer.from(`${row.date}|${row.id || row.record_id}`, "utf8").toString("base64url");
}

function decodeCursor(value) {
  try {
    const [date, id] = Buffer.from(String(value || ""), "base64url").toString("utf8").split("|");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !id) return null;
    return { date, id };
  } catch { return null; }
}

async function findUser(accountId) {
  const sql = sqlClient();
  const rows = await sql`
    SELECT account_id, display_name, role, pin_hash, active
    FROM users WHERE account_id = ${String(accountId)} LIMIT 1
  `;
  return rows[0] || null;
}

async function bootstrap(identity, requestedDate) {
  const sql = sqlClient();
  const date = dateKey(requestedDate);
  const role = identity.role === "admin" ? "admin" : "therapist";
  const actorId = String(identity.id || identity.sub || "");
  const queries = [
    sql`SELECT therapist_id, display_name FROM therapists WHERE active = true ORDER BY therapist_id`,
    sql`SELECT therapist_id, date, shift FROM schedules
        WHERE date BETWEEN (${date}::date - 7) AND (${date}::date + 7)
          AND (${role} = 'admin' OR therapist_id = ${actorId})
        ORDER BY therapist_id, date`,
    sql`SELECT id, date, time, therapist_id, customer_name, customer_key_legacy, service, duration,
               room, price, collected_price, is_completed, notes, booking_stage,
               remittance_due, remittance_paid, remittance_method
        FROM appointments
        WHERE date = ${date}::date AND (${role} = 'admin' OR therapist_id = ${actorId})
        ORDER BY time, id`,
    sql`SELECT DISTINCT c.id, c.customer_key_legacy, c.name, c.notes
        FROM customers c JOIN appointments a ON a.customer_id = c.id
        WHERE a.date = ${date}::date AND (${role} = 'admin' OR a.therapist_id = ${actorId})
        ORDER BY c.customer_key_legacy`,
    sql`SELECT key, name, notes, records FROM system_records
        WHERE key NOT LIKE 'SYS_ADMIN_%'
          AND key NOT IN ('SYS_ADMIN_LOGIN_LOG', 'SYS_FRONTDESK_LOGIN_LOG')
          AND (
            (${role} = 'admin' AND key LIKE 'SYS_THERAPIST_PROFILE_%')
            OR (${role} = 'therapist' AND key = ${`SYS_THERAPIST_PROFILE_${actorId}`})
            OR (${role} = 'admin' AND key LIKE 'SYS_APPROVAL_%')
            OR key = 'SYS_OPERATIONS_CONFIG'
            OR (key LIKE 'SYS_APPT_META_%' AND substring(key from 15) IN (
              SELECT id FROM appointments WHERE date = ${date}::date AND (${role} = 'admin' OR therapist_id = ${actorId})
            ))
          )`,
    sql`SELECT account_id, display_name FROM users WHERE role = 'admin' AND active = true ORDER BY account_id`
  ];
  const [therapistRows, scheduleRows, appointmentRows, customerRows, systemRows, adminRows] = await sql.transaction(queries, { readOnly: true });

  const therapists = Object.fromEntries(therapistRows
    .filter((row) => role === "admin" || String(row.therapist_id) === actorId)
    .map((row) => [String(row.therapist_id), { name: String(row.display_name), pin: "", pinConfigured: true }]));
  const schedules = {};
  for (const row of scheduleRows) {
    const id = String(row.therapist_id);
    if (!schedules[id]) schedules[id] = {};
    schedules[id][sqlDate(row.date)] = String(row.shift || "");
  }
  const appointments = Object.fromEntries(appointmentRows.map((row) => [String(row.id), appointmentShape(row)]));
  const customers = Object.fromEntries(customerRows.map((row) => [String(row.customer_key_legacy), { name: String(row.name || ""), notes: String(row.notes || ""), records: [] }]));
  for (const row of systemRows) customers[String(row.key)] = safeSystemRecord(row);
  const admins = role === "admin"
    ? Object.fromEntries(adminRows.map((row) => [String(row.account_id), { name: String(row.display_name), pin: "", pinConfigured: true }]))
    : {};
  return {
    data: { therapists, schedules, admins, appointments, customers },
    meta: { partial: true, source: "neon-postgres", date, generatedAt: new Date().toISOString() }
  };
}

async function authenticateAndBootstrap(accountId, pin, requestedDate) {
  const startedAt = Date.now();
  const user = await findUser(accountId);
  if (!user || user.active !== true || !(await verifyPin(user.pin_hash, pin))) {
    return { authenticated: false, sqlMs: Date.now() - startedAt };
  }
  const identity = { id: String(user.account_id), name: String(user.display_name), role: user.role === "admin" ? "admin" : "therapist" };
  const initial = await bootstrap(identity, requestedDate);
  return { authenticated: true, identity, bootstrap: initial.data, meta: initial.meta, sqlMs: Date.now() - startedAt };
}

async function customerRecords(identity, customerKey, cursorValue, limitValue) {
  const sql = sqlClient();
  const limit = Math.max(1, Math.min(100, Number(limitValue || 50)));
  const cursor = decodeCursor(cursorValue);
  const actorId = String(identity.sub || identity.id || "");
  const role = identity.role === "admin" ? "admin" : "therapist";
  const rows = await sql`
    SELECT sr.record_id, sr.appointment_id, sr.date, sr.therapist_id, sr.therapist_name,
           sr.service, sr.collected_price, sr.notes, sr.created_at, sr.updated_at
    FROM service_records sr
    WHERE sr.customer_key_legacy = ${String(customerKey)}
      AND (${role} = 'admin' OR EXISTS (
        SELECT 1 FROM appointments a WHERE a.customer_id = sr.customer_id AND a.therapist_id = ${actorId}
      ))
      AND (${cursor ? cursor.date : null}::date IS NULL OR (sr.date, sr.record_id) < (${cursor ? cursor.date : null}::date, ${cursor ? cursor.id : ""}))
    ORDER BY sr.date DESC, sr.record_id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  return { records: selected.map(serviceRecordShape), nextCursor: hasMore ? opaqueCursor(selected[selected.length - 1]) : null };
}

async function listAppointments(identity, fromValue, toValue, cursorValue, limitValue) {
  const sql = sqlClient();
  const from = dateKey(fromValue);
  const to = dateKey(toValue || fromValue);
  const limit = Math.max(1, Math.min(200, Number(limitValue || 100)));
  const cursor = decodeCursor(cursorValue);
  const role = identity.role === "admin" ? "admin" : "therapist";
  const actorId = String(identity.sub || identity.id || "");
  const rows = await sql`
    SELECT id, date, time, therapist_id, customer_name, customer_key_legacy, service, duration,
           room, price, collected_price, is_completed, notes, booking_stage,
           remittance_due, remittance_paid, remittance_method
    FROM appointments
    WHERE date BETWEEN ${from}::date AND ${to}::date
      AND (${role} = 'admin' OR therapist_id = ${actorId})
      AND (${cursor ? cursor.date : null}::date IS NULL OR (date, id) < (${cursor ? cursor.date : null}::date, ${cursor ? cursor.id : ""}))
    ORDER BY date DESC, id DESC LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  return { appointments: selected.map(appointmentShape), nextCursor: hasMore ? opaqueCursor(selected[selected.length - 1]) : null };
}

async function listSchedules(identity, fromValue, toValue) {
  const sql = sqlClient();
  const from = dateKey(fromValue);
  const to = dateKey(toValue || fromValue);
  const role = identity.role === "admin" ? "admin" : "therapist";
  const actorId = String(identity.sub || identity.id || "");
  const rows = await sql`
    SELECT therapist_id, date, shift FROM schedules
    WHERE date BETWEEN ${from}::date AND ${to}::date
      AND (${role} = 'admin' OR therapist_id = ${actorId})
    ORDER BY therapist_id, date
  `;
  const schedules = {};
  for (const row of rows) (schedules[String(row.therapist_id)] ||= {})[sqlDate(row.date)] = String(row.shift || "");
  return { schedules, from, to };
}

function decodeCustomerCursor(value) {
  try {
    const decoded = Buffer.from(String(value || ""), "base64url").toString("utf8");
    return decoded.startsWith("customer|") ? decoded.slice(9) : "";
  } catch { return ""; }
}

async function listCustomers(identity, cursorValue, limitValue, queryValue) {
  const sql = sqlClient();
  const cursor = decodeCustomerCursor(cursorValue);
  const limit = Math.max(1, Math.min(100, Number(limitValue || 50)));
  const query = String(queryValue || "").trim().slice(0, 80);
  const role = identity.role === "admin" ? "admin" : "therapist";
  const actorId = String(identity.sub || identity.id || "");
  const rows = await sql`
    SELECT c.customer_key_legacy, c.name, c.notes
    FROM customers c
    WHERE c.customer_key_legacy > ${cursor}
      AND (${query} = '' OR c.customer_key_legacy ILIKE ${`%${query}%`} OR c.name ILIKE ${`%${query}%`})
      AND (${role} = 'admin' OR EXISTS (
        SELECT 1 FROM appointments a WHERE a.customer_id = c.id AND a.therapist_id = ${actorId}
      ))
    ORDER BY c.customer_key_legacy LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  return {
    customers: selected.map((row) => ({ customerKey: String(row.customer_key_legacy), name: String(row.name || ""), notes: String(row.notes || "") })),
    nextCursor: hasMore ? Buffer.from(`customer|${selected[selected.length - 1].customer_key_legacy}`, "utf8").toString("base64url") : null
  };
}

async function report(identity, fromValue, toValue) {
  const sql = sqlClient();
  const from = dateKey(fromValue);
  const to = dateKey(toValue || fromValue);
  const role = identity.role === "admin" ? "admin" : "therapist";
  const actorId = String(identity.sub || identity.id || "");
  const [overallRows, rows] = await sql.transaction([
    sql`SELECT count(*)::int AS appointments,
               count(*) FILTER (WHERE is_completed)::int AS completed,
               count(DISTINCT NULLIF(customer_key_legacy, ''))::int AS unique_customers,
               coalesce(sum(price), 0)::text AS booked_revenue,
               coalesce(sum(collected_price), 0)::text AS collected_revenue,
               coalesce(sum(remittance_due), 0)::text AS remittance_due
        FROM appointments
        WHERE date BETWEEN ${from}::date AND ${to}::date
          AND (${role} = 'admin' OR therapist_id = ${actorId})`,
    sql`SELECT therapist_id, count(*)::int AS appointments,
               count(*) FILTER (WHERE is_completed)::int AS completed,
               count(DISTINCT NULLIF(customer_key_legacy, ''))::int AS unique_customers,
               coalesce(sum(price), 0)::text AS booked_revenue,
               coalesce(sum(collected_price), 0)::text AS collected_revenue,
               coalesce(sum(remittance_due), 0)::text AS remittance_due
        FROM appointments
        WHERE date BETWEEN ${from}::date AND ${to}::date
          AND (${role} = 'admin' OR therapist_id = ${actorId})
        GROUP BY therapist_id ORDER BY therapist_id`
  ], { readOnly: true });
  return {
    from,
    to,
    overall: overallRows[0] || { appointments: 0, completed: 0, unique_customers: 0, booked_revenue: "0", collected_revenue: "0", remittance_due: "0" },
    rows: rows.map((row) => ({ ...row, therapistId: String(row.therapist_id), therapist_id: undefined }))
  };
}

async function mutationStatus(identity, mutationId) {
  const sql = sqlClient();
  const rows = await sql`SELECT status, result, actor_id FROM mutations WHERE mutation_id = ${String(mutationId)} LIMIT 1`;
  const row = rows[0];
  if (!row || (identity.role !== "admin" && String(row.actor_id) !== String(identity.sub))) return { found: false };
  return { found: true, status: String(row.status), result: row.result || null };
}

async function protectPins(action, data) {
  const copy = JSON.parse(JSON.stringify(data || {}));
  if (action === "batch" && Array.isArray(copy.actions)) {
    copy.actions = copy.actions
      .map((item, index) => ({ item, index }))
      .sort((a, b) => (a.item?.action === "addAppointment" ? -1 : 0) - (b.item?.action === "addAppointment" ? -1 : 0) || a.index - b.index)
      .map(({ item }) => item);
  }
  const items = action === "batch" ? (Array.isArray(copy.actions) ? copy.actions : []) : [{ action, data: copy }];
  for (const item of items) {
    const name = String(item.action || "");
    if (!["addTherapist", "updatePin", "saveAdmin"].includes(name)) continue;
    const itemData = item.data || {};
    if (itemData.pin) itemData.pinHash = await hashPin(String(itemData.pin));
    delete itemData.pin;
    if (!itemData.pinHash) throw Object.assign(new Error("missing_pin"), { code: "missing_pin" });
  }
  return copy;
}

async function applyMutation(identity, mutationId, action, data) {
  const sql = sqlClient();
  const protectedData = await protectPins(action, data);
  const rows = await sql`
    SELECT apply_morgan_mutation(
      ${String(mutationId)}, ${String(identity.sub)}, ${identity.role === "admin" ? "admin" : "therapist"},
      ${String(action)}, ${JSON.stringify(protectedData)}::jsonb
    ) AS result
  `;
  return rows[0]?.result || null;
}

async function fullData(identity) {
  if (identity.role !== "admin") throw Object.assign(new Error("forbidden"), { code: "forbidden" });
  const sql = sqlClient();
  const [therapistRows, scheduleRows, appointmentRows, customerRows, systemRows, adminRows, serviceRecordRows] = await sql.transaction([
    sql`SELECT therapist_id, display_name FROM therapists WHERE active = true ORDER BY therapist_id`,
    sql`SELECT therapist_id, date, shift FROM schedules ORDER BY therapist_id, date`,
    sql`SELECT id, date, time, therapist_id, customer_name, customer_key_legacy, service, duration, room, price,
               collected_price, is_completed, notes, booking_stage, remittance_due, remittance_paid, remittance_method
        FROM appointments ORDER BY date, time, id`,
    sql`SELECT customer_key_legacy, name, notes FROM customers ORDER BY customer_key_legacy`,
    sql`SELECT key, name, notes, records FROM system_records WHERE key NOT LIKE 'SYS_ADMIN_%' ORDER BY key`,
    sql`SELECT account_id, display_name FROM users WHERE role = 'admin' AND active = true ORDER BY account_id`,
    sql`SELECT record_id, appointment_id, customer_key_legacy, date, therapist_id, therapist_name, service,
               collected_price, notes, created_at, updated_at
        FROM service_records ORDER BY customer_key_legacy, date DESC, record_id`
  ], { readOnly: true });
  const therapists = Object.fromEntries(therapistRows.map((row) => [String(row.therapist_id), { name: String(row.display_name), pin: "", pinConfigured: true }]));
  const schedules = {};
  for (const row of scheduleRows) (schedules[String(row.therapist_id)] ||= {})[sqlDate(row.date)] = String(row.shift || "");
  const appointments = Object.fromEntries(appointmentRows.map((row) => [String(row.id), appointmentShape(row)]));
  const customers = Object.fromEntries(customerRows.map((row) => [String(row.customer_key_legacy), { name: String(row.name || ""), notes: String(row.notes || ""), records: [] }]));
  for (const row of serviceRecordRows) {
    const customerKey = String(row.customer_key_legacy || "");
    if (!customers[customerKey]) customers[customerKey] = { name: "", notes: "", records: [] };
    customers[customerKey].records.push(serviceRecordShape(row));
  }
  for (const row of systemRows) customers[String(row.key)] = safeSystemRecord(row);
  const admins = Object.fromEntries(adminRows.map((row) => [String(row.account_id), { name: String(row.display_name), pin: "", pinConfigured: true }]));
  return { data: { therapists, schedules, admins, appointments, customers }, meta: { partial: false, source: "neon-postgres", generatedAt: new Date().toISOString() } };
}

// This unauthenticated lookup is deliberately limited to one requested
// therapist's shift labels. It never returns appointments or customer data.
async function publicTherapistSchedule(therapistId, fromValue, toValue) {
  const requestedId = String(therapistId || "").trim();
  const from = dateKey(fromValue);
  const to = dateKey(toValue || from);
  const rangeDays = from && to ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) : NaN;
  if (!requestedId || !from || !to || from > to || !Number.isInteger(rangeDays) || rangeDays > 62) {
    throw Object.assign(new Error("invalid_schedule_query"), { code: "validation_error" });
  }
  const sql = sqlClient();
  const therapistRows = await sql`
    SELECT therapist_id, display_name
    FROM therapists
    WHERE active = true
      AND (
        therapist_id = ${requestedId}
        OR regexp_replace(therapist_id, '^0+', '') = regexp_replace(${requestedId}, '^0+', '')
      )
    ORDER BY therapist_id
    LIMIT 2
  `;
  if (therapistRows.length !== 1) {
    throw Object.assign(new Error("therapist_not_found"), { code: "not_found" });
  }
  const therapist = therapistRows[0];
  const scheduleRows = await sql`
    SELECT date, shift
    FROM schedules
    WHERE therapist_id = ${String(therapist.therapist_id)}
      AND date BETWEEN ${from}::date AND ${to}::date
    ORDER BY date
  `;
  return {
    therapist: { id: String(therapist.therapist_id), name: String(therapist.display_name || therapist.therapist_id) },
    schedules: Object.fromEntries(scheduleRows.map((row) => [sqlDate(row.date), String(row.shift || "")])),
    from,
    to
  };
}

function publicTherapistProfile(row, profileRows) {
  let profile = {};
  try { profile = JSON.parse(profileRows[String(row.therapist_id)]?.notes || "{}"); } catch {}
  return {
    name: String(profile.nickname || profile.name || row.display_name || row.therapist_id),
    nickname: String(profile.nickname || profile.name || row.display_name || row.therapist_id),
    photoUrl: String(profile.photoUrl || ""),
    specialties: String(profile.specialties || profile.bio || "").slice(0, 180)
  };
}

// Public data is deliberately a narrow projection. It is never shared with a browser
// until publicSnapshot() filters it to the requested date, course and time.
async function publicBookingData(requestedDate) {
  const sql = sqlClient();
  const date = dateKey(requestedDate);
  const [therapistRows, scheduleRows, appointmentRows, systemRows] = await sql.transaction([
    sql`SELECT therapist_id, display_name FROM therapists WHERE active = true ORDER BY therapist_id`,
    sql`SELECT therapist_id, date, shift FROM schedules WHERE date = ${date}::date ORDER BY therapist_id`,
    sql`SELECT id, date, time, therapist_id, service, duration, room FROM appointments WHERE date = ${date}::date ORDER BY time, id`,
    sql`SELECT key, name, notes, records FROM system_records
        WHERE key = 'SYS_OPERATIONS_CONFIG'
          OR key LIKE 'SYS_THERAPIST_PROFILE_%'
          OR key LIKE 'SYS_CLIENT_SELECTION_PUB-%'`
  ], { readOnly: true });
  const profileRows = Object.fromEntries(systemRows.filter((row) => String(row.key).startsWith("SYS_THERAPIST_PROFILE_")).map((row) => [String(row.key).slice("SYS_THERAPIST_PROFILE_".length), row]));
  const therapists = Object.fromEntries(therapistRows.map((row) => [String(row.therapist_id), publicTherapistProfile(row, profileRows)]));
  const schedules = {};
  for (const row of scheduleRows) (schedules[String(row.therapist_id)] ||= {})[sqlDate(row.date)] = String(row.shift || "");
  const appointments = Object.fromEntries(appointmentRows.map((row) => [String(row.id), { id: String(row.id), date: sqlDate(row.date), time: String(row.time || "").slice(0, 5), therapistId: String(row.therapist_id), service: String(row.service || ""), duration: Number(row.duration || 60), room: String(row.room || "R") }]));
  const customers = Object.fromEntries(systemRows.filter((row) => String(row.key) === "SYS_OPERATIONS_CONFIG" || String(row.key).startsWith("SYS_CLIENT_SELECTION_PUB-")).map((row) => [String(row.key), safeSystemRecord(row)]));
  return { data: { therapists, schedules, appointments, customers }, meta: { source: "neon-postgres", date } };
}

async function submitPublicBooking(selection) {
  const sql = sqlClient();
  const recordKey = `SYS_CLIENT_SELECTION_${String(selection.id)}`;
  // `mutations` is the idempotency authority. A repeat request returns the same
  // verified selection and does not create another demand record.
  const existing = await sql`SELECT status, result FROM mutations WHERE mutation_id = ${String(selection.id)} LIMIT 1`;
  if (existing[0]) {
    if (String(existing[0].status) !== "verified") throw Object.assign(new Error("mutation_incomplete"), { code: "public_booking_unavailable" });
    return { verified: true, selection: existing[0].result?.selection || selection, duplicate: true };
  }
  // A unique system-record key is a lightweight reservation compatible with the
  // legacy metadata store. It serializes concurrent public requests for the
  // same therapist/date/time without exposing an SQL console or changing
  // appointment semantics before the admin confirms it.
  const slotKey = `SYS_PUBLIC_BOOKING_SLOT_${String(selection.date).replace(/-/g, "")}_${String(selection.time).replace(/:/g, "")}_${String(selection.selectedTherapistId)}`;
  const reservation = await sql`
    INSERT INTO system_records(key, name, notes, records, updated_at)
    VALUES (${slotKey}, 'public-booking-slot', ${JSON.stringify({ selectionId: selection.id, status: "pending", date: selection.date, time: selection.time, therapistId: selection.selectedTherapistId })}, '[]'::jsonb, now())
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `;
  if (!reservation[0]) throw Object.assign(new Error("booking_conflict"), { code: "booking_conflict" });
  const result = { selection: { id: selection.id, status: "pending" }, actorType: "customer_public", readBack: "verified" };
  try {
    await sql.transaction([
      sql`INSERT INTO mutations(mutation_id, actor_id, status, result, updated_at)
          VALUES (${String(selection.id)}, 'customer_public', 'pending', ${JSON.stringify({ action: "public_booking_request" })}::jsonb, now())`,
      sql`INSERT INTO system_records(key, name, notes, records, updated_at)
          VALUES (${recordKey}, ${`pending-${selection.customerName || selection.customerContact}-${selection.selectedTherapistName}`}, ${JSON.stringify(selection)}, '[]'::jsonb, now())
          ON CONFLICT (key) DO NOTHING`,
      sql`UPDATE mutations SET status = 'verified', result = ${JSON.stringify(result)}::jsonb, updated_at = now()
          WHERE mutation_id = ${String(selection.id)}`,
      sql`INSERT INTO audit_log(actor_id, action, entity_type, entity_id, mutation_id, metadata)
          VALUES ('customer_public', 'public_booking_request', 'client_selection', ${String(selection.id)}, ${String(selection.id)},
            ${JSON.stringify({ before: "none", after: "pending", date: selection.date, time: selection.time, service: selection.service, therapistId: selection.selectedTherapistId })}::jsonb)`
    ]);
  } catch (error) {
    await sql`DELETE FROM system_records WHERE key = ${slotKey} AND notes::jsonb ->> 'selectionId' = ${String(selection.id)}`;
    throw error;
  }
  const readBack = await sql`SELECT notes FROM system_records WHERE key = ${recordKey} LIMIT 1`;
  let stored = null;
  try { stored = JSON.parse(readBack[0]?.notes || "{}"); } catch {}
  if (stored?.id !== selection.id || stored?.status !== "pending") throw Object.assign(new Error("read_back_mismatch"), { code: "read_back_mismatch" });
  return { verified: true, selection };
}

module.exports = {
  authenticateAndBootstrap, bootstrap, customerRecords, listAppointments, listSchedules, listCustomers, report,
  mutationStatus, applyMutation, fullData, appointmentShape, serviceRecordShape,
  decodeCursor, protectPins, publicBookingData, submitPublicBooking, publicTherapistSchedule
};
