"use strict";

// Booking renderer fragments accept their display dependencies explicitly.
// This keeps the renderer independent from page state and from mutation logic.
(function exposeMorganBookingViews(root) {
  function workbenchIntroHtml({ monthAppointments, pendingSelections, activePanel, nextActionMeta, iconHtml }) {
    const actionableCount = monthAppointments.filter((appointment) => nextActionMeta(appointment).key !== "complete").length;
    const tab = (key, icon, label, count = "") => `<button type="button" class="dispatch-view-tab ${activePanel === key ? "active" : ""}" data-dispatch-view="${key}" aria-selected="${activePanel === key}">${iconHtml(icon)}<span>${label}</span>${count !== "" ? `<b>${count}</b>` : ""}</button>`;
    return `<section class="card dispatch-command-bar booking-workbench-header">
      <div class="dispatch-command-main"><div><span class="ops-section-kicker">預約工作台</span><h2>先完成今天需要處理的預約</h2><p>依下一步處理待辦，再查看時段或完整紀錄。</p></div>
      <nav class="dispatch-view-tabs" aria-label="預約工作區">${tab("tasks", "list-checks", "今日待辦", pendingSelections.length + actionableCount)}${tab("query", "calendar-days", "今日時間表")}${tab("records", "history", "全部預約", monthAppointments.length)}</nav></div>
    </section>`;
  }

  function bookingCardHtml({ appointment, tone = "slate", nextActionMeta, stageClass, stageLabel, customerDisplay, therapistName, courseName, money, esc }) {
    const nextAction = nextActionMeta(appointment);
    const toneClass = { amber: "border-amber-200 bg-amber-50", teal: "border-teal-200 bg-teal-50", violet: "border-violet-200 bg-violet-50", indigo: "border-indigo-200 bg-indigo-50", rose: "border-rose-200 bg-rose-50", slate: "border-slate-200 bg-white" }[tone] || "border-slate-200 bg-white";
    return `<button data-open-appt="${esc(appointment.id)}" class="w-full rounded-xl border ${toneClass} p-3 text-left transition hover:border-teal-400 hover:bg-teal-50">
      <div class="flex items-start justify-between gap-3"><span class="font-mono text-sm font-black">${esc(appointment.date)} ${esc(appointment.time || "--:--")}</span><span class="badge ${stageClass(appointment.bookingStage)}">${esc(stageLabel(appointment.bookingStage))}</span></div>
      <div class="mt-2 font-black text-slate-900">${esc(customerDisplay(appointment.phone, appointment.customerName))}</div>
      <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs font-bold text-slate-500"><span>${esc(therapistName(appointment.therapistId))}</span><span>${esc(courseName(appointment.service))}</span><span>${appointment.room === "OUT" ? "外出" : `${esc(appointment.room || "-")}房`}</span><span>${money(appointment.price)}</span></div>
      <div class="mt-3 rounded-lg bg-white/70 px-3 py-2 text-xs font-black text-slate-700">下一步：${esc(nextAction.label)}</div>
    </button>`;
  }

  function bookingStageBoardHtml({ appointments, nextActionMeta, urgencyValue, renderCard }) {
    const actionable = appointments.map((appointment) => ({ appointment, action: nextActionMeta(appointment) }))
      .filter((item) => item.action.key !== "complete")
      .sort((left, right) => urgencyValue(left.appointment) - urgencyValue(right.appointment));
    const lanes = [
      { key: "match", title: "待媒合／待確認", desc: "完成客選、媒合與顧客確認", tone: "amber", empty: "目前沒有待媒合或待確認預約" },
      { key: "pre_notice", title: "待行前通知", desc: "已確認，下一步通知師傅", tone: "violet", empty: "目前沒有待行前通知預約" },
      { key: "service_report", title: "待服務回報", desc: "通知完成，等待服務結果", tone: "indigo", empty: "目前沒有待服務回報預約" },
      { key: "payment_record", title: "待回款／補紀錄", desc: "服務完成但資料尚未齊全", tone: "rose", empty: "目前沒有待補資料" }
    ].map((lane) => ({ ...lane, items: actionable.filter((item) => item.action.key === lane.key).map((item) => item.appointment) }));
    return `<div class="mb-3 flex flex-col justify-between gap-2 sm:flex-row sm:items-end"><div><span class="ops-section-kicker">下一步工作看板</span><h3 class="mt-1 text-xl font-black">每筆預約只顯示在一個待辦欄</h3></div><span class="badge bg-slate-900 text-white">${actionable.length} 筆待處理</span></div><div id="bookingStageBoard" class="grid scroll-mt-20 gap-4 xl:grid-cols-4">${lanes.map((lane) => `<section class="card p-4"><div class="mb-3 flex items-start justify-between gap-3"><div><h3 class="font-black">${lane.title}</h3><p class="text-xs font-bold text-slate-500">${lane.desc}</p></div><span class="badge bg-slate-100 text-slate-600">${lane.items.length}</span></div><div class="space-y-2">${lane.items.slice(0, 6).map((appointment) => renderCard(appointment, lane.tone)).join("") || `<p class="rounded-xl bg-slate-50 p-4 text-center text-sm font-bold text-slate-400">${lane.empty}</p>`}</div>${lane.items.length > 6 ? `<p class="mt-3 text-center text-xs font-black text-slate-400">另有 ${lane.items.length - 6} 筆，請至全部預約查看</p>` : ""}</section>`).join("")}</div>`;
  }

  function bookingStageRailHtml({ currentStage = "confirmed", workflow, workflowIndex, esc }) {
    const activeIndex = workflowIndex(currentStage);
    return `<section class="appointment-workflow-rail" aria-label="預約操作流程"><span class="appointment-workflow-title">預約操作流程</span><div class="appointment-workflow-steps">${workflow.map((phase, index) => {
      const complete = index < activeIndex;
      const current = index === activeIndex;
      const state = current ? "進行中" : complete ? "已完成" : "尚未開始";
      return `<div class="appointment-workflow-step${current ? " is-current" : complete ? " is-complete" : ""}"${current ? ' aria-current="step"' : ""}><b aria-hidden="true">${complete ? "✓" : current ? "●" : "○"}</b><strong>${esc(phase.label)}</strong><small>${state}</small></div>`;
    }).join("")}</div></section>`;
  }

  const api = { workbenchIntroHtml, bookingCardHtml, bookingStageBoardHtml, bookingStageRailHtml };
  root.MorganBookingViews = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : globalThis));
