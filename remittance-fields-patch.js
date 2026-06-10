"use strict";

(function patchRemittanceFields() {
  const originalRenderAppointmentDetail = renderAppointmentDetail;

  const remittanceDueAmount = (appt) => Math.max(0, Number(appt.price || 0) - Number(COURSE_CATALOG[appt.service]?.therapistCut || 0));
  const isRemitted = (appt) => String(appt.remittancePaid) === "true" || Number(appt.collectedPrice || 0) > 0;
  const remittanceMethodOptions = (selected = "") => ["", "現金回帳", "轉帳"]
    .map((method) => `<option value="${esc(method)}" ${selected === method ? "selected" : ""}>${method || "選擇回帳管道"}</option>`)
    .join("");

  function enhanceAppointmentDetailForm() {
    const form = $("appointmentDetailForm");
    const appt = activeAppointmentId ? db.appointments[activeAppointmentId] : null;
    if (!form || !appt) return;

    const due = remittanceDueAmount(appt);
    const paid = isRemitted(appt);
    const currentMethod = appt.remittanceMethod || "";
    const oldCollectedInput = form.elements.collectedPrice;
    const amountContainer = oldCollectedInput?.closest("div");
    if (amountContainer) {
      amountContainer.innerHTML = `<label class="label">應回帳金額</label><input name="remittanceDue" type="number" class="input bg-slate-50" readonly value="${esc(due)}"><p class="mt-2 text-xs font-bold text-slate-500">由課程金額自動扣除師傅抽成，不需手動輸入。</p>`;
    }

    const completeLabel = form.elements.isCompleted?.closest("label");
    if (completeLabel && !form.querySelector("[data-remittance-fields]")) {
      completeLabel.insertAdjacentHTML("beforebegin", `
        <div data-remittance-fields class="grid gap-4 md:col-span-2 md:grid-cols-2">
          <label class="flex items-center gap-3 rounded-xl border p-4 font-black">
            <input name="remittancePaid" type="checkbox" class="h-5 w-5" ${paid ? "checked" : ""}> 已回帳
          </label>
          <div><label class="label">回帳管道</label><select name="remittanceMethod" class="input">${remittanceMethodOptions(currentMethod)}</select></div>
        </div>
      `);
    }

    form.onsubmit = (event) => {
      event.preventDefault();
      saveAppointmentDetailWithRemittance(form);
    };
  }

  function saveAppointmentDetailWithRemittance(form) {
    const old = db.appointments[activeAppointmentId];
    if (!old) return;
    const data = Object.fromEntries(new FormData(form).entries());
    const draft = {
      ...old,
      ...data,
      id: old.id,
      appId: old.id,
      duration: Number(data.duration || 60),
      price: Number(data.price || 0),
      isCompleted: data.isCompleted === "on",
      phone: String(data.phone || "").trim(),
      customerName: String(data.customerName || "").trim(),
      notes: String(data.notes || "").trim()
    };
    const due = remittanceDueAmount(draft);
    const paid = data.remittancePaid === "on";
    draft.remittanceDue = due;
    draft.remittancePaid = paid;
    draft.remittanceMethod = paid ? String(data.remittanceMethod || "").trim() : "";
    draft.collectedPrice = paid ? String(due) : "";

    const err = $("appointmentDetailError");
    if (!draft.date || !draft.time || !draft.phone) {
      err.textContent = "日期、時間與聯絡方式必填；顧客姓名可留空。";
      err.classList.remove("hidden");
      return;
    }
    if (paid && !draft.remittanceMethod) {
      err.textContent = "已回帳時請選擇回帳管道：現金回帳或轉帳。";
      err.classList.remove("hidden");
      return;
    }
    err.classList.add("hidden");

    const commit = () => {
      if (old.phone && old.phone !== draft.phone && db.customers[old.phone]?.records) {
        db.customers[old.phone].records = db.customers[old.phone].records.filter((record) => record.id !== draft.id);
      }
      db.appointments[draft.id] = draft;
      const customer = db.customers[draft.phone] || { name: draft.customerName, notes: "", records: [] };
      customer.name = draft.customerName;
      if (!customer.code) {
        db.customers[draft.phone] = customer;
        assignCustomerCodes(db);
      }
      customer.records ||= [];
      const idx = customer.records.findIndex((record) => record.id === draft.id);
      const record = {
        id: draft.id,
        date: draft.date,
        therapistId: draft.therapistId,
        therapistName: therapistName(draft.therapistId),
        service: draft.service,
        collectedPrice: draft.collectedPrice,
        remittanceDue: draft.remittanceDue,
        remittancePaid: draft.remittancePaid,
        remittanceMethod: draft.remittanceMethod,
        notes: data.recordNotes || ""
      };
      if (idx >= 0) customer.records[idx] = { ...customer.records[idx], ...record };
      else customer.records.push(record);
      db.customers[draft.phone] = customer;
      postCloud("addAppointment", draft);
      postCloud("saveCustomer", { phone: draft.phone, ...customer });
      renderAll();
      activeAppointmentId = draft.id;
      switchTab("appointmentDetail");
      showSnackbar("預約與回帳狀態已更新");
    };

    const conflict = findAppointmentConflict(draft);
    if (conflict) confirmAction("仍要儲存撞期預約？", conflict, commit, "強制儲存");
    else commit();
  }

  renderAppointmentDetail = function patchedRenderAppointmentDetail() {
    originalRenderAppointmentDetail();
    enhanceAppointmentDetailForm();
  };

  openTherapistReport = function patchedOpenTherapistReport(id) {
    const appt = db.appointments[id];
    if (!appt) return;
    const due = remittanceDueAmount(appt);
    const paid = isRemitted(appt);
    const record = findRecord(appt);
    showModal(`<div class="modal max-w-lg"><h3 class="mb-5 border-b pb-4 text-xl font-black">填寫服務紀錄與回帳</h3><form id="therapistReportForm" class="space-y-4"><div class="rounded-xl border bg-slate-50 p-4"><b>${esc(customerDisplay(appt.phone, appt.customerName))}</b><p class="text-sm font-bold text-teal-700">${esc(appt.date)} / ${esc(appt.time)} - ${esc(courseName(appt.service))}</p></div><div class="grid grid-cols-2 gap-3"><div class="metric"><p class="text-xs font-black text-slate-500">應收總額</p><p class="mt-1 text-2xl font-black text-rose-700">${money(appt.price)}</p></div><div class="metric"><p class="text-xs font-black text-slate-500">應回帳金額</p><p class="mt-1 text-2xl font-black text-teal-700">${money(due)}</p></div></div><label class="flex items-center gap-3 rounded-xl border p-3 font-black"><input name="remittancePaid" type="checkbox" class="h-5 w-5" ${paid ? "checked" : ""}> 已回帳</label><div><label class="label">回帳管道</label><select name="remittanceMethod" class="input">${remittanceMethodOptions(appt.remittanceMethod || "")}</select></div><textarea name="notes" class="input min-h-28" placeholder="服務細節與顧客反饋">${esc(record?.notes || "")}</textarea><label class="flex items-center gap-3 rounded-xl border p-3 font-black"><input name="isCompleted" type="checkbox" ${String(appt.isCompleted) === "true" ? "checked" : ""}> 標記為已完成</label><p id="therapistReportError" class="hidden text-sm font-black text-rose-600"></p><div class="flex justify-end gap-3 border-t pt-4"><button type="button" class="btn-light" data-close-modal>取消</button><button class="btn-teal">儲存入檔</button></div></form></div>`);

    $("therapistReportForm").onsubmit = (event) => {
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
      appt.remittanceDue = due;
      appt.remittancePaid = reportPaid;
      appt.remittanceMethod = method;
      appt.collectedPrice = reportPaid ? String(due) : "";
      appt.isCompleted = data.isCompleted === "on";

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
      postCloud("addAppointment", appt);
      postCloud("saveCustomer", { phone: appt.phone, ...customer });
      closeModal();
      renderAll();
      showSnackbar("服務紀錄與回帳狀態已同步");
    };
  };

  if ($("view-appointmentDetail") && !$("view-appointmentDetail").classList.contains("hidden")) {
    renderAppointmentDetail();
  }
})();
