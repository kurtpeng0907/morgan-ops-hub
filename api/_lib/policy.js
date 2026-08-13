"use strict";

const { BOOKING_STAGE_ROLES } = require("./domain-contracts");

const ROLE_ACTIONS = Object.freeze({
  admin: new Set(["batch", "saveSchedule", "addTherapist", "updatePin", "deleteTherapist", "addAppointment", "deleteAppointment", "saveCustomer", "deleteCustomer", "repairTherapists", "sendEmailNotification", "saveAdmin", "saveServiceRecord", "backfillServiceRecords"]),
  therapist: new Set(["batch", "saveSchedule", "addAppointment", "saveCustomer", "saveServiceRecord"])
});

function isActionAllowed(role, action) { return Boolean(ROLE_ACTIONS[String(role || "")]?.has(String(action || ""))); }

function assertActionAllowed(role, action) {
  if (!isActionAllowed(role, action)) {
    const error = new Error(`forbidden_action:${String(action || "")}`);
    error.code = "forbidden";
    throw error;
  }
}

function canManageBookingStage(role, stage) { return BOOKING_STAGE_ROLES[String(stage || "")]?.includes(String(role || "")) === true; }

module.exports = { ROLE_ACTIONS, isActionAllowed, assertActionAllowed, canManageBookingStage };
