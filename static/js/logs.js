/**
 * Activity Logs / Audit Trail Controller (logs.js)
 * Loads, searches, and clears system audit trails from FastAPI backend.
 */
document.addEventListener('DOMContentLoaded', () => {
    // Navigation & Sidebar
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

    // Populate Sidebar User
    const sidebarName = document.getElementById('sidebarName');
    const sidebarAvatar = document.getElementById('sidebarAvatar');
    const headerAvatar = document.getElementById('headerAvatar');
    const currentUser = Storage.getUser();
    if (sidebarName) sidebarName.textContent = currentUser.username;
    if (sidebarAvatar) sidebarAvatar.textContent = (currentUser.username || 'SA').substring(0, 2).toUpperCase();
    if (headerAvatar) headerAvatar.textContent = (currentUser.username || 'SA').substring(0, 2).toUpperCase();

    // Logout Modal
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

    const logSearch = document.getElementById('logSearch');
    const actionFilter = document.getElementById('actionFilter');
    const logsTableBody = document.getElementById('logsTableBody');
    const logCount = document.getElementById('logCount');
    const clearLogsBtn = document.getElementById('clearLogsBtn');

    // Helper: Action Badge Class
    function getActionBadgeClass(action) {
        const a = (action || '').toLowerCase();
        if (a.includes('login')) return 'action-login';
        if (a.includes('logout')) return 'action-logout';
        if (a.includes('created')) return 'action-created';
        if (a.includes('edit')) return 'action-edited';
        if (a.includes('delete')) return 'action-deleted';
        if (a.includes('activated')) return 'action-activated';
        if (a.includes('deactivated')) return 'action-deactivated';
        if (a.includes('reset')) return 'action-reset';
        if (a.includes('profile')) return 'action-profile';
        if (a.includes('settings')) return 'action-settings';
        return 'action-created';
    }

    // Load Activity Logs
    async function loadLogs() {
        if (!logsTableBody) return;
        logsTableBody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted);">
                    <i class="fas fa-spinner fa-spin" style="margin-right:8px;"></i> Loading audit logs...
                </td>
            </tr>
        `;

        const search = logSearch ? logSearch.value.trim() : '';
        const action = actionFilter ? actionFilter.value : '';

        const params = new URLSearchParams();
        params.append('limit', 100);
        if (search) params.append('search', search);
        if (action) params.append('action', action);

        try {
            const res = await Auth.fetch(`/api/v1/activity-logs?${params.toString()}`);
            if (res.ok) {
                const logs = await res.json();
                if (logCount) logCount.textContent = `${logs.length} entries`;

                if (logs.length === 0) {
                    logsTableBody.innerHTML = `
                        <tr>
                            <td colspan="6" style="text-align:center; padding:40px; color:var(--text-muted);">
                                No activity logs found.
                            </td>
                        </tr>
                    `;
                    return;
                }

                logsTableBody.innerHTML = logs.map(log => {
                    const dateObj = new Date(log.created_at);
                    const formattedDate = dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
                    const formattedTime = dateObj.toLocaleTimeString('en-US', { hour12: false });
                    const badgeClass = getActionBadgeClass(log.action);

                    return `
                        <tr>
                            <td style="font-weight:500;">${formattedDate}</td>
                            <td style="color:var(--text-muted); font-variant-numeric:tabular-nums;">${formattedTime}</td>
                            <td><span class="action-badge ${badgeClass}">${log.action}</span></td>
                            <td style="font-weight:600;">${log.performed_by || 'System'}</td>
                            <td>${log.target_user || '—'}</td>
                            <td><span class="badge badge-${(log.role || 'admin').toLowerCase()}">${log.role || '—'}</span></td>
                        </tr>
                    `;
                }).join('');
            }
        } catch (err) {
            console.error('Failed to load logs:', err);
            logsTableBody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align:center; padding:30px; color:var(--danger);">
                        Failed to load audit logs from server.
                    </td>
                </tr>
            `;
        }
    }

    // Clear Logs
    if (clearLogsBtn) {
        clearLogsBtn.addEventListener('click', async () => {
            if (!confirm('Are you sure you want to clear all activity logs?')) return;
            try {
                const res = await Auth.fetch('/api/v1/activity-logs', { method: 'DELETE' });
                if (res.ok) {
                    showToast('Activity logs cleared.');
                    loadLogs();
                }
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // Filters
    let debounceTimer;
    if (logSearch) {
        logSearch.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(loadLogs, 300);
        });
    }

    if (actionFilter) {
        actionFilter.addEventListener('change', loadLogs);
    }

    loadLogs();
});
