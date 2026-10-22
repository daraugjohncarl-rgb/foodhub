/**
 * Kitchen KDS Role Controller (kitchen.js)
 * Synchronized with Super Admin & Cashier visual design system.
 */

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
    } else {
        localStorage.clear();
        sessionStorage.clear();
        window.location.href = "/";
    }
}

window.openLogoutModal = openLogoutModal;
window.closeLogoutModal = closeLogoutModal;
window.doLogout = doLogout;

async function initKitchenApp() {
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

    // 2. Role Guard: Enforce authenticated KITCHEN (or higher) access with seamless session recovery
    let user = null;
    if (typeof Auth !== "undefined" && typeof Auth.requireRoleAsync === "function") {
        user = await Auth.requireRoleAsync(["kitchen", "admin", "super_admin"]);
    } else if (typeof Auth !== "undefined" && typeof Auth.requireRole === "function") {
        user = Auth.requireRole(["kitchen", "admin", "super_admin"]);
    } else if (typeof requireRole === "function") {
        user = requireRole(["kitchen", "admin", "super_admin"]);
    }
    if (!user) return;

    // 3. Centralized Sidebar init
    if (typeof Utils !== "undefined" && Utils.initSidebar) {
        Utils.initSidebar();
    }

    // 4. Logout button listener
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
        logoutBtn.addEventListener("click", (e) => {
            e.preventDefault();
            openLogoutModal();
        });
    }

    // 5. Populate User Identity
    function getInitials(name) {
        if (!name) return "K";
        const parts = name.trim().split(/[\s_.-]+/);
        if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    const displayName = (user && (user.name || user.username)) || (typeof Auth !== "undefined" && Auth.getUser() ? (Auth.getUser().name || Auth.getUser().username) : null) || localStorage.getItem("full_name") || localStorage.getItem("username") || "Kitchen Crew";
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

    // 7. Build Navigation Menu
    if (typeof buildSidebarMenu === "function") {
        buildSidebarMenu("kitchen", (viewId) => {
            if (typeof renderView === "function") {
                renderView(viewId);
            }
        });
    }

    // 8. Always render kitchen view for Kitchen KDS (avoids stale sessionStorage from admin/manager sessions)
    if (typeof renderView === "function") {
        const hash = window.location.hash ? window.location.hash.replace("#", "") : "";
        const targetView = (hash === "kitchen_logs") ? "kitchen_logs" : "kitchen";
        renderView(targetView);
    }

    // 9. Periodic auto-refresh
    setInterval(() => {
        const activeLink = document.querySelector("aside.sidebar .nav-link.active, .sidebar a.active");
        const activeView = activeLink ? (activeLink.getAttribute("href") || "").replace(/^#\/?/, "").trim() : "";
        if (activeView === "kitchen" || !activeView) {
            if (typeof renderKitchen === "function") renderKitchen();
        }
    }, 10000);
}

// Fast startup: initialize immediately if DOM is already ready, or on DOMContentLoaded
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initKitchenApp);
} else {
    initKitchenApp();
}
