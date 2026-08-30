/**
 * Incident Reports Controller (reports.js)
 * ==========================================
 * Handles fetching, filtering, displaying, and updating incident reports
 * from the Super Admin panel via the FastAPI backend.
 */
document.addEventListener('DOMContentLoaded', () => {

    // ── Sidebar & Mobile Nav ──────────────────────────────────────────────
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebar       = document.getElementById('sidebar');
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

    // ── Populate Sidebar / Header User ───────────────────────────────────
    const currentUser = Storage.getUser();
    const sidebarName  = document.getElementById('sidebarName');
    const sidebarAvatar = document.getElementById('sidebarAvatar');
    const headerAvatar  = document.getElementById('headerAvatar');
    const initials = (currentUser.username || 'SA').substring(0, 2).toUpperCase();
    if (sidebarName)   sidebarName.textContent  = currentUser.username;
    if (sidebarAvatar) sidebarAvatar.textContent = initials;
    if (headerAvatar)  headerAvatar.textContent  = initials;

    // ── Live Clock & Date ─────────────────────────────────────────────────
    function updateClock() {
        const now = new Date();
        const liveClock = document.getElementById('liveClock');
        const liveDate  = document.getElementById('liveDate');
        if (liveClock) liveClock.textContent = now.toLocaleTimeString('en-US', { hour12: false });
        if (liveDate)  liveDate.textContent  = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
    updateClock();
    setInterval(updateClock, 1000);

    // ── Logout Modal ──────────────────────────────────────────────────────
    const logoutBtn    = document.getElementById('logoutBtn');
    const logoutModal  = document.getElementById('logoutModal');
    const cancelLogout = document.getElementById('cancelLogout');
    const confirmLogout = document.getElementById('confirmLogout');

    if (logoutBtn && logoutModal)  logoutBtn.addEventListener('click', (e) => { e.preventDefault(); logoutModal.style.display = 'flex'; });
    if (cancelLogout && logoutModal) cancelLogout.addEventListener('click', () => logoutModal.style.display = 'none');
    if (confirmLogout) confirmLogout.addEventListener('click', () => Auth.logout());

    // ── DOM References ────────────────────────────────────────────────────
    const reportsTableBody = document.getElementById('reportsTableBody');
    const reportCount      = document.getElementById('reportCount');
    const statTotal        = document.getElementById('statTotal');
    const statOpen         = document.getElementById('statOpen');
    const statUrgent       = document.getElementById('statUrgent');
    const statResolved     = document.getElementById('statResolved');

    const searchInput      = document.getElementById('searchInput');
    const statusFilter     = document.getElementById('statusFilter');
    const priorityFilter   = document.getElementById('priorityFilter');
    const categoryFilter   = document.getElementById('categoryFilter');
    const refreshBtn       = document.getElementById('refreshBtn');

    // Modal elements
    const reviewModal      = document.getElementById('reviewModal');
    const closeReviewModal = document.getElementById('closeReviewModal');
    const cancelReviewBtn  = document.getElementById('cancelReviewBtn');
    const saveReviewBtn    = document.getElementById('saveReviewBtn');
    const mdStatusSelect   = document.getElementById('mdStatusSelect');
    const mdAdminNotes     = document.getElementById('mdAdminNotes');

    // State
    let activeReportId = null;
    let allReports     = [];   // cache the last fetched set for summary calc

    // ─────────────────────────────────────────────────────────────────────
    // Badge Helpers
    // ─────────────────────────────────────────────────────────────────────

    function priorityBadge(priority) {
        const p = (priority || '').toUpperCase();
        const map = {
            LOW:      ['priority-low',      'fa-arrow-down',  'Low'],
            MEDIUM:   ['priority-medium',   'fa-minus',       'Medium'],
            HIGH:     ['priority-high',     'fa-arrow-up',    'High'],
            CRITICAL: ['priority-critical', 'fa-bolt',        'Critical'],
        };
        const [cls, icon, label] = map[p] || ['priority-low', 'fa-minus', priority];
        return `<span class="priority-badge ${cls}"><i class="fas ${icon}"></i>${label}</span>`;
    }

    function statusBadge(status) {
        const s = (status || '').toUpperCase();
        const map = {
            OPEN:        ['status-open',        'fa-circle',        'Open'],
            IN_PROGRESS: ['status-in_progress', 'fa-spinner',       'In Progress'],
            RESOLVED:    ['status-resolved',    'fa-check-circle',  'Resolved'],
            REJECTED:    ['status-rejected',    'fa-times-circle',  'Rejected'],
        };
        const [cls, icon, label] = map[s] || ['status-open', 'fa-circle', status];
        return `<span class="status-badge ${cls}"><i class="fas ${icon}"></i>${label}</span>`;
    }

    function categoryLabel(cat) {
        const map = {
            BUG:                    'Bug',
            HARDWARE:               'Hardware',
            INVENTORY_DISCREPANCY:  'Inventory Discrepancy',
            PAYMENT_ISSUE:          'Payment Issue',
            OTHER:                  'Other',
        };
        return map[(cat || '').toUpperCase()] || cat || '—';
    }

    function formatDate(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Update Summary Cards
    // ─────────────────────────────────────────────────────────────────────

    function updateSummaryCards(reports) {
        const total    = reports.length;
        const open     = reports.filter(r => ['OPEN', 'IN_PROGRESS'].includes((r.status || '').toUpperCase())).length;
        const urgent   = reports.filter(r => ['HIGH', 'CRITICAL'].includes((r.priority || '').toUpperCase())).length;
        const resolved = reports.filter(r => (r.status || '').toUpperCase() === 'RESOLVED').length;

        if (statTotal)   animateCount(statTotal,   total);
        if (statOpen)    animateCount(statOpen,     open);
        if (statUrgent)  animateCount(statUrgent,   urgent);
        if (statResolved) animateCount(statResolved, resolved);
    }

    function animateCount(el, target) {
        let current = 0;
        const step = Math.max(1, Math.ceil(target / 20));
        const timer = setInterval(() => {
            current = Math.min(current + step, target);
            el.textContent = current;
            if (current >= target) clearInterval(timer);
        }, 40);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Render Table
    // ─────────────────────────────────────────────────────────────────────

    function renderTable(reports) {
        if (!reportsTableBody) return;

        if (reports.length === 0) {
            reportsTableBody.innerHTML = `
                <tr>
                    <td colspan="9" style="text-align:center; padding:50px; color:var(--text-muted);">
                        <i class="fas fa-inbox" style="font-size:32px; margin-bottom:12px; display:block; opacity:0.4;"></i>
                        No reports match the current filters.
                    </td>
                </tr>`;
            return;
        }

        reportsTableBody.innerHTML = reports.map((r, idx) => {
            const tenantName  = r.tenant_name || `Tenant #${r.tenant_id}`;
            const reporter    = r.username    || `User #${r.user_id}`;
            const categoryLbl = categoryLabel(r.category);

            return `
                <tr>
                    <td style="color:var(--text-muted); font-weight:500;">#${r.id}</td>
                    <td style="font-weight:600;">${escapeHtml(tenantName)}</td>
                    <td>
                        <span style="display:inline-flex; align-items:center; gap:6px;">
                            <span style="width:26px;height:26px;border-radius:50%;background:var(--accent-glow);color:var(--accent-dark);display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;">
                                ${escapeHtml(reporter).substring(0,2).toUpperCase()}
                            </span>
                            ${escapeHtml(reporter)}
                        </span>
                    </td>
                    <td style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</td>
                    <td><span class="cat-badge">${escapeHtml(categoryLbl)}</span></td>
                    <td>${priorityBadge(r.priority)}</td>
                    <td>${statusBadge(r.status)}</td>
                    <td style="color:var(--text-muted); font-size:13px;">${formatDate(r.created_at)}</td>
                    <td>
                        <button class="btn-review" data-id="${r.id}" id="reviewBtn_${r.id}">
                            <i class="fas fa-eye" style="margin-right:4px;"></i>Review
                        </button>
                    </td>
                </tr>`;
        }).join('');

        // Attach click listeners to all Review buttons
        reportsTableBody.querySelectorAll('.btn-review').forEach(btn => {
            btn.addEventListener('click', () => {
                const reportId = parseInt(btn.dataset.id, 10);
                const report   = allReports.find(r => r.id === reportId);
                if (report) openReviewModal(report);
            });
        });
    }

    // Simple HTML escaper to prevent XSS in table rendering
    function escapeHtml(str) {
        if (str == null) return '—';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ─────────────────────────────────────────────────────────────────────
    // Load Reports from API
    // ─────────────────────────────────────────────────────────────────────

    async function loadReports() {
        if (!reportsTableBody) return;

        reportsTableBody.innerHTML = `
            <tr>
                <td colspan="9" style="text-align:center; padding:40px; color:var(--text-muted);">
                    <i class="fas fa-spinner fa-spin" style="margin-right:8px;"></i> Loading reports…
                </td>
            </tr>`;

        const params = new URLSearchParams();
        const search   = searchInput   ? searchInput.value.trim()   : '';
        const status   = statusFilter  ? statusFilter.value         : '';
        const priority = priorityFilter ? priorityFilter.value      : '';
        const category = categoryFilter ? categoryFilter.value      : '';

        if (search)   params.append('search',   search);
        if (status)   params.append('status',   status);
        if (priority) params.append('priority', priority);
        if (category) params.append('category', category);
        params.append('limit', '200');

        try {
            const res = await Auth.fetch(`/api/v1/super-admin/reports?${params.toString()}`);

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `Server error: ${res.status}`);
            }

            const reports = await res.json();
            allReports = reports;

            if (reportCount) reportCount.textContent = `${reports.length} report${reports.length !== 1 ? 's' : ''}`;
            updateSummaryCards(reports);
            renderTable(reports);

        } catch (err) {
            console.error('Failed to load reports:', err);
            reportsTableBody.innerHTML = `
                <tr>
                    <td colspan="9" style="text-align:center; padding:40px; color:var(--danger);">
                        <i class="fas fa-exclamation-triangle" style="margin-right:8px;"></i>
                        Failed to load reports. ${escapeHtml(err.message)}
                    </td>
                </tr>`;
            showToast('Failed to load incident reports.', 'error');
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Review Modal — Open
    // ─────────────────────────────────────────────────────────────────────

    function openReviewModal(report) {
        activeReportId = report.id;

        document.getElementById('modalReportId').textContent   = report.id;
        document.getElementById('modalTitle').innerHTML        = `Review Report <span style="color:var(--text-muted);font-size:14px;font-weight:500;">#${report.id}</span>`;
        document.getElementById('mdTenant').textContent        = report.tenant_name   || `Tenant #${report.tenant_id}`;
        document.getElementById('mdReporter').textContent      = report.username      || `User #${report.user_id}`;
        document.getElementById('mdCategory').textContent      = categoryLabel(report.category);
        document.getElementById('mdDate').textContent          = new Date(report.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
        document.getElementById('mdDescription').textContent   = report.description   || '—';

        // Priority display
        const prioEl = document.getElementById('mdPriority');
        prioEl.innerHTML = priorityBadge(report.priority);

        // Status display
        const statusEl = document.getElementById('mdStatus');
        statusEl.innerHTML = statusBadge(report.status);

        // Pre-fill form
        mdStatusSelect.value = (report.status || 'OPEN').toUpperCase();
        mdAdminNotes.value   = report.admin_notes || '';

        reviewModal.style.display = 'flex';
    }

    // ─────────────────────────────────────────────────────────────────────
    // Review Modal — Close
    // ─────────────────────────────────────────────────────────────────────

    function closeModal() {
        reviewModal.style.display = 'none';
        activeReportId = null;
    }

    if (closeReviewModal) closeReviewModal.addEventListener('click', closeModal);
    if (cancelReviewBtn)  cancelReviewBtn.addEventListener('click', closeModal);

    // Close modal on backdrop click
    if (reviewModal) {
        reviewModal.addEventListener('click', (e) => {
            if (e.target === reviewModal) closeModal();
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Review Modal — Save (PUT /super-admin/reports/{id})
    // ─────────────────────────────────────────────────────────────────────

    if (saveReviewBtn) {
        saveReviewBtn.addEventListener('click', async () => {
            if (!activeReportId) return;

            const newStatus    = mdStatusSelect.value;
            const adminNotes   = mdAdminNotes.value.trim() || null;

            // Visual feedback — disable button
            saveReviewBtn.disabled = true;
            saveReviewBtn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i>Saving…';

            try {
                const res = await Auth.fetch(`/api/v1/super-admin/reports/${activeReportId}`, {
                    method: 'PUT',
                    body: JSON.stringify({ status: newStatus, admin_notes: adminNotes }),
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || `Server error: ${res.status}`);
                }

                showToast(`Report #${activeReportId} updated successfully.`, 'success');
                closeModal();
                await loadReports();   // Refresh table

            } catch (err) {
                console.error('Failed to update report:', err);
                showToast(`Failed to update: ${err.message}`, 'error');
            } finally {
                saveReviewBtn.disabled = false;
                saveReviewBtn.innerHTML = '<i class="fas fa-save" style="margin-right:6px;"></i>Save Changes';
            }
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Filters — Debounced Search + Instant Dropdowns
    // ─────────────────────────────────────────────────────────────────────

    let debounceTimer;
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(loadReports, 350);
        });
    }
    if (statusFilter)   statusFilter.addEventListener('change',   loadReports);
    if (priorityFilter) priorityFilter.addEventListener('change', loadReports);
    if (categoryFilter) categoryFilter.addEventListener('change', loadReports);
    if (refreshBtn)     refreshBtn.addEventListener('click',      () => { loadReports(); showToast('Reports refreshed.', 'info'); });

    // ─────────────────────────────────────────────────────────────────────
    // Initial Load
    // ─────────────────────────────────────────────────────────────────────
    loadReports();
});
