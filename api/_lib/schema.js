"use strict";

const {
  pgTable, text, boolean, timestamp, date, time, integer, numeric, uuid,
  jsonb, bigserial, index, uniqueIndex, primaryKey
} = require("drizzle-orm/pg-core");

const users = pgTable("users", {
  accountId: text("account_id").primaryKey(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(),
  pinHash: text("pin_hash").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

const therapists = pgTable("therapists", {
  therapistId: text("therapist_id").primaryKey().references(() => users.accountId),
  displayName: text("display_name").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

const schedules = pgTable("schedules", {
  therapistId: text("therapist_id").notNull().references(() => therapists.therapistId),
  date: date("date", { mode: "string" }).notNull(),
  shift: text("shift").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [primaryKey({ columns: [table.therapistId, table.date] })]);

const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerKeyLegacy: text("customer_key_legacy").notNull(),
  name: text("name").notNull().default(""),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [uniqueIndex("customers_legacy_key_uidx").on(table.customerKeyLegacy)]);

const appointments = pgTable("appointments", {
  id: text("id").primaryKey(),
  date: date("date", { mode: "string" }).notNull(),
  time: time("time", { withTimezone: false }).notNull(),
  therapistId: text("therapist_id").notNull().references(() => therapists.therapistId),
  customerId: uuid("customer_id").references(() => customers.id),
  customerKeyLegacy: text("customer_key_legacy").notNull().default(""),
  customerName: text("customer_name").notNull().default(""),
  service: text("service").notNull().default(""),
  duration: integer("duration").notNull().default(60),
  room: text("room").notNull().default("R"),
  price: numeric("price", { precision: 12, scale: 2 }),
  collectedPrice: numeric("collected_price", { precision: 12, scale: 2 }),
  isCompleted: boolean("is_completed").notNull().default(false),
  notes: text("notes").notNull().default(""),
  bookingStage: text("booking_stage").notNull().default(""),
  remittanceDue: numeric("remittance_due", { precision: 12, scale: 2 }),
  remittancePaid: boolean("remittance_paid").notNull().default(false),
  remittanceMethod: text("remittance_method").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  index("appointments_date_time_idx").on(table.date, table.time),
  index("appointments_therapist_date_idx").on(table.therapistId, table.date),
  index("appointments_customer_date_idx").on(table.customerId, table.date)
]);

const serviceRecords = pgTable("service_records", {
  recordId: text("record_id").primaryKey(),
  appointmentId: text("appointment_id").references(() => appointments.id),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  customerKeyLegacy: text("customer_key_legacy").notNull(),
  date: date("date", { mode: "string" }).notNull(),
  therapistId: text("therapist_id").references(() => therapists.therapistId),
  therapistName: text("therapist_name").notNull().default(""),
  service: text("service").notNull().default(""),
  collectedPrice: numeric("collected_price", { precision: 12, scale: 2 }),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  schemaVersion: text("schema_version").notNull().default("service-record-v2")
}, (table) => [
  uniqueIndex("service_records_appointment_uidx").on(table.appointmentId),
  index("service_records_customer_date_idx").on(table.customerId, table.date),
  index("service_records_therapist_date_idx").on(table.therapistId, table.date)
]);

const mutations = pgTable("mutations", {
  mutationId: text("mutation_id").primaryKey(),
  actorId: text("actor_id").notNull(),
  status: text("status").notNull(),
  result: jsonb("result").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

const systemRecords = pgTable("system_records", {
  key: text("key").primaryKey(),
  name: text("name").notNull().default(""),
  notes: text("notes").notNull().default(""),
  records: jsonb("records").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull().default(""),
  mutationId: text("mutation_id"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [index("audit_log_created_at_idx").on(table.createdAt)]);

module.exports = { users, therapists, schedules, customers, appointments, serviceRecords, mutations, systemRecords, auditLog };
