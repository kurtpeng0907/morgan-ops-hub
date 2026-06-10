"use strict";

(function patchFinanceAccounting() {
  const paidAmount = (appt) => Number(appt.collectedPrice || 0);
  const grossAmount = (appt) => Number(appt.price || 0);
  const outstandingAmount = (appt) => Math.max(0, grossAmount(appt) - paidAmount(appt));
  const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

  const reportRows = (start, end) => Object.values(db.appointments)
    .filter((appt) => appt.date >= start && appt.date <= end)
    .sort((a, b) => a.date === b.date ? sortByTime(a, b) : a.date.localeCompare(b.date));

  const reportTab = (panel, label) => `<button class="rounded-lg px-4 py-2 text-sm font-black ${activeReportPanel === panel ? "bg-white text-amber-700 shadow" : "text-slate-500"}" data-report-panel="${panel}">${label}</button>`;

  const revenueTableHtml = (rows) => `<div class="table-wrap"><table><thead><tr><th>預約日期時間</th><th>顧客</th><th>師傅</th><th>服務</th><th class="text-right">應收總額</th><th class="text-right">店家應收金額</th><th class="text-right">未回帳金額</th></tr></thead><tbody>${rows.length ? rows.map((appt) => `<tr><td><button data-open-appt="${esc(appt.id)}" class="font-mono font-black text-teal-700 hover:text-teal-900">${esc(appt.date)} ${esc(appt.time)}</button></td><td><button data-open-appt="${esc(appt.id)}" class="font-black hover:text-teal-700">${esc(customerDisplay(appt.phone, appt.customerName))}</button></td><td>${esc(therapistName(appt.therapistId))}</td><td>${esc(courseName(appt.service))}</td><td class="text-right font-black text-rose-600">${money(grossAmount(appt))}</td><td class="text-right font-black text-emerald-700">${money(paidAmount(appt))}</td><td class="text-right font-black text-amber-700">${money(outstandingAmount(appt))}</td></tr>`).join("") : `<tr><td colspan="7" class="py-10 text-center font-bold text-slate-400">該區間無預約</td></tr>`}</tbody></table></div>`;

  const guestTableHtml = (rows) => {
    const allApptsByPhone = {};
    Object.values(db.appointments).sort((a, b) => a.date === b.date ? sortByTime(a, b) : a.date.localeCompare(b.date)).forEach((appt) => {
      if (!appt.phone) return;
      allApptsByPhone[appt.phone] ||= [];
      allApptsByPhone[appt.phone].push(appt);
    });
    const byDate = {};
    rows.forEach((appt) => {
      byDate[appt.date] ||= { count: 0, phones: new Set(), newGuests: 0, returningGuests: 0, total: 0 };
      const bucket = byDate[appt.date];
      bucket.count += 1;
      bucket.total += grossAmount(appt);
      if (appt.phone) {
        bucket.phones.add(appt.phone);
        const first = allApptsByPhone[appt.phone]?.[0];
        if (first?.id === appt.id) bucket.newGuests += 1;
        else bucket.returningGuests += 1;
      }
    });
    return `<div class="table-wrap"><table><thead><tr><th>日期</th><th class="text-right">來客數</th><th class="text-right">不重複顧客</th><th class="text-right">新客</th><th class="text-right">回客</th><th class="text-right">應收總額</th></tr></thead><tbody>${Object.entries(byDate).length ? Object.entries(byDate).map(([date, bucket]) => `<tr><td class="font-mono font-black">${esc(date)}</td><td class="text-right font-black">${bucket.count}</td><td class="text-right font-black">${bucket.phones.size}</td><td class="text-right font-black text-emerald-700">${bucket.newGuests}</td><td class="text-right font-black text-amber-700">${bucket.returningGuests}</td><td class="text-right font-black text-rose-700">${money(bucket.total)}</td></tr>`).join("") : `<tr><td colspan="6" class="py-10 text-center font-bold text-slate-400">該區間無來客資料</td></tr>`}</tbody></table></div>`;
  };

  const retentionTableHtml = (rows) => {
    const stats = Object.keys(db.therapists).map((id) => {
      const mine = rows.filter((appt) => appt.therapistId === id);
      const phoneCounts = {};
      mine.forEach((appt) => { if (appt.phone) phoneCounts[appt.phone] = (phoneCounts[appt.phone] || 0) + 1; });
      const unique = Object.keys(phoneCounts).length;
      const returnGuests = Object.values(phoneCounts).filter((count) => count > 1).length;
      return { id, count: mine.length, unique, returnGuests, rate: unique ? Math.round((returnGuests / unique) * 100) : 0, total: mine.reduce((sum, appt) => sum + grossAmount(appt), 0) };
    }).filter((row) => row.count > 0).sort((a, b) => b.rate - a.rate || b.count - a.count);
    return `<div class="table-wrap"><table><thead><tr><th>師傅</th><th class="text-right">服務筆數</th><th class="text-right">不重複顧客</th><th class="text-right">回客人數</th><th class="text-right">回客率</th><th class="text-right">應收總額</th></tr></thead><tbody>${stats.length ? stats.map((stat) => `<tr><td class="font-black text-teal-700">${esc(therapistName(stat.id))}</td><td class="text-right font-black">${stat.count}</td><td class="text-right font-black">${stat.unique}</td><td class="text-right font-black text-amber-700">${stat.returnGuests}</td><td class="text-right font-black text-indigo-700">${stat.rate}%</td><td class="text-right font-black text-rose-700">${money(stat.total)}</td></tr>`).join("") : `<tr><td colspan="6" class="py-10 text-center font-bold text-slate-400">該區間無師傅統計</td></tr>`}</tbody></table></div>`;
  };

  const commissionTableHtml = (rows) => {
    const stats = Object.keys(db.therapists).map((id) => {
      const mine = rows.filter((appt) => appt.therapistId === id);
      const gross = mine.reduce((sum, appt) => sum + grossAmount(appt), 0);
      const paid = mine.reduce((sum, appt) => sum + paidAmount(appt), 0);
      return { id, count: mine.length, gross, paid, outstanding: Math.max(0, gross - paid) };
    }).filter((row) => row.count > 0).sort((a, b) => b.gross - a.gross);
    return `<div class="table-wrap"><table><thead><tr><th>師傅</th><th class="text-right">服務筆數</th><th class="text-right">應收總額</th><th class="text-right">店家應收金額</th><th class="text-right">未回帳金額</th></tr></thead><tbody>${stats.length ? stats.map((stat) => `<tr><td class="font-black text-teal-700">${esc(therapistName(stat.id))}</td><td class="text-right font-black">${stat.count}</td><td class="text-right font-black text-rose-700">${money(stat.gross)}</td><td class="text-right font-black text-emerald-700">${money(stat.paid)}</td><td class="text-right font-black text-amber-700">${money(stat.outstanding)}</td></tr>`).join("") : `<tr><td colspan="5" class="py-10 text-center font-bold text-slate-400">該區間無回帳資料</td></tr>`}</tbody></table></div>`;
  };

  renderReport = function renderReport() {
    const start = $("reportStartDate")?.value || todayKey();
    const end = $("reportEndDate")?.value || todayKey();
    const rows = reportRows(start, end);
    const total = rows.reduce((sum, appt) => sum + grossAmount(appt), 0);
    const collected = rows.reduce((sum, appt) => sum + paidAmount(appt), 0);
    const outstanding = Math.max(0, total - collected);
    const panelContent = {
      revenue: revenueTableHtml(rows),
      guests: guestTableHtml(rows),
      retention: retentionTableHtml(rows),
      commission: commissionTableHtml(rows)
    }[activeReportPanel] || revenueTableHtml(rows);

    $("view-report").innerHTML = `
      <div class="card p-5">
        <div class="mb-5 flex flex-col justify-between gap-4 xl:flex-row xl:items-center">
          <div><h3 class="text-lg font-black">財務報表</h3><p class="text-sm font-bold text-slate-500">應收總額為師傅向客人收款；店家應收金額為實際回帳。</p></div>
          <div class="flex flex-col gap-2 sm:flex-row"><input id="reportStartDate" type="date" class="input py-2" value="${start}"><input id="reportEndDate" type="date" class="input py-2" value="${end}"><button id="queryReportBtn" class="btn-primary px-5 py-3">查詢</button><button id="exportReportBtn" class="btn-teal">輸出報表</button></div>
        </div>
        <div class="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">${metric("來客數", rows.length)}${metric("應收總額", money(total), "text-rose-700")}${metric("店家應收金額", money(collected), "text-emerald-700")}${metric("未回帳金額", money(outstanding), "text-amber-700")}</div>
        <div class="mb-5 flex flex-wrap rounded-xl bg-slate-100 p-1">${reportTab("revenue", "營收明細")}${reportTab("guests", "來客數")}${reportTab("retention", "師傅回客率")}${reportTab("commission", "回帳總表")}</div>
        ${panelContent}
      </div>`;
    $("queryReportBtn").onclick = renderReport;
    $("exportReportBtn").onclick = exportReportCSV;
    $("view-report").querySelectorAll("[data-report-panel]").forEach((btn) => btn.onclick = () => {
      activeReportPanel = btn.dataset.reportPanel;
      renderReport();
    });
    $("view-report").querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
  };

  exportReportCSV = function exportReportCSV() {
    const start = $("reportStartDate").value;
    const end = $("reportEndDate").value;
    const rows = reportRows(start, end);
    let csv = "\uFEFF";
    if (activeReportPanel === "commission") {
      csv += "師傅,服務筆數,應收總額,店家應收金額,未回帳金額\n";
      Object.keys(db.therapists).forEach((id) => {
        const mine = rows.filter((appt) => appt.therapistId === id);
        if (!mine.length) return;
        const gross = mine.reduce((sum, appt) => sum + grossAmount(appt), 0);
        const paid = mine.reduce((sum, appt) => sum + paidAmount(appt), 0);
        csv += [therapistName(id), mine.length, gross, paid, Math.max(0, gross - paid)].map(csvCell).join(",") + "\n";
      });
    } else if (activeReportPanel === "retention") {
      csv += "師傅,服務筆數,不重複顧客,回客人數,回客率,應收總額\n";
      Object.keys(db.therapists).forEach((id) => {
        const mine = rows.filter((appt) => appt.therapistId === id);
        if (!mine.length) return;
        const phoneCounts = {};
        mine.forEach((appt) => { if (appt.phone) phoneCounts[appt.phone] = (phoneCounts[appt.phone] || 0) + 1; });
        const unique = Object.keys(phoneCounts).length;
        const returnGuests = Object.values(phoneCounts).filter((count) => count > 1).length;
        csv += [therapistName(id), mine.length, unique, returnGuests, `${unique ? Math.round((returnGuests / unique) * 100) : 0}%`, mine.reduce((sum, appt) => sum + grossAmount(appt), 0)].map(csvCell).join(",") + "\n";
      });
    } else if (activeReportPanel === "guests") {
      csv += "日期,來客數,不重複顧客,應收總額\n";
      const byDate = {};
      rows.forEach((appt) => {
        byDate[appt.date] ||= { count: 0, phones: new Set(), total: 0 };
        byDate[appt.date].count += 1;
        byDate[appt.date].total += grossAmount(appt);
        if (appt.phone) byDate[appt.date].phones.add(appt.phone);
      });
      Object.entries(byDate).forEach(([date, bucket]) => csv += [date, bucket.count, bucket.phones.size, bucket.total].map(csvCell).join(",") + "\n");
    } else {
      csv += "日期,時間,顧客編碼,顧客姓名,聯絡方式,負責師傅,服務項目,應收總額,店家應收金額,未回帳金額\n";
      rows.forEach((appt) => {
        csv += [appt.date, appt.time, customerCode(appt.phone), appt.customerName || db.customers[appt.phone]?.name || "", appt.phone, therapistName(appt.therapistId), courseName(appt.service), grossAmount(appt), paidAmount(appt), outstandingAmount(appt)].map(csvCell).join(",") + "\n";
      });
    }
    downloadCSV(csv, `報表_${activeReportPanel}_${start}_至_${end}.csv`);
  };

  if ($("view-report") && !$("view-report").classList.contains("hidden")) renderReport();
})();
