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
      metricGrid.className = metricGrid.className
        .replace("xl:grid-cols-6", "xl:grid-cols-5")
        .replace("grid-cols-2", "grid-cols-2");
    }

    doorCell.className = "card p-5";
    const doorTitle = doorCell.querySelector("p.text-xs");
    if (doorTitle) doorTitle.textContent = "大門密碼";

    sideColumn.className = "flex flex-col gap-5";
    sideColumn.prepend(doorCell);

    const scheduleCard = Array.from(sideColumn.children).find((child) => child !== doorCell && child.textContent.includes("排班概況"));
    if (scheduleCard) {
      scheduleCard.classList.add("flex-1");
      scheduleCard.classList.add("min-h-[260px]");
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
