/**
 * Kitchen KDS Role Controller
 */
document.addEventListener("DOMContentLoaded", () => {
  const user = requireRole(["kitchen", "admin", "super_admin"]);
  if (!user) return;

  Utils.initTheme();

  buildSidebarMenu("kitchen", (viewId) => {
    renderView(viewId);
  });

  renderView("kitchen");

  // Auto-refresh KDS orders every 10 seconds as a fallback
  setInterval(() => {
    renderKitchen();
  }, 10000);
});
