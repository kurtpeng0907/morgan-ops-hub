"use strict";

// Browser-side booking vocabulary. Server-side authorization remains the
// authority; these helpers only keep the UI's labels and local projections
// consistent while a user works through a booking.
(function exposeMorganBooking(root) {
  const BOOKING_STAGES = Object.freeze([
    { key: "inquiry", label: "詢問中", icon: "message-circle-question" },
    { key: "candidate_sent", label: "已給客選", icon: "send" },
    { key: "therapist_match", label: "師傅媒合中", icon: "users" },
    { key: "customer_confirm", label: "待顧客確認", icon: "badge-help" },
    { key: "confirmed", label: "已確認預約", icon: "badge-check" },
    { key: "pre_notice", label: "行前通知完成", icon: "bell-ring" },
    { key: "completed", label: "服務完成", icon: "circle-check-big" }
  ]);

  const BOOKING_WORKFLOW = Object.freeze([
    { key: "create", label: "建立", icon: "calendar-plus", stages: ["inquiry", "candidate_sent", "therapist_match"] },
    { key: "confirm", label: "待確認", icon: "badge-check", stages: ["customer_confirm"] },
    { key: "notice", label: "行前通知", icon: "send", stages: ["confirmed"] },
    { key: "service_report", label: "服務回報", icon: "clipboard-pen-line", stages: ["pre_notice"] },
    { key: "accounting", label: "回帳及紀錄", icon: "wallet-cards", stages: ["completed"] }
  ]);

  const BOOKING_STAGE_NEXT = Object.freeze({
    inquiry: ["candidate_sent"], candidate_sent: ["therapist_match"], therapist_match: ["customer_confirm"],
    customer_confirm: ["confirmed"], confirmed: ["pre_notice"], pre_notice: ["service_report"],
    service_report: ["completed"], completed: [], cancelled: []
  });

  const isKnownBookingStage = (stage = "") => BOOKING_STAGES.some((item) => item.key === stage);
  const normalizeBookingStage = (stage = "", appointment = {}) => {
    const value = String(stage || "").trim();
    if (isKnownBookingStage(value)) return value;
    return String(appointment.isCompleted) === "true" || appointment.isCompleted === true ? "completed" : "confirmed";
  };
  const bookingWorkflowIndex = (stage = "confirmed") => {
    const normalized = normalizeBookingStage(stage);
    const index = BOOKING_WORKFLOW.findIndex((phase) => phase.stages.includes(normalized));
    return index >= 0 ? index : 2;
  };
  const isBookingConfirmed = (appointment = {}) => ["confirmed", "pre_notice", "completed"].includes(appointment.bookingStage) || String(appointment.isCompleted) === "true";
  const isBookingUnconfirmed = (appointment = {}) => !isBookingConfirmed(appointment);
  const bookingNextActionMeta = (appointment = {}, record = {}) => {
    const stage = normalizeBookingStage(appointment.bookingStage, appointment);
    const hasCollectedPrice = String(appointment.collectedPrice || record.collectedPrice || "").trim() !== "";
    const hasRecordNotes = String(record.notes || "").trim() !== "";
    const labels = { inquiry: "整理需求，查時段或給客選", candidate_sent: "等待客人選擇師傅", therapist_match: "確認師傅可接", customer_confirm: "完成顧客確認" };
    if (labels[stage]) return { key: "match", label: labels[stage], tone: "amber", stage };
    if (stage === "confirmed") return { key: "pre_notice", label: "完成行前通知", tone: "violet", stage };
    if (stage === "pre_notice") return { key: "service_report", label: "填寫服務回報", tone: "indigo", stage };
    if (stage === "completed" && !hasCollectedPrice) return { key: "payment_record", label: "補實際回款", tone: "rose", stage };
    if (stage === "completed" && !hasRecordNotes) return { key: "complete", label: "帳務已完成，待補服務紀錄", tone: "teal", stage, reminder: true };
    return { key: "complete", label: "已完成，資料完整", tone: "teal", stage };
  };
  const bookingUrgencyValue = (appointment = {}) => {
    const timestamp = new Date(`${appointment.date || "9999-12-31"}T${appointment.time || "23:59"}:00`).getTime();
    return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
  };
  const buildBookingListModel = ({ appointments = [], monthDateKeys = [], pendingSelections = [], activeDate = "", scope = "today", recordForAppointment = () => ({}) } = {}) => {
    const monthSet = new Set(monthDateKeys);
    const monthAppointments = appointments.filter((appointment) => monthSet.has(appointment.date));
    const dayAppointments = appointments.filter((appointment) => appointment.date === activeDate);
    const visibleAppointments = scope === "month" ? monthAppointments : dayAppointments;
    const visibleConfirmed = visibleAppointments.filter(isBookingConfirmed);
    const visibleUnconfirmed = visibleAppointments.filter(isBookingUnconfirmed);
    const visibleFollowup = visibleAppointments.filter((appointment) => appointment.bookingStage === "pre_notice"
      || (String(appointment.isCompleted) === "true" && (!String(appointment.collectedPrice || "").trim() || !String(recordForAppointment(appointment)?.notes || "").trim())));
    return { monthAppointments, dayAppointments, pendingSelections, visibleAppointments, visibleConfirmed, visibleUnconfirmed, visibleFollowup };
  };
  const buildBookingDetailModel = ({ appointment = {}, record = {}, customer = {}, course = {}, remittanceDue = 0, editMode = false, editSection = "" } = {}) => {
    const endMinutes = (() => {
      const [hours = 0, minutes = 0] = String(appointment.time || "00:00").split(":").map(Number);
      return hours * 60 + minutes + Number(appointment.duration || 60);
    })();
    const endTime = `${String(Math.floor(endMinutes / 60) % 24).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
    return {
      record,
      customer,
      therapistCut: Number(course.therapistCut || 0),
      remittanceDue: Number(remittanceDue || 0),
      endTime,
      roomLabel: appointment.room === "OUT" ? "外出" : `${appointment.room || "R"}房`,
      editScope: editMode ? (editSection || "all") : ""
    };
  };

  const api = { BOOKING_STAGES, BOOKING_WORKFLOW, BOOKING_STAGE_NEXT, isKnownBookingStage, normalizeBookingStage, bookingWorkflowIndex, isBookingConfirmed, isBookingUnconfirmed, bookingNextActionMeta, bookingUrgencyValue, buildBookingListModel, buildBookingDetailModel };
  root.MorganBooking = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : globalThis));
