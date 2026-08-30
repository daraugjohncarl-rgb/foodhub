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

// Global Logout Modal Helpers
function openLogoutModal() {
    const modal = document.getElementById("logoutModal");
    if (modal) modal.style.display = "flex";
    else doLogout();
}
function closeLogoutModal() {
    const modal = document.getElementById("logoutModal");
    if (modal) modal.style.display = "none";
}
function doLogout() {
    if (typeof Auth !== "undefined" && Auth.logout) {
        Auth.logout();
    } else if (typeof logout === "function") {
        logout();
    }
}
window.openLogoutModal = openLogoutModal;
window.closeLogoutModal = closeLogoutModal;
window.doLogout = doLogout;
