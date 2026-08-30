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

document.addEventListener("DOMContentLoaded", async () => {
    // 1. Role Guard: Enforce authenticated MANAGER (or higher) access
    let user = null;
    if (typeof Auth !== "undefined" && typeof Auth.requireRole === "function") {
        user = Auth.requireRole(["manager", "admin", "super_admin"]);
    } else if (typeof requireRole === "function") {
        user = requireRole(["manager", "admin", "super_admin"]);
    }
    if (!user) return;

    // 2. Sidebar & Mobile Menu Handlers
    const sidebar = document.getElementById("sidebar");
    const sidebarToggle = document.getElementById("sidebarToggle");
    const mobileMenuBtn = document.getElementById("mobileMenuBtn");
    const sidebarOverlay = document.getElementById("sidebarOverlay");

    if (sidebarToggle && sidebar) {
        sidebarToggle.addEventListener("click", () => {
            sidebar.classList.toggle("collapsed");
        });
    }

    if (mobileMenuBtn && sidebar && sidebarOverlay) {
        mobileMenuBtn.addEventListener("click", () => {
            sidebar.classList.add("open");
            sidebarOverlay.classList.add("open");
        });

        sidebarOverlay.addEventListener("click", () => {
            sidebar.classList.remove("open");
            sidebarOverlay.classList.remove("open");
        });
    }

    // 3. Live Clock & Date Header
    function updateClock() {
        const now = new Date();
        const clockEl = document.getElementById("liveClock");
        const dateEl = document.getElementById("liveDate");
        if (clockEl) clockEl.textContent = now.toLocaleTimeString();
        if (dateEl) dateEl.textContent = now.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    }
    updateClock();
    setInterval(updateClock, 1000);

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

    const displayName = (user && user.username) || (typeof Auth !== "undefined" && Auth.getUser() ? Auth.getUser().username : null) || localStorage.getItem("username") || "Manager";
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

    // Default to Dashboard
    if (typeof renderView === "function") {
        renderView("dashboard");
    }
});
