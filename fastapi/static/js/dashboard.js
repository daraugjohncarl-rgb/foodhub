/**
 * Super Admin Dashboard Controller (dashboard.js)
 * Connects Super Admin metrics, Branch Admin accounts, System Reports, and profile info to FastAPI backend.
 */
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Sidebar & Mobile Toggle Handlers
    const sidebar = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const sidebarOverlay = document.getElementById('sidebarOverlay');

    if (sidebarToggle && sidebar) {
        sidebarToggle.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
        });
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

    // Live Clock & Date
    function updateClock() {
        const now = new Date();
        const clockEl = document.getElementById('liveClock');
        const dateEl = document.getElementById('liveDate');
        if (clockEl) clockEl.textContent = now.toLocaleTimeString();
        if (dateEl) dateEl.textContent = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
    updateClock();
    setInterval(updateClock, 1000);

    // 2. Logout Confirmation Modal
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
        cancelLogout.addEventListener('click', () => {
            logoutModal.style.display = 'none';
        });
    }

    if (confirmLogout) {
        confirmLogout.addEventListener('click', () => {
            Auth.logout();
        });
    }

    // 3. Helper: Generate Initials
    function getInitials(name) {
        if (!name) return 'SA';
        const parts = name.trim().split(/[\s_-]+/);
        if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    // 4. Fetch Current User Profile
    async function loadUserProfile() {
        try {
            const res = await Auth.fetch('/api/v1/auth/me');
            if (res.ok) {
                const user = await res.json();
                if (typeof Storage !== 'undefined' && Storage.setUser) {
                    Storage.setUser(user);
                }

                const displayName = user.username || 'Super Admin';
                const initials = getInitials(displayName);

                const sidebarName = document.getElementById('sidebarName');
                const sidebarAvatar = document.getElementById('sidebarAvatar');
                const headerAvatar = document.getElementById('headerAvatar');

                if (sidebarName) sidebarName.textContent = displayName;
                if (sidebarAvatar) sidebarAvatar.textContent = initials;
                if (headerAvatar) headerAvatar.textContent = initials;
            }
        } catch (err) {
            console.error('Failed to load user profile:', err);
        }
    }

    // 5. Fetch Real-time Admin Stats & System Reports Count
    async function loadDashboardStats() {
        try {
            const [usersRes, reportsRes] = await Promise.all([
                Auth.fetch('/api/v1/users/stats'),
                Auth.fetch('/api/v1/super-admin/reports?limit=100').catch(() => ({ ok: false }))
            ]);

            if (usersRes.ok) {
                const stats = await usersRes.json();
                
                const countAdmins = document.getElementById('countAdmins');
                const countActiveAdmins = document.getElementById('countActiveAdmins');
                const countInactiveAdmins = document.getElementById('countInactiveAdmins');

                if (countAdmins) countAdmins.textContent = stats.admins || 0;
                if (countActiveAdmins) countActiveAdmins.textContent = stats.active_admins || 0;
                if (countInactiveAdmins) countInactiveAdmins.textContent = stats.inactive_admins || 0;
            }

            if (reportsRes && reportsRes.ok) {
                const reports = await reportsRes.json();
                const countReports = document.getElementById('countReports');
                if (countReports) countReports.textContent = reports.length || 0;
            }
        } catch (err) {
            console.error('Failed to load dashboard stats:', err);
        }
    }

    // 6. Fetch Recent Admin Accounts (Strictly role=ADMIN)
    async function loadRecentAdmins() {
        const recentUsersBody = document.getElementById('recentUsersBody');
        if (!recentUsersBody) return;

        try {
            const res = await Auth.fetch('/api/v1/users?role=ADMIN&exclude_self=true&limit=6');
            if (res.ok) {
                const users = await res.json();
                
                if (users.length === 0) {
                    recentUsersBody.innerHTML = `
                        <tr>
                            <td colspan="4" style="text-align:center; color:var(--text-muted); padding:30px;">
                                No registered Branch Admin accounts found.
                            </td>
                        </tr>
                    `;
                    return;
                }

                recentUsersBody.innerHTML = users.map(user => {
                    const initials = getInitials(user.username);
                    const createdDate = user.created_at ? new Date(user.created_at).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric'
                    }) : 'N/A';

                    return `
                        <tr>
                            <td>
                                <div class="user-cell" style="display:flex; align-items:center; gap:12px;">
                                    <div class="user-avatar" style="width:36px; height:36px; border-radius:50%; background:linear-gradient(135deg, #c9a227, #eab308); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px;">${initials}</div>
                                    <div>
                                        <div style="font-weight:600; color:var(--text-main); font-size:13px;">${user.username}</div>
                                        <div style="font-size:12px; color:var(--text-muted);">${user.email || 'No email specified'}</div>
                                    </div>
                                </div>
                            </td>
                            <td>
                                <span class="badge" style="background:rgba(201,162,39,0.12); color:#c9a227; padding:4px 10px; border-radius:12px; font-size:11px; font-weight:700;">BRANCH ADMIN</span>
                            </td>
                            <td>
                                <span style="display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:${user.is_active ? 'var(--success, #10b981)' : 'var(--danger, #ef4444)'}">
                                    <i class="fas fa-circle" style="font-size:8px;"></i>
                                    ${user.is_active ? 'Active' : 'Inactive'}
                                </span>
                            </td>
                            <td style="color:var(--text-muted); font-size:13px;">
                                ${createdDate}
                            </td>
                        </tr>
                    `;
                }).join('');
            }
        } catch (err) {
            console.error('Failed to load recent admins:', err);
            recentUsersBody.innerHTML = `
                <tr>
                    <td colspan="4" style="text-align:center; color:var(--danger); padding:20px;">
                        Failed to load Branch Admin registrations.
                    </td>
                </tr>
            `;
        }
    }

    // 7. Fetch Recent System / Incident Reports
    async function loadRecentReports() {
        const recentReportsBody = document.getElementById('recentReportsBody');
        if (!recentReportsBody) return;

        try {
            const res = await Auth.fetch('/api/v1/super-admin/reports?limit=5');
            if (res.ok) {
                const reports = await res.json();
                if (reports.length === 0) {
                    recentReportsBody.innerHTML = `
                        <tr>
                            <td colspan="5" style="text-align:center; color:var(--text-muted); padding:30px;">
                                No system incident reports submitted. System is operating normally.
                            </td>
                        </tr>
                    `;
                    return;
                }

                recentReportsBody.innerHTML = reports.map(r => {
                    const priorityColor = r.priority === 'CRITICAL' ? 'var(--danger, #ef4444)' : r.priority === 'HIGH' ? '#f97316' : '#3b82f6';
                    const statusColor = r.status === 'RESOLVED' ? 'var(--success, #10b981)' : r.status === 'IN_PROGRESS' ? '#f59e0b' : '#ef4444';
                    const dateStr = r.created_at ? new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

                    return `
                        <tr>
                            <td>
                                <strong style="color:var(--text-main); font-size:13px;">${r.title}</strong>
                                <div style="font-size:11px; color:var(--text-muted);">${r.tenant ? r.tenant.name : 'System Core'}</div>
                            </td>
                            <td><span style="font-size:12px; color:var(--text-muted);">${r.category}</span></td>
                            <td><span style="font-size:11px; font-weight:700; color:${priorityColor};">${r.priority}</span></td>
                            <td><span style="font-size:11px; font-weight:700; color:${statusColor};">${r.status}</span></td>
                            <td style="font-size:12px; color:var(--text-muted);">${dateStr}</td>
                        </tr>
                    `;
                }).join('');
            }
        } catch (err) {
            console.error('Failed to load reports:', err);
            recentReportsBody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align:center; color:var(--text-muted); padding:20px;">
                        No system reports available.
                    </td>
                </tr>
            `;
        }
    }

    // Initialize all dashboard data
    await loadUserProfile();
    await loadDashboardStats();
    await loadRecentAdmins();
    await loadRecentReports();
});
