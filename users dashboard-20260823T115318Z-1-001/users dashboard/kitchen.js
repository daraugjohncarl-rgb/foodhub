document.addEventListener("DOMContentLoaded", () => {
  requireRole("kitchen");
  const user = getCurrentUser();
  
  document.getElementById("nav-user-name").innerText = user.name;
  document.getElementById("nav-user-role").innerText = user.role;

  buildSidebarMenu("kitchen", navigate);
  
  // Default view for kitchen is Kitchen Orders
  navigate("kitchen", "Kitchen Orders");

  document.getElementById("btn-notif").onclick = showNotifications;
  document.getElementById("btn-dark-mode").onclick = toggleDarkMode;
  
  window.addEventListener("storage", handleStorageSync);
  updateNotifBadge();
});

function navigate(viewId, title) {
  if (!hasPermission("kitchen", viewId)) {
    showToast("Access Denied", "danger");
    return;
  }
  
  document.querySelectorAll(".nav-link").forEach(el => el.classList.remove("active"));
  const activeNav = document.querySelector(`#nav-item-${viewId} .nav-link`);
  if (activeNav) activeNav.classList.add("active");

  document.getElementById("current-page-title").innerText = title;
  renderView(viewId, document.getElementById("view-container"));
}

function updateNotifBadge() {
  const unread = DB.notifications.filter(n => !n.read && (n.targetRole === "kitchen" || !n.targetRole)).length;
  document.getElementById("notif-count").innerText = unread;
}

function showNotifications() {
  const myNotifs = DB.notifications.filter(n => n.targetRole === "kitchen" || !n.targetRole);
  let list = myNotifs.map(n => `<div style="padding:0.5rem; border-bottom:1px solid #eee;">${n.text}</div>`).join("");
  if (!list) list = "<p>No notifications.</p>";
  
  openModal("Notifications", list, `<button class="btn btn-primary" onclick="markNotifsRead()">Mark All Read</button>`);
}

function markNotifsRead() {
  DB.notifications.forEach(n => {
    if (n.targetRole === "kitchen" || !n.targetRole) n.read = true;
  });
  saveDB();
  updateNotifBadge();
  closeModal();
}

function toggleDarkMode() {
  const isDark = document.body.getAttribute("data-theme") === "dark";
  document.body.setAttribute("data-theme", isDark ? "light" : "dark");
}

function handleStorageSync(e) {
  if (e.key !== "RESTOTRACK_DB") return;
  try { DB = JSON.parse(e.newValue || '{}'); } catch (_) { return; }
  
  // Kitchen cross-tab dynamic re-render
  const currentView = document.getElementById("current-page-title").innerText.toLowerCase();
  if (currentView.includes("kitchen")) {
    renderView("kitchen", document.getElementById("view-container"));
  }
  updateNotifBadge();
}
