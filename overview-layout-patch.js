"use strict";

(function patchOverviewLayout() {
  const originalRenderOverview = renderOverview;

  function arrangeOverviewSideColumn() {
    const view = $("view-overview");
    if (!view) return;

    const topGrid = view.firstElementChild;
    if (!topGrid || topGrid.children.length < 2) return;

    const mainCard = topGrid.children[0];
    const sideColumn = topGrid.children[1];
    const doorInput = $("doorPassword");
    const doorCell = doorInput?.closest("div.bg-white");
    if (!mainCard || !sideColumn || !doorCell) return;

    const metricGrid = doorCell.parentElement;
    if (metricGrid) {
      topGrid.classList.add("overview-top-grid", "xl:items-start");
      mainCard.classList.add("xl:self-start");
      metricGrid.className = metricGrid.className
        .replace("xl:grid-cols-6", "xl:grid-cols-1")
        .replace("grid-cols-2", "grid-cols-2");
      metricGrid.classList.add("overview-metric-stack");
      Array.from(metricGrid.children).forEach((cell) => {
        cell.classList.add("xl:flex", "xl:items-center", "xl:justify-between", "xl:gap-4");
      });
    }

    doorCell.className = "card p-5";
    const doorTitle = doorCell.querySelector("p.text-xs");
    if (doorTitle) doorTitle.textContent = "大門密碼";

    sideColumn.className = "overview-side-column flex flex-col gap-4";
    sideColumn.prepend(doorCell);

    const scheduleCard = Array.from(sideColumn.children).find((child) => child !== doorCell && child.textContent.includes("排班概況"));
    if (scheduleCard) {
      scheduleCard.classList.add("overview-schedule-card");
    }
  }

  renderOverview = function patchedRenderOverview() {
    originalRenderOverview();
    arrangeOverviewSideColumn();
  };

  if ($("view-overview") && !$("view-overview").classList.contains("hidden")) {
    renderOverview();
  }
})();
