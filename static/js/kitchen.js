/**
 * Kitchen KDS Role Controller (kitchen.js)
 * Synchronized with Super Admin & Cashier visual design system.
 */
document.addEventListener("DOMContentLoaded", async () => {
    // 1. Role Guard: Enforce authenticated KITCHEN (or higher) access
    let user = null;
    if (typeof Auth !== "undefined" && typeof Auth.requireRole === "function") {
        user = Auth.requireRole(["kitchen", "admin", "super_admin"]);
    } else if (typeof requireRole === "function") {
        user = requireRole(["kitchen", "admin", "super_admin"]);
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

    // 4. Logout Confirmation Modal
    window.openLogoutModal = function() {
        const modal = document.getElementById("logoutModal");
        if (modal) modal.style.display = "flex";
        else window.doLogout();
    };

    window.closeLogoutModal = function() {
        const modal = document.getElementById("logoutModal");
        if (modal) modal.style.display = "none";
    };

    window.doLogout = function() {
        if (typeof Auth !== "undefined" && Auth.logout) {
            Auth.logout();
        } else if (typeof logout === "function") {
            logout();
        } else {
            localStorage.clear();
            sessionStorage.clear();
            window.location.href = "/";
        }
    };

    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
        logoutBtn.addEventListener("click", (e) => {
            e.preventDefault();
            window.openLogoutModal();
        });
    }

    // 5. Populate User Identity
    function getInitials(name) {
        if (!name) return "K";
        const parts = name.trim().split(/[\s_.-]+/);
        if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    const displayName = (user && user.username) || (typeof Auth !== "undefined" && Auth.getUser() ? Auth.getUser().username : null) || localStorage.getItem("username") || "Kitchen Crew";
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

    // 7. Build Navigation Menu & Route to Kitchen View
    if (typeof buildSidebarMenu === "function") {
        buildSidebarMenu("kitchen", (viewId) => {
            if (typeof renderView === "function") {
                renderView(viewId);
            }
        });
    }

    // Default to Kitchen Screen
    if (typeof renderView === "function") {
        renderView("kitchen");
    }

    // Periodic auto-refresh
    setInterval(() => {
        if (typeof renderKitchen === "function") renderKitchen();
    }, 10000);
});
