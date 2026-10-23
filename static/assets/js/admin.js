/**
 * Branch Admin Controller (admin.js)
 * Synchronized with Super Admin visual design system and dynamic view architecture.
 */
async function initAdminApp() {
    // 1. Immediately update Live Clock & Date Header so header never gets stuck on "Loading..."
    function updateClock() {
        const now = new Date();
        const clockEl = document.getElementById("liveClock");
        const dateEl = document.getElementById("liveDate");
        if (clockEl) clockEl.textContent = now.toLocaleTimeString();
        if (dateEl) dateEl.textContent = now.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    }
    updateClock();
    setInterval(updateClock, 1000);

    // 2. Role Guard: Enforce authenticated ADMIN or SUPER_ADMIN access with session recovery
    let user = null;
    if (typeof Auth !== "undefined" && typeof Auth.requireRoleAsync === "function") {
        user = await Auth.requireRoleAsync(["admin", "super_admin"]);
    } else if (typeof Auth !== "undefined" && typeof Auth.requireRole === "function") {
        user = Auth.requireRole(["admin", "super_admin"]);
    } else if (typeof requireRole === "function") {
        user = requireRole(["admin", "super_admin"]);
    }
    if (!user) return;

    // 3. Sidebar init via centralized controller
    if (typeof Utils !== "undefined" && Utils.initSidebar) {
        Utils.initSidebar();
    }

    // 4. Logout Confirmation Modal
    const logoutBtn = document.getElementById("logoutBtn");
    const logoutModal = document.getElementById("logoutModal");
    const cancelLogout = document.getElementById("cancelLogout");
    const confirmLogout = document.getElementById("confirmLogout");

    if (logoutBtn && logoutModal) {
        logoutBtn.addEventListener("click", (e) => {
            e.preventDefault();
            logoutModal.style.display = "flex";
        });
    }

    if (cancelLogout && logoutModal) {
        cancelLogout.addEventListener("click", () => {
            logoutModal.style.display = "none";
        });
    }

    if (confirmLogout) {
        confirmLogout.addEventListener("click", () => {
            Auth.logout();
        });
    }

    // 5. Populate User Identity
    function getInitials(name) {
        if (!name) return "BA";
        const parts = name.trim().split(/[\s_.-]+/);
        if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    const displayName = (user && (user.name || user.username)) || (typeof Auth !== "undefined" && Auth.getUser() ? (Auth.getUser().name || Auth.getUser().username) : null) || localStorage.getItem("full_name") || localStorage.getItem("username") || "Branch Admin";
    const initials = getInitials(displayName);

    const sidebarName = document.getElementById("sidebarName");
    const sidebarAvatar = document.getElementById("sidebarAvatar");
    const sidebarRole = document.getElementById("sidebarRole");
    const headerAvatar = document.getElementById("headerAvatar");

    if (sidebarName) sidebarName.textContent = displayName;
    if (sidebarAvatar) sidebarAvatar.textContent = initials;
    if (sidebarRole && user && user.role) sidebarRole.textContent = user.role.replace(/_/g, ' ').toUpperCase();
    if (headerAvatar) headerAvatar.textContent = initials;

    // 6. Theme init
    if (typeof Utils !== "undefined" && Utils.initTheme) {
        Utils.initTheme();
    }

    // 7. Build Navigation Menu & Route to Default View
    if (typeof buildSidebarMenu === "function") {
        buildSidebarMenu("admin", (viewId) => {
            renderView(viewId);
        });
    }

    // Initial render: restore current feature from URL hash or session, fallback to dashboard
    let initialView = (window.location.hash ? window.location.hash.replace("#", "") : "") || sessionStorage.getItem("active_feature") || "dashboard";
    if (initialView === "inventory") {
        initialView = "dashboard";
        if (window.location.hash === "#inventory") {
            history.replaceState(null, "", window.location.pathname + "#dashboard");
        }
    }
    renderView(initialView);
}

// Fast startup: initialize immediately if DOM is already ready, or on DOMContentLoaded
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAdminApp);
} else {
    initAdminApp();
}
