/**
 * Superadmin Activity Logs & Audit Trail Controller (logs.js)
 * Authoritative, append-only activity trail viewer for Superadmin.
 * Enforces Philippine Standard Time (Asia/Manila, UTC+08:00).
 */

document.addEventListener("DOMContentLoaded", () => {
    initLogsApp();
});

function initLogsApp() {
    // 1. Strict Role Guard: SUPERADMIN ONLY
    const currentUser = (typeof Storage !== "undefined" && Storage.getUser) ? Storage.getUser() : {};
    const role = (currentUser.role || localStorage.getItem("role") || "").toLowerCase();
    if (!role.includes("super_admin") && !role.includes("superadmin")) {
        alert("Access Denied: Activity Logs are restricted exclusively to Superadmin.");
        window.location.href = "/dashboard";
        return;
    }

    // Sidebar & Navigation Elements
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebar = document.getElementById('sidebar');
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const sidebarOverlay = document.getElementById('sidebarOverlay');

    if (sidebarToggle && sidebar) {
        sidebarToggle.addEventListener('click', () => sidebar.classList.toggle('collapsed'));
    }
    if (mobileMenuBtn && sidebar && sidebarOverlay) {
        mobileMenuBtn.addEventListener('click', () => {
            sidebar.classList.add('open');
            sidebarOverlay.classList.add('open');
        });
        sidebarOverlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            sidebarOverlay.classList.remove('open');
        });
    }

    // User Badge Display
    const sidebarName = document.getElementById('sidebarName');
    const sidebarAvatar = document.getElementById('sidebarAvatar');
    const headerAvatar = document.getElementById('headerAvatar');
    if (sidebarName) sidebarName.textContent = currentUser.username || "Super Admin";
    if (sidebarAvatar) sidebarAvatar.textContent = (currentUser.username || 'SA').substring(0, 2).toUpperCase();
    if (headerAvatar) headerAvatar.textContent = (currentUser.username || 'SA').substring(0, 2).toUpperCase();

    // Logout Modal Wiring
    const logoutBtn = document.getElementById('logoutBtn');
    const logoutModal = document.getElementById('logoutModal');
    const cancelLogout = document.getElementById('cancelLogout');
    const confirmLogout = document.getElementById('confirmLogout');

    if (logoutBtn && logoutModal) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            logoutModal.style.display = 'flex';
        });
    }
    if (cancelLogout && logoutModal) {
        cancelLogout.addEventListener('click', () => logoutModal.style.display = 'none');
    }
    if (confirmLogout) {
        confirmLogout.addEventListener('click', () => Auth.logout());
    }

    // Live Clock (Asia/Manila)
    const liveClock = document.getElementById('liveClock');
    const liveDate = document.getElementById('liveDate');
    function updateClock() {
        const now = new Date();
        const manilaTimeStr = now.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour12: true });
        const manilaDateStr = now.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'long', day: 'numeric' });
        if (liveClock) liveClock.textContent = manilaTimeStr;
        if (liveDate) liveDate.textContent = `Philippine Standard Time • ${manilaDateStr}`;
    }
    updateClock();
    setInterval(updateClock, 1000);

    // State
    const state = {
        search: "",
        role: "ALL",
        activity_type: "ALL",
        status: "ALL",
        date_range: "today",
        start_date: "",
        end_date: "",
        page: 1,
        limit: 15,
        total: 0,
        total_pages: 1,
        items: [],
        summary: {}
    };

    // DOM References
    const logsTableBody = document.getElementById('logsTableBody');
    const logSearch = document.getElementById('logSearch');
    const roleFilter = document.getElementById('roleFilter');
    const activityTypeFilter = document.getElementById('activityTypeFilter');
    const statusFilter = document.getElementById('statusFilter');
    const resetFiltersBtn = document.getElementById('resetFiltersBtn');
    const exportLogsBtn = document.getElementById('exportLogsBtn');
    const refreshLogsBtn = document.getElementById('refreshLogsBtn');
    const limitSelect = document.getElementById('limitSelect');
    const customDateRangeBox = document.getElementById('customDateRangeBox');
    const customStartDate = document.getElementById('customStartDate');
    const customEndDate = document.getElementById('customEndDate');
    const applyCustomDateBtn = document.getElementById('applyCustomDateBtn');

    // Color Helpers
    function getActivityBadge(activityType, status) {
        const act = (activityType || "").toLowerCase();
        const st = (status || "").toUpperCase();

        if (st === "FAILED" || act.includes("failed") || act.includes("cancel") || act.includes("deactivat") || act.includes("delete")) {
            return { bg: "rgba(239,68,68,0.12)", color: "#dc2626", border: "rgba(239,68,68,0.3)", icon: "fa-circle-xmark" };
        }
        if (act.includes("login") || act.includes("order") || act.includes("payment") || act.includes("receipt") || act.includes("activat")) {
            return { bg: "rgba(16,185,129,0.12)", color: "#059669", border: "rgba(16,185,129,0.3)", icon: "fa-circle-check" };
        }
        if (act.includes("stock") || act.includes("inventory") || act.includes("supplier") || act.includes("refund")) {
            return { bg: "rgba(249,115,22,0.12)", color: "#ea580c", border: "rgba(249,115,22,0.3)", icon: "fa-boxes-stacked" };
        }
        if (act.includes("logout") || act.includes("expire")) {
            return { bg: "rgba(113,113,122,0.12)", color: "#52525b", border: "rgba(113,113,122,0.3)", icon: "fa-right-from-bracket" };
        }
        return { bg: "rgba(59,130,246,0.12)", color: "#2563eb", border: "rgba(59,130,246,0.3)", icon: "fa-info-circle" };
    }

    function getRoleBadge(role) {
        const r = (role || "").toUpperCase();
        if (r.includes("ADMIN")) return { bg: "#c9a227", color: "#ffffff" };
        if (r.includes("MANAGER")) return { bg: "#3b82f6", color: "#ffffff" };
        if (r.includes("CASHIER")) return { bg: "#10b981", color: "#ffffff" };
        if (r.includes("INVENTORY")) return { bg: "#f97316", color: "#ffffff" };
        if (r.includes("KITCHEN")) return { bg: "#8b5cf6", color: "#ffffff" };
        return { bg: "#71717a", color: "#ffffff" };
    }

    // Load Logs from API
    async function loadLogs() {
        if (!logsTableBody) return;
        logsTableBody.innerHTML = `
            <tr>
                <td colspan="10" style="text-align:center; padding:36px; color:var(--text-muted);">
                    <i class="fas fa-spinner fa-spin" style="margin-right:8px; color:#c9a227;"></i> Querying audit trail...
                </td>
            </tr>
        `;

        const offset = (state.page - 1) * state.limit;
        const params = new URLSearchParams();
        params.append("limit", state.limit);
        params.append("offset", offset);
        if (state.search) params.append("search", state.search.trim());
        if (state.role && state.role !== "ALL") params.append("role", state.role);
        if (state.activity_type && state.activity_type !== "ALL") params.append("activity_type", state.activity_type);
        if (state.status && state.status !== "ALL") params.append("status", state.status);
        if (state.date_range && state.date_range !== "all") params.append("date_range", state.date_range);
        if (state.date_range === "custom") {
            if (state.start_date) params.append("start_date", state.start_date);
            if (state.end_date) params.append("end_date", state.end_date);
        }

        try {
            const res = await Auth.fetch(`/api/v1/activity-logs?${params.toString()}`);
            if (!res.ok) {
                if (res.status === 403) {
                    logsTableBody.innerHTML = `
                        <tr>
                            <td colspan="10" style="text-align:center; padding:40px; color:#ef4444;">
                                <i class="fas fa-lock" style="margin-right:6px;"></i> Access Denied: Superadmin authorization required.
                            </td>
                        </tr>
                    `;
                    return;
                }
                throw new Error("Server error querying logs.");
            }
            const data = await res.json();

            state.items = data.items || [];
            state.total = data.total || 0;
            state.total_pages = data.total_pages || 1;
            state.summary = data.summary || {};

            // Update Summary Cards
            const statActEl = document.getElementById("statActivitiesToday");
            const statLogEl = document.getElementById("statLoginsToday");
            const statUsersEl = document.getElementById("statActiveUsers");
            const statFailedEl = document.getElementById("statFailedLogins");
            const metaCountEl = document.getElementById("logCountMeta");

            if (statActEl) statActEl.textContent = Number(state.summary.total_activities_today || 0).toLocaleString();
            if (statLogEl) statLogEl.textContent = Number(state.summary.total_logins_today || 0).toLocaleString();
            if (statUsersEl) statUsersEl.textContent = Number(state.summary.active_users || 0).toLocaleString();
            if (statFailedEl) statFailedEl.textContent = Number(state.summary.failed_logins_today || 0).toLocaleString();
            if (metaCountEl) metaCountEl.textContent = `${state.total.toLocaleString()} total logged events matching current filters`;

            // Render Rows
            if (state.items.length === 0) {
                logsTableBody.innerHTML = `
                    <tr>
                        <td colspan="10" style="text-align:center; padding:45px 20px; color:#71717a;">
                            <div style="font-size:32px; color:#d4d4d8; margin-bottom:10px;"><i class="fas fa-folder-open"></i></div>
                            <div style="font-size:14px; font-weight:700; color:#18181b;">No Activity Records Found</div>
                            <div style="font-size:12px; margin-top:4px;">No activities recorded matching the selected filter criteria.</div>
                        </td>
                    </tr>
                `;
                renderPagination();
                return;
            }

            logsTableBody.innerHTML = state.items.map((log, idx) => {
                const actBadge = getActivityBadge(log.activity_type, log.status);
                const roleBadge = getRoleBadge(log.role);
                const isFailed = (log.status || "").toUpperCase() === "FAILED";

                return `
                    <tr style="border-bottom:1px solid #f4f4f5; background:${idx % 2 === 0 ? '#ffffff' : '#fafafa'}; cursor:pointer;" onclick="window._openLogDetailModal(${log.id})" title="Click to inspect audit record">
                        <td style="padding:10px 14px; font-weight:600; color:#18181b; white-space:nowrap;">${log.ph_date || '—'}</td>
                        <td style="padding:10px 14px; color:#52525b; font-variant-numeric:tabular-nums; white-space:nowrap; font-weight:500;">${log.ph_time || '—'}</td>
                        <td style="padding:10px 14px; font-weight:700; color:#18181b; white-space:nowrap;">${escapeHtml(log.full_name || log.username || 'System')}</td>
                        <td style="padding:10px 14px; color:#71717a; font-family:monospace; font-size:11.5px; white-space:nowrap;">${escapeHtml(log.username || '—')}</td>
                        <td style="padding:10px 14px; white-space:nowrap;">
                            <span style="display:inline-block; padding:3px 8px; border-radius:4px; font-size:10px; font-weight:800; background:${roleBadge.bg}; color:${roleBadge.color}; letter-spacing:0.4px;">
                                ${escapeHtml(log.role || 'STAFF')}
                            </span>
                        </td>
                        <td style="padding:10px 14px; white-space:nowrap;">
                            <span style="display:inline-flex; align-items:center; gap:5px; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:700; background:${actBadge.bg}; color:${actBadge.color}; border:1px solid ${actBadge.border};">
                                <i class="fas ${actBadge.icon}"></i> ${escapeHtml(log.activity_type || log.action || 'Activity')}
                            </span>
                        </td>
                        <td style="padding:10px 14px; color:#27272a; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(log.description || log.details || '')}">
                            ${escapeHtml(log.description || log.details || '—')}
                        </td>
                        <td style="padding:10px 14px; color:#71717a; font-family:monospace; font-size:11px; white-space:nowrap;">${escapeHtml(log.ip_address || '—')}</td>
                        <td style="padding:10px 14px; white-space:nowrap;">
                            <span style="display:inline-block; padding:2px 7px; border-radius:999px; font-size:10.5px; font-weight:800; ${isFailed ? 'background:rgba(239,68,68,0.12); color:#dc2626; border:1px solid rgba(239,68,68,0.3);' : 'background:rgba(16,185,129,0.12); color:#059669; border:1px solid rgba(16,185,129,0.3);'}">
                                ${escapeHtml(log.status || 'SUCCESS')}
                            </span>
                        </td>
                        <td style="padding:10px 14px; text-align:center; white-space:nowrap;" onclick="event.stopPropagation();">
                            <button type="button" class="btn btn-outline btn-sm" onclick="window._openLogDetailModal(${log.id})" style="padding:3px 8px; font-size:11px; border-color:#d4d4d8; color:#18181b;">
                                <i class="fas fa-eye" style="color:#c9a227;"></i> Details
                            </button>
                        </td>
                    </tr>
                `;
            }).join("");

            renderPagination();
        } catch (err) {
            console.error("Load logs error:", err);
            logsTableBody.innerHTML = `
                <tr>
                    <td colspan="10" style="text-align:center; padding:35px; color:#ef4444;">
                        Failed to retrieve audit logs from server.
                    </td>
                </tr>
            `;
        }
    }

    // Pagination
    function renderPagination() {
        const infoEl = document.getElementById("paginationInfo");
        const btnsEl = document.getElementById("paginationButtons");
        if (!infoEl || !btnsEl) return;

        const startEntry = state.total === 0 ? 0 : (state.page - 1) * state.limit + 1;
        const endEntry = Math.min(state.page * state.limit, state.total);
        infoEl.textContent = `Showing ${startEntry.toLocaleString()} to ${endEntry.toLocaleString()} of ${state.total.toLocaleString()} records`;

        let html = `
            <button type="button" class="btn btn-outline btn-sm" onclick="window._changePage(${state.page - 1})" ${state.page <= 1 ? 'disabled style="opacity:0.5;"' : ''}>
                <i class="fas fa-chevron-left"></i> Prev
            </button>
        `;

        const totalPages = Math.max(1, state.total_pages);
        let pStart = Math.max(1, state.page - 2);
        let pEnd = Math.min(totalPages, pStart + 4);
        if (pEnd - pStart < 4) pStart = Math.max(1, pEnd - 4);

        for (let p = pStart; p <= pEnd; p++) {
            html += `
                <button type="button" class="btn btn-sm ${p === state.page ? 'btn-primary' : 'btn-outline'}" onclick="window._changePage(${p})" style="min-width:32px; padding:4px 8px;">
                    ${p}
                </button>
            `;
        }

        html += `
            <button type="button" class="btn btn-outline btn-sm" onclick="window._changePage(${state.page + 1})" ${state.page >= totalPages ? 'disabled style="opacity:0.5;"' : ''}>
                Next <i class="fas fa-chevron-right"></i>
            </button>
        `;

        btnsEl.innerHTML = html;
    }

    window._changePage = function(p) {
        if (p < 1 || p > state.total_pages || p === state.page) return;
        state.page = p;
        loadLogs();
    };

    // Filter Listeners
    let searchTimer = null;
    if (logSearch) {
        logSearch.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                state.search = logSearch.value;
                state.page = 1;
                loadLogs();
            }, 350);
        });
    }

    if (roleFilter) {
        roleFilter.addEventListener('change', () => {
            state.role = roleFilter.value;
            state.page = 1;
            loadLogs();
        });
    }

    if (activityTypeFilter) {
        activityTypeFilter.addEventListener('change', () => {
            state.activity_type = activityTypeFilter.value;
            state.page = 1;
            loadLogs();
        });
    }

    if (statusFilter) {
        statusFilter.addEventListener('change', () => {
            state.status = statusFilter.value;
            state.page = 1;
            loadLogs();
        });
    }

    if (limitSelect) {
        limitSelect.addEventListener('change', () => {
            state.limit = Number(limitSelect.value) || 15;
            state.page = 1;
            loadLogs();
        });
    }

    // Quick Date Pills
    document.querySelectorAll(".filter-pill[data-range]").forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll(".filter-pill[data-range]").forEach(p => p.classList.remove('active'));
            pill.classList.add('active');

            const rangeKey = pill.getAttribute("data-range");
            state.date_range = rangeKey;
            state.page = 1;

            if (customDateRangeBox) {
                customDateRangeBox.style.display = rangeKey === "custom" ? "flex" : "none";
            }

            if (rangeKey !== "custom") {
                loadLogs();
            }
        });
    });

    if (applyCustomDateBtn) {
        applyCustomDateBtn.addEventListener('click', () => {
            state.start_date = customStartDate ? customStartDate.value : "";
            state.end_date = customEndDate ? customEndDate.value : "";
            state.page = 1;
            loadLogs();
        });
    }

    if (resetFiltersBtn) {
        resetFiltersBtn.addEventListener('click', () => {
            state.search = "";
            state.role = "ALL";
            state.activity_type = "ALL";
            state.status = "ALL";
            state.date_range = "today";
            state.start_date = "";
            state.end_date = "";
            state.page = 1;
            state.limit = 15;

            if (logSearch) logSearch.value = "";
            if (roleFilter) roleFilter.value = "ALL";
            if (activityTypeFilter) activityTypeFilter.value = "ALL";
            if (statusFilter) statusFilter.value = "ALL";
            if (limitSelect) limitSelect.value = "15";
            if (customDateRangeBox) customDateRangeBox.style.display = "none";

            document.querySelectorAll(".filter-pill[data-range]").forEach(p => {
                p.classList.toggle('active', p.getAttribute("data-range") === "today");
            });

            loadLogs();
        });
    }

    if (refreshLogsBtn) {
        refreshLogsBtn.addEventListener('click', () => loadLogs());
    }

    if (exportLogsBtn) {
        exportLogsBtn.addEventListener('click', () => {
            if (!confirm("Export current filtered audit logs to CSV?")) return;
            const params = new URLSearchParams();
            if (state.search) params.append("search", state.search.trim());
            if (state.role && state.role !== "ALL") params.append("role", state.role);
            if (state.activity_type && state.activity_type !== "ALL") params.append("activity_type", state.activity_type);
            if (state.status && state.status !== "ALL") params.append("status", state.status);
            if (state.date_range && state.date_range !== "all") params.append("date_range", state.date_range);
            if (state.date_range === "custom") {
                if (state.start_date) params.append("start_date", state.start_date);
                if (state.end_date) params.append("end_date", state.end_date);
            }
            window.open(`/api/v1/activity-logs/export?${params.toString()}`, "_blank");
        });
    }

    // Modal Inspection Logic
    const logDetailModal = document.getElementById('logDetailModal');
    const closeDetailModal = document.getElementById('closeDetailModal');
    const closeDetailModalBtn = document.getElementById('closeDetailModalBtn');
    const detailModalBody = document.getElementById('detailModalBody');
    const detailModalTitle = document.getElementById('detailModalTitle');

    function closeModal() {
        if (logDetailModal) logDetailModal.style.display = "none";
    }

    if (closeDetailModal) closeDetailModal.addEventListener('click', closeModal);
    if (closeDetailModalBtn) closeDetailModalBtn.addEventListener('click', closeModal);
    if (logDetailModal) {
        logDetailModal.addEventListener('click', (e) => {
            if (e.target === logDetailModal) closeModal();
        });
    }

    window._openLogDetailModal = function(logId) {
        const log = (state.items || []).find(l => l.id === logId);
        if (!log || !detailModalBody) return;

        const actBadge = getActivityBadge(log.activity_type, log.status);
        const roleBadge = getRoleBadge(log.role);
        const isFailed = (log.status || "").toUpperCase() === "FAILED";

        let metaFormatted = "None recorded";
        if (log.metadata_json) {
            try {
                const parsed = typeof log.metadata_json === "string" ? JSON.parse(log.metadata_json) : log.metadata_json;
                metaFormatted = `<pre style="margin:0; background:#f4f4f5; padding:10px; border-radius:6px; font-size:11px; font-family:monospace; max-height:160px; overflow-y:auto; color:#18181b;">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>`;
            } catch (e) {
                metaFormatted = `<code style="font-size:11px;">${escapeHtml(log.metadata_json)}</code>`;
            }
        }

        if (detailModalTitle) {
            detailModalTitle.innerHTML = `<i class="fas fa-shield-halved" style="color:#c9a227;"></i> Activity Audit Record #${log.id}`;
        }

        detailModalBody.innerHTML = `
            <div style="font-size:13px; color:#18181b; line-height:1.5;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; padding-bottom:14px; border-bottom:1px solid #e4e4e7; margin-bottom:16px; flex-wrap:wrap; gap:10px;">
                    <div>
                        <span style="display:inline-flex; align-items:center; gap:5px; padding:4px 10px; border-radius:6px; font-size:12px; font-weight:700; background:${actBadge.bg}; color:${actBadge.color}; border:1px solid ${actBadge.border}; margin-bottom:6px;">
                            <i class="fas ${actBadge.icon}"></i> ${escapeHtml(log.activity_type || log.action || 'Activity')}
                        </span>
                        <h4 style="font-size:16px; font-weight:800; margin:0; color:#18181b;">Log ID #${log.id}</h4>
                    </div>
                    <div style="text-align:right;">
                        <span style="display:inline-block; padding:3px 10px; border-radius:999px; font-size:11px; font-weight:800; ${isFailed ? 'background:rgba(239,68,68,0.12); color:#dc2626; border:1px solid rgba(239,68,68,0.3);' : 'background:rgba(16,185,129,0.12); color:#059669; border:1px solid rgba(16,185,129,0.3);'}">
                            ${escapeHtml(log.status || 'SUCCESS')}
                        </span>
                        <div style="font-size:11px; color:#71717a; margin-top:4px;">Audit Trail Record</div>
                    </div>
                </div>

                <div style="background:#fafafa; border:1px solid #e4e4e7; border-radius:8px; padding:12px 14px; margin-bottom:18px;">
                    <span style="display:block; font-size:10.5px; font-weight:700; text-transform:uppercase; color:#71717a; margin-bottom:3px;">Description</span>
                    <div style="font-size:13.5px; font-weight:600; color:#18181b;">${escapeHtml(log.description || log.details || 'No description recorded')}</div>
                </div>

                <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:18px;">
                    <div style="border:1px solid #e4e4e7; border-radius:8px; padding:12px; background:#ffffff;">
                        <h5 style="margin:0 0 10px 0; font-size:11.5px; font-weight:800; text-transform:uppercase; color:#71717a; border-bottom:1px solid #f4f4f5; padding-bottom:4px;">
                            <i class="fas fa-user-circle" style="color:#c9a227;"></i> Account Identity
                        </h5>
                        <table style="width:100%; font-size:12px; border-collapse:collapse;">
                            <tr><td style="padding:4px 0; color:#71717a;">Employee Name:</td><td style="padding:4px 0; text-align:right; font-weight:700; color:#18181b;">${escapeHtml(log.full_name || '—')}</td></tr>
                            <tr><td style="padding:4px 0; color:#71717a;">Username / Email:</td><td style="padding:4px 0; text-align:right; font-family:monospace; color:#18181b;">${escapeHtml(log.username || '—')}</td></tr>
                            <tr><td style="padding:4px 0; color:#71717a;">Role:</td><td style="padding:4px 0; text-align:right;"><span style="display:inline-block; padding:2px 7px; border-radius:4px; font-size:10px; font-weight:800; background:${roleBadge.bg}; color:${roleBadge.color};">${escapeHtml(log.role || 'STAFF')}</span></td></tr>
                            <tr><td style="padding:4px 0; color:#71717a;">User ID:</td><td style="padding:4px 0; text-align:right; font-family:monospace;">${log.user_id ? `#${log.user_id}` : '—'}</td></tr>
                        </table>
                    </div>

                    <div style="border:1px solid #e4e4e7; border-radius:8px; padding:12px; background:#ffffff;">
                        <h5 style="margin:0 0 10px 0; font-size:11.5px; font-weight:800; text-transform:uppercase; color:#71717a; border-bottom:1px solid #f4f4f5; padding-bottom:4px;">
                            <i class="fas fa-network-wired" style="color:#3b82f6;"></i> Security &amp; Network
                        </h5>
                        <table style="width:100%; font-size:12px; border-collapse:collapse;">
                            <tr><td style="padding:4px 0; color:#71717a;">Philippine Date:</td><td style="padding:4px 0; text-align:right; font-weight:600;">${escapeHtml(log.ph_date || '—')}</td></tr>
                            <tr><td style="padding:4px 0; color:#71717a;">Philippine Time:</td><td style="padding:4px 0; text-align:right; font-weight:600; font-variant-numeric:tabular-nums;">${escapeHtml(log.ph_time || '—')}</td></tr>
                            <tr><td style="padding:4px 0; color:#71717a;">IP Address:</td><td style="padding:4px 0; text-align:right; font-family:monospace; font-weight:700;">${escapeHtml(log.ip_address || '—')}</td></tr>
                            <tr><td style="padding:4px 0; color:#71717a;">Session ID:</td><td style="padding:4px 0; text-align:right; font-family:monospace; font-size:11px; max-width:140px; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(log.session_id ? log.session_id.substring(0, 12) + '…' : '—')}</td></tr>
                        </table>
                    </div>
                </div>

                <div style="margin-bottom:16px;">
                    <span style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; color:#71717a; margin-bottom:4px;">Browser / Device User Agent</span>
                    <div style="background:#f4f4f5; border:1px solid #e4e4e7; border-radius:6px; padding:8px 12px; font-size:11px; font-family:monospace; color:#52525b; word-break:break-all;">
                        ${escapeHtml(log.user_agent || 'Not captured')}
                    </div>
                </div>

                <div>
                    <span style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; color:#71717a; margin-bottom:4px;">Additional Metadata</span>
                    ${metaFormatted}
                </div>
            </div>
        `;

        if (logDetailModal) logDetailModal.style.display = "flex";
    };

    function escapeHtml(str) {
        if (!str && str !== 0) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // Initial Load
    loadLogs();
}
