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
    const mainContent = document.getElementById("mainContent");

    function toggleSidebar() {
        if (!sidebar) return;
        if (window.innerWidth <= 768) {
            sidebar.classList.toggle("open");
            if (sidebarOverlay) sidebarOverlay.classList.toggle("open");
        } else if (window.innerWidth <= 1180) {
            sidebar.classList.toggle("expanded");
            document.body.classList.toggle("sidebar-expanded");
            if (mainContent) mainContent.classList.toggle("sidebar-expanded");
        } else {
            sidebar.classList.toggle("collapsed");
            document.body.classList.toggle("sidebar-collapsed");
            if (mainContent) mainContent.classList.toggle("sidebar-collapsed");
        }
    }

    if (sidebarToggle) sidebarToggle.addEventListener("click", toggleSidebar);
    if (mobileMenuBtn) mobileMenuBtn.addEventListener("click", toggleSidebar);

    if (sidebarOverlay) {
        sidebarOverlay.addEventListener("click", () => {
            if (sidebar) sidebar.classList.remove("open");
            sidebarOverlay.classList.remove("open");
        });
    }

    // Auto-fit & auto-resize on window resize/orientation change
    function handleResponsiveSidebar() {
        const w = window.innerWidth;
        if (w > 768) {
            if (sidebar) sidebar.classList.remove("open");
            if (sidebarOverlay) sidebarOverlay.classList.remove("open");
        }
        if (w > 1180) {
            if (sidebar) sidebar.classList.remove("expanded");
            document.body.classList.remove("sidebar-expanded");
            if (mainContent) mainContent.classList.remove("sidebar-expanded");
        }
    }
    window.addEventListener("resize", handleResponsiveSidebar);
    window.addEventListener("orientationchange", handleResponsiveSidebar);

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

    // Restore current feature from URL hash or session, fallback to kitchen
    if (typeof renderView === "function") {
        const initialView = (window.location.hash ? window.location.hash.replace("#", "") : "") || sessionStorage.getItem("active_feature") || "kitchen";
        renderView(initialView);
    }

    // Periodic auto-refresh
    setInterval(() => {
        if (typeof renderKitchen === "function") renderKitchen();
    }, 10000);
});
