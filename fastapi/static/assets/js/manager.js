/**
 * Manager Role Controller (manager.js)
 * Synchronized with Super Admin & Branch Admin visual design system.
 */

// Global Logout Modal Helpers
function openLogoutModal() {
    const modal = document.getElementById("logoutModal");
    if (modal) {
        modal.style.display = "flex";
    } else {
        doLogout();
    }
}

function closeLogoutModal() {
    const modal = document.getElementById("logoutModal");
    if (modal) {
        modal.style.display = "none";
    }
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

async function initManagerApp() {
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

    // 2. Role Guard: Enforce authenticated MANAGER (or higher) access with session recovery
    let user = null;
    if (typeof Auth !== "undefined" && typeof Auth.requireRoleAsync === "function") {
        user = await Auth.requireRoleAsync(["manager", "admin", "super_admin"]);
    } else if (typeof Auth !== "undefined" && typeof Auth.requireRole === "function") {
        user = Auth.requireRole(["manager", "admin", "super_admin"]);
    } else if (typeof requireRole === "function") {
        user = requireRole(["manager", "admin", "super_admin"]);
    }
    if (!user) return;

    // 3. Sidebar init via centralized controller
    if (typeof Utils !== "undefined" && Utils.initSidebar) {
        Utils.initSidebar();
    }

    // 4. Bind Logout Button clicks
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
        logoutBtn.addEventListener("click", (e) => {
            e.preventDefault();
            openLogoutModal();
        });
    }

    const cancelLogout = document.getElementById("cancelLogout");
    if (cancelLogout) {
        cancelLogout.addEventListener("click", (e) => {
            e.preventDefault();
            closeLogoutModal();
        });
    }

    const confirmLogout = document.getElementById("confirmLogout");
    if (confirmLogout) {
        confirmLogout.addEventListener("click", (e) => {
            e.preventDefault();
            doLogout();
        });
    }

    // 5. Populate User Identity
    function getInitials(name) {
        if (!name) return "M";
        const parts = name.trim().split(/[\s_.-]+/);
        if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    const displayName = (user && (user.name || user.username)) || (typeof Auth !== "undefined" && Auth.getUser() ? (Auth.getUser().name || Auth.getUser().username) : null) || localStorage.getItem("full_name") || localStorage.getItem("username") || "Manager";
    const initials = getInitials(displayName);

    const sidebarName = document.getElementById("sidebarName");
    const sidebarAvatar = document.getElementById("sidebarAvatar");
    const headerAvatar = document.getElementById("headerAvatar");

    if (sidebarName) sidebarName.textContent = displayName;
    if (sidebarAvatar) sidebarAvatar.textContent = initials;
    if (headerAvatar) headerAvatar.textContent = initials;

    // 6. Theme init
    if (typeof Utils !== "undefined" && Utils.initTheme) {
        Utils.initTheme();
    }

    // 7. Build Navigation Menu & Route to Dashboard
    if (typeof buildSidebarMenu === "function") {
        buildSidebarMenu("manager", (viewId) => {
            if (typeof renderView === "function") {
                renderView(viewId);
            }
        });
    }

    // Restore current feature from URL hash or session, fallback to dashboard
    if (typeof renderView === "function") {
        const initialView = (window.location.hash ? window.location.hash.replace("#", "") : "") || sessionStorage.getItem("active_feature") || "dashboard";
        renderView(initialView);
    }
}

// Fast startup: initialize immediately if DOM is already ready, or on DOMContentLoaded
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initManagerApp);
} else {
    initManagerApp();
}
