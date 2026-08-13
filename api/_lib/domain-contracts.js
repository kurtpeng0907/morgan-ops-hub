"use strict";

const BOOKING_STAGES = Object.freeze([
  "inquiry", "candidate_sent", "therapist_match", "customer_confirm",
  "confirmed", "pre_notice", "service_report", "completed", "cancelled"
]);

const BOOKING_TRANSITIONS = Object.freeze({
  inquiry: ["candidate_sent", "cancelled"],
  candidate_sent: ["therapist_match", "cancelled"],
  therapist_match: ["customer_confirm", "cancelled"],
  customer_confirm: ["confirmed", "cancelled"],
  confirmed: ["pre_notice", "cancelled"],
  pre_notice: ["service_report", "cancelled"],
  service_report: ["completed", "cancelled"],
  completed: [],
  cancelled: []
});

const BOOKING_STAGE_ROLES = Object.freeze({
  inquiry: ["admin"], candidate_sent: ["admin"], therapist_match: ["admin"],
  customer_confirm: ["admin"], confirmed: ["admin"], pre_notice: ["admin"],
  service_report: ["admin", "therapist"], completed: ["admin", "therapist"],
  cancelled: ["admin"]
});

function isBookingStage(value) { return BOOKING_STAGES.includes(String(value || "")); }

function canTransition(from, to) {
  const source = String(from || "inquiry");
  return isBookingStage(source) && isBookingStage(to) && BOOKING_TRANSITIONS[source].includes(to);
}

function allowedRolesForStage(stage) { return BOOKING_STAGE_ROLES[String(stage || "")] || []; }

function assertBookingTransition({ from, to, role }) {
  if (!canTransition(from, to)) {
    const error = new Error(`invalid_booking_transition:${String(from || "inquiry")}->${String(to || "")}`);
    error.code = "invalid_booking_transition";
    throw error;
  }
  if (!allowedRolesForStage(to).includes(String(role || ""))) {
    const error = new Error(`booking_transition_forbidden:${String(role || "")}->${to}`);
    error.code = "forbidden";
    throw error;
  }
  return true;
}

module.exports = { BOOKING_STAGES, BOOKING_TRANSITIONS, BOOKING_STAGE_ROLES, isBookingStage, canTransition, allowedRolesForStage, assertBookingTransition };
