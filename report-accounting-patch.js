"use strict";

(function patchFinanceAccounting() {
  const grossAmount = (appt) => Number(appt.price || 0);
  const remittanceDueAmount = (appt) => remittanceDueFor(appt);
  const isRemitted = (appt) => isRemittancePaid(appt);
  const remittedAmount = (appt) => isRemitted(appt) ? remittanceDueAmount(appt) : 0;
  const unremittedAmount = (appt) => isRemitted(appt) ? 0 : remittanceDueAmount(appt);
  const remittanceMethod = (appt) => isRemitted(appt) ? (appt.remittanceMethod || "未記錄") : "未回帳";
  const paidBadge = (appt) => isRemitted(appt)
    ? `<span class="badge bg-emerald-50 text-emerald-700">已回帳</span>`
    : `<span class="badge bg-amber-50 text-amber-700">未回帳</span>`;
  const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

  const reportRows = (start, end) => Object.values(db.appointments)
    .filter((appt) => appt.date >= start && appt.date <= end)
    .sort((a, b) => a.date === b.date ? sortByTime(a, b) : a.date.localeCompare(b.date));

  const reportTabs = {
    revenue: { label: "營收明細", icon: "receipt-text" },
    guests: { label: "每日來客", icon: "users" },
    retention: { label: "回客分析", icon: "repeat-2" },
    commission: { label: "回帳總表", icon: "wallet-cards" }
  };
  const reportTab = (panel) => `<button class="workspace-tab ${activeReportPanel === panel ? "active" : ""}" data-report-panel="${panel}">${iconHtml(reportTabs[panel].icon)}<span>${reportTabs[panel].label}</span></button>`;

  const revenueTableHtml = (rows) => `<div class="table-wrap"><table><thead><tr><th>預約日期時間</th><th>顧客</th><th>師傅</th><th>服務</th><th class="text-right">應收總額</th><th class="text-right">應回帳金額</th><th>已回帳</th><th>回帳管道</th></tr></thead><tbody>${rows.length ? rows.map((appt) => `<tr><td><button data-open-appt="${esc(appt.id)}" class="font-mono font-black text-teal-700 hover:text-teal-900">${esc(appt.date)} ${esc(appt.time)}</button></td><td><button data-open-appt="${esc(appt.id)}" class="font-black hover:text-teal-700">${esc(customerDisplay(appt.phone, appt.customerName))}</button></td><td>${esc(therapistName(appt.therapistId))}</td><td>${esc(courseName(appt.service))}</td><td class="text-right font-black text-rose-600">${money(grossAmount(appt))}</td><td class="text-right font-black text-teal-700">${money(remittanceDueAmount(appt))}</td><td>${paidBadge(appt)}</td><td class="font-bold text-slate-600">${esc(remittanceMethod(appt))}</td></tr>`).join("") : `<tr><td colspan="8" class="py-10 text-center font-bold text-slate-400">該區間無預約</td></tr>`}</tbody></table></div>`;

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

  const remittanceTableHtml = (rows) => {
    const stats = Object.keys(db.therapists).map((id) => {
      const mine = rows.filter((appt) => appt.therapistId === id);
      const gross = mine.reduce((sum, appt) => sum + grossAmount(appt), 0);
      const due = mine.reduce((sum, appt) => sum + remittanceDueAmount(appt), 0);
      const remitted = mine.reduce((sum, appt) => sum + remittedAmount(appt), 0);
      const unremitted = mine.reduce((sum, appt) => sum + unremittedAmount(appt), 0);
      return { id, count: mine.length, gross, due, remitted, unremitted };
    }).filter((row) => row.count > 0).sort((a, b) => b.gross - a.gross);
    return `<div class="table-wrap"><table><thead><tr><th>師傅</th><th class="text-right">服務筆數</th><th class="text-right">應收總額</th><th class="text-right">應回帳金額</th><th class="text-right">已回帳金額</th><th class="text-right">未回帳金額</th></tr></thead><tbody>${stats.length ? stats.map((stat) => `<tr><td class="font-black text-teal-700">${esc(therapistName(stat.id))}</td><td class="text-right font-black">${stat.count}</td><td class="text-right font-black text-rose-700">${money(stat.gross)}</td><td class="text-right font-black text-teal-700">${money(stat.due)}</td><td class="text-right font-black text-emerald-700">${money(stat.remitted)}</td><td class="text-right font-black text-amber-700">${money(stat.unremitted)}</td></tr>`).join("") : `<tr><td colspan="6" class="py-10 text-center font-bold text-slate-400">該區間無回帳資料</td></tr>`}</tbody></table></div>`;
  };

  renderReport = function renderReport() {
    const start = $("reportStartDate")?.value || todayKey();
    const end = $("reportEndDate")?.value || todayKey();
    const rows = reportRows(start, end);
    const total = rows.reduce((sum, appt) => sum + grossAmount(appt), 0);
    const due = rows.reduce((sum, appt) => sum + remittanceDueAmount(appt), 0);
    const remitted = rows.reduce((sum, appt) => sum + remittedAmount(appt), 0);
    const unremitted = rows.reduce((sum, appt) => sum + unremittedAmount(appt), 0);
    const panelContent = {
      revenue: revenueTableHtml(rows),
      guests: guestTableHtml(rows),
      retention: retentionTableHtml(rows),
      commission: remittanceTableHtml(rows)
    }[activeReportPanel] || revenueTableHtml(rows);
    const panelDescriptions = {
      revenue: "逐筆核對應收、應回帳金額、回帳狀態與管道。",
      guests: "按日期比較來客、新客、回客與每日應收總額。",
      retention: "檢視各師傅服務量、顧客結構與回客表現。",
      commission: "集中追蹤應回帳、已回帳與尚未回帳的金額。"
    };

    $("view-report").innerHTML = `
      <div class="page-workbench-header">
        <div>
          <span class="page-kicker">財務管理</span>
          <h2>營運與回帳</h2>
          <p>先掌握區間金額，再進入營收、來客、回客或回帳明細。</p>
        </div>
        <div class="workbench-actions report-filter-actions">
          <label class="compact-date-field"><span>開始</span><input id="reportStartDate" type="date" value="${start}"></label>
          <label class="compact-date-field"><span>結束</span><input id="reportEndDate" type="date" value="${end}"></label>
          <button id="queryReportBtn" class="btn-light">${iconHtml("search")}查詢</button>
          <button id="exportReportBtn" class="btn-teal">${iconHtml("download")}輸出</button>
        </div>
      </div>
      <div class="report-summary-grid">
        <div class="report-summary-card tone-slate"><span>${iconHtml("users")}</span><div><p>服務筆數</p><strong>${rows.length}</strong><small>${start === end ? "當日" : "所選區間"}</small></div></div>
        <div class="report-summary-card tone-rose"><span>${iconHtml("circle-dollar-sign")}</span><div><p>應收總額</p><strong>${money(total)}</strong><small>顧客支付總額</small></div></div>
        <div class="report-summary-card tone-indigo"><span>${iconHtml("landmark")}</span><div><p>應回帳</p><strong>${money(due)}</strong><small>店家應收</small></div></div>
        <div class="report-summary-card tone-teal"><span>${iconHtml("badge-check")}</span><div><p>已回帳</p><strong>${money(remitted)}</strong><small>目前已登記</small></div></div>
        <div class="report-summary-card tone-amber"><span>${iconHtml("clock-3")}</span><div><p>未回帳</p><strong>${money(unremitted)}</strong><small>尚待追蹤</small></div></div>
      </div>
      <div class="report-data-card card overflow-hidden">
        <div class="report-data-head">
          <div class="workspace-tabs report-tabs" role="tablist">${reportTab("revenue")}${reportTab("guests")}${reportTab("retention")}${reportTab("commission")}</div>
          <p>${esc(panelDescriptions[activeReportPanel] || panelDescriptions.revenue)}</p>
        </div>
        <div class="report-data-body">${panelContent}</div>
      </div>`;
    $("queryReportBtn").onclick = renderReport;
    $("exportReportBtn").onclick = exportReportCSV;
    $("view-report").querySelectorAll("[data-report-panel]").forEach((btn) => btn.onclick = () => {
      activeReportPanel = btn.dataset.reportPanel;
      renderReport();
    });
    $("view-report").querySelectorAll("[data-open-appt]").forEach((btn) => btn.onclick = () => openAppointmentDetailPage(btn.dataset.openAppt));
    if (typeof hydrateResponsiveTables === "function") hydrateResponsiveTables($("view-report"));
  };

  exportReportCSV = function exportReportCSV() {
    const start = $("reportStartDate").value;
    const end = $("reportEndDate").value;
    const rows = reportRows(start, end);
    let csv = "\uFEFF";
    if (activeReportPanel === "commission") {
      csv += "師傅,服務筆數,應收總額,應回帳金額,已回帳金額,未回帳金額\n";
      Object.keys(db.therapists).forEach((id) => {
        const mine = rows.filter((appt) => appt.therapistId === id);
        if (!mine.length) return;
        const gross = mine.reduce((sum, appt) => sum + grossAmount(appt), 0);
        const due = mine.reduce((sum, appt) => sum + remittanceDueAmount(appt), 0);
        const remitted = mine.reduce((sum, appt) => sum + remittedAmount(appt), 0);
        const unremitted = mine.reduce((sum, appt) => sum + unremittedAmount(appt), 0);
        csv += [therapistName(id), mine.length, gross, due, remitted, unremitted].map(csvCell).join(",") + "\n";
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
      csv += "日期,時間,顧客編碼,顧客姓名,聯絡方式,負責師傅,服務項目,應收總額,應回帳金額,已回帳,回帳管道\n";
      rows.forEach((appt) => {
        csv += [appt.date, appt.time, customerCode(appt.phone), appt.customerName || db.customers[appt.phone]?.name || "", appt.phone, therapistName(appt.therapistId), courseName(appt.service), grossAmount(appt), remittanceDueAmount(appt), isRemitted(appt) ? "是" : "否", remittanceMethod(appt)].map(csvCell).join(",") + "\n";
      });
    }
    downloadCSV(csv, `報表_${activeReportPanel}_${start}_至_${end}.csv`);
  };

  if ($("view-report") && !$("view-report").classList.contains("hidden")) renderReport();
})();
