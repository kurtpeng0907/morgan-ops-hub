"use strict";

(function patchRemittanceFields() {
  if (typeof renderAppointmentDetail !== "function") return;

  const remittanceDueAmount = (appt) => remittanceDueFor(appt);
  const isRemitted = (appt) => isRemittancePaid(appt);
  const remittanceMethodOptions = (selected = "") => ["", "現金回帳", "轉帳"]
    .map((method) => `<option value="${esc(method)}" ${selected === method ? "selected" : ""}>${method || "選擇回帳管道"}</option>`)
    .join("");

  const serviceRecordAction = (appt, record = {}) => {
    const phone = String(appt?.phone || "").trim();
    const id = String(appt?.id || appt?.appId || record?.id || "").trim();
    if (!phone || !id) return null;
    return {
      action: "saveServiceRecord",
      data: {
        recordId: String(record?.record_id || record?.recordId || id),
        appointmentId: id,
        customer_key_legacy: phone,
        customerName: String(appt?.customerName || ""),
        date: String(record?.date || appt?.date || ""),
        therapistId: String(record?.therapistId || appt?.therapistId || ""),
        therapistName: String(record?.therapistName || therapistName(appt?.therapistId) || ""),
        service: String(record?.service || appt?.service || ""),
        collectedPrice: String(record?.collectedPrice ?? appt?.collectedPrice ?? ""),
        notes: String(record?.notes || "")
      }
    };
  };

  if (typeof saveCloudActions === "function" && !saveCloudActions.__remittanceRecordPersistencePatched) {
    const originalSaveCloudActions = saveCloudActions;
    const patchedSaveCloudActions = async (actions, successMessage = "已儲存到雲端", options = {}) => {
      const enriched = (actions || []).filter(Boolean).map((item) => ({ ...item, data: item?.data ? { ...item.data } : item?.data }));
      const appointmentActions = enriched.filter((item) => item.action === "addAppointment" && item.data);

      appointmentActions.forEach((item) => {
        const appt = item.data;
        const due = Math.max(0, Number(appt.remittanceDue || 0) || 0);
        const collected = Math.max(0, Number(appt.collectedPrice || 0) || 0);
        if (collected > 0) appt.remittancePaid = due > 0 ? collected >= due : true;
        else if (!String(appt.remittanceMethod || "").trim()) appt.remittancePaid = false;

        const id = String(appt.id || appt.appId || "");
        const phone = String(appt.phone || "");
        if (!id || !phone) return;
        const customerAction = enriched.find((candidate) => candidate.action === "saveCustomer" && String(candidate.data?.phone || "") === phone);
        const matchingRecord = Array.isArray(customerAction?.data?.records)
          ? customerAction.data.records.find((record) => String(record?.id || record?.appointmentId || "") === id)
          : null;
        if (!matchingRecord) return;
        const exists = enriched.some((candidate) => candidate.action === "saveServiceRecord" && String(candidate.data?.appointmentId || candidate.data?.appointment_id || candidate.data?.id || "") === id);
        if (!exists) enriched.push(serviceRecordAction(appt, matchingRecord));
      });

      return originalSaveCloudActions(enriched.filter(Boolean), successMessage, options);
    };
    patchedSaveCloudActions.__remittanceRecordPersistencePatched = true;
    saveCloudActions = patchedSaveCloudActions;
  }

  openTherapistReport = function patchedOpenTherapistReport(id) {
    const appt = db.appointments[id];
    if (!appt) return;
    const due = remittanceDueAmount(appt);
    const paid = isRemitted(appt);
    const record = findRecord(appt);
    showModal(`<div class="modal max-w-lg"><h3 class="mb-5 border-b pb-4 text-xl font-black">填寫服務紀錄與回帳</h3><form id="therapistReportForm" class="space-y-4"><div class="rounded-xl border bg-slate-50 p-4"><b>${esc(customerDisplay(appt.phone, appt.customerName))}</b><p class="text-sm font-bold text-teal-700">${esc(appt.date)} / ${esc(appt.time)} - ${esc(courseName(appt.service))}</p></div><div class="grid grid-cols-2 gap-3"><div class="metric"><p class="text-xs font-black text-slate-500">應收總額</p><p class="mt-1 text-2xl font-black text-rose-700">${money(appt.price)}</p></div><div><label class="label">應回帳金額</label><input name="remittanceDue" type="number" min="0" step="1" class="input" value="${esc(due)}"><p class="mt-2 text-xs font-bold text-slate-500">自動帶入，可手動調整。</p></div></div><label class="flex items-center gap-3 rounded-xl border p-3 font-black"><input name="remittancePaid" type="checkbox" class="h-5 w-5" ${paid ? "checked" : ""}> 已回帳</label><div><label class="label">回帳管道</label><select name="remittanceMethod" class="input">${remittanceMethodOptions(appt.remittanceMethod || record?.remittanceMethod || "")}</select></div><textarea name="notes" class="input min-h-28" placeholder="服務細節與顧客反饋">${esc(record?.notes || "")}</textarea><label class="flex items-center gap-3 rounded-xl border p-3 font-black"><input name="isCompleted" type="checkbox" ${String(appt.isCompleted) === "true" ? "checked" : ""}> 標記為已完成</label><p id="therapistReportError" class="hidden text-sm font-black text-rose-600"></p><div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">儲存入檔</button></div></form></div>`);

    $("therapistReportForm").onsubmit = async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget).entries());
      const reportPaid = data.remittancePaid === "on";
      const method = reportPaid ? String(data.remittanceMethod || "").trim() : "";
      const err = $("therapistReportError");
      if (reportPaid && !method) {
        err.textContent = "已回帳時請選擇回帳管道。";
        err.classList.remove("hidden");
        return;
      }
      err.classList.add("hidden");
      const snapshot = snapshotDatabase();
      setFormBusy(event.currentTarget, true);
      const reportDueInput = String(data.remittanceDue ?? "").trim();
      const reportDue = Math.max(0, Number(reportDueInput === "" ? companyCutFor(appt) : reportDueInput) || 0);
      appt.remittanceDue = String(reportDue);
      appt.remittancePaid = reportPaid;
      appt.remittanceMethod = method;
      appt.collectedPrice = reportPaid ? String(reportDue) : "";
      appt.isCompleted = data.isCompleted === "on";
      appt.bookingStage = appt.isCompleted ? "completed" : (appt.bookingStage === "completed" ? "pre_notice" : normalizeBookingStage(appt.bookingStage, appt));

      const customer = db.customers[appt.phone] || { name: appt.customerName || "", notes: "", records: [] };
      if (!customer.code) {
        db.customers[appt.phone] = customer;
        assignCustomerCodes(db);
      }
      customer.records ||= [];
      const idx = customer.records.findIndex((item) => item.id === appt.id);
      const nextRecord = {
        id: appt.id,
        date: appt.date,
        therapistId: appt.therapistId,
        therapistName: therapistName(appt.therapistId),
        service: appt.service,
        collectedPrice: appt.collectedPrice,
        remittanceDue: appt.remittanceDue,
        remittancePaid: appt.remittancePaid,
        remittanceMethod: appt.remittanceMethod,
        notes: data.notes || ""
      };
      if (idx >= 0) customer.records[idx] = { ...customer.records[idx], ...nextRecord };
      else customer.records.push(nextRecord);
      db.customers[appt.phone] = customer;
      const saved = await saveCloudActions([
        { action: "addAppointment", data: appt },
        { action: "saveCustomer", data: { phone: appt.phone, ...customer } },
        syncAppointmentMeta(appt)
      ].filter(Boolean), "服務紀錄與回帳狀態已寫入雲端");
      setFormBusy(event.currentTarget, false);
      if (!saved) {
        restoreDatabase(snapshot, "服務紀錄與回帳未獲雲端確認，已還原");
        return;
      }
      closeModal();
      renderAll();
    };
  };

  if ($("view-dispatch") || $("appointmentDataPanel") || ($("view-appointmentDetail") && !$("view-appointmentDetail").classList.contains("hidden"))) {
    renderAppointmentDetail();
  }
})();
