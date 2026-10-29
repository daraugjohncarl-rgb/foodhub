/**
 * Notifications & Live Clock Module (notifications.js)
 * Live notifications connected to /api/v1/activity-logs
 */
function initNotificationsApp() {
    // 1. Live Date & Clock
    const liveDateEl = document.getElementById('liveDate');
    const liveClockEl = document.getElementById('liveClock');

    function updateClock() {
        const now = new Date();
        if (liveDateEl) {
            const options = { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' };
            liveDateEl.textContent = now.toLocaleDateString('en-US', options);
        }
        if (liveClockEl) {
            liveClockEl.textContent = now.toLocaleTimeString('en-US', { hour12: false });
        }
    }
    updateClock();
    setInterval(updateClock, 1000);

    // 2. Notification Dropdown Toggle & Live Feed
    const notifBell = document.getElementById('notifBell');
    const notifDropdown = document.getElementById('notifDropdown');
    const notifBadge = document.getElementById('notifBadge');
    const notifList = document.getElementById('notifList');
    const markAllRead = document.getElementById('markAllRead');
    const clearNotifs = document.getElementById('clearNotifs');

    let notifications = [];

    function timeAgo(dateString) {
        if (!dateString) return '';
        const date = new Date(dateString);
        const now = new Date();
        const diffSec = Math.floor((now - date) / 1000);
        if (diffSec < 60) return 'Just now';
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return `${diffHr}h ago`;
        const diffDays = Math.floor(diffHr / 24);
        return `${diffDays}d ago`;
    }

    function getReadIds() {
        try {
            return JSON.parse(localStorage.getItem('pos_read_notifications') || '[]');
        } catch (e) {
            return [];
        }
    }

    function saveReadIds(ids) {
        try {
            localStorage.setItem('pos_read_notifications', JSON.stringify(ids));
        } catch (e) {}
    }

    function renderNotifications() {
        if (!notifList) return;
        if (notifications.length === 0) {
            notifList.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px;">No notifications.</div>';
            if (notifBadge) notifBadge.style.display = 'none';
            return;
        }

        const unreadCount = notifications.filter(n => n.unread).length;
        if (notifBadge) {
            if (unreadCount > 0) {
                notifBadge.textContent = unreadCount;
                notifBadge.style.display = 'flex';
            } else {
                notifBadge.style.display = 'none';
            }
        }

        notifList.innerHTML = notifications.map(n => `
            <div class="notif-item ${n.unread ? 'unread' : ''}">
                <div>${n.text}</div>
                <div class="notif-time">${Utils.escapeHtml(n.time)}</div>
            </div>
        `).join('');
    }

    async function loadNotifications() {
        if (!notifList) return;
        notifList.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px;"><i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i>Loading notifications...</div>';

        try {
            const fetchFn = (typeof Auth !== 'undefined' && Auth.fetch) ? Auth.fetch.bind(Auth) : fetch;
            const res = await fetchFn('/api/v1/activity-logs?limit=8');
            if (!res.ok) {
                throw new Error('Failed to load notifications');
            }
            const logs = await res.json();
            const readIds = getReadIds();

            notifications = logs.map(l => ({
                id: l.id,
                text: `${l.performed_by ? '<strong>' + Utils.escapeHtml(l.performed_by) + ':</strong> ' : ''}${Utils.escapeHtml(l.action || l.details || 'System event')}`, // pre-escaped HTML
                time: timeAgo(l.created_at),
                unread: !readIds.includes(l.id)
            }));

            renderNotifications();
        } catch (err) {
            console.warn('Failed to load live notifications:', err);
            if (notifBadge) notifBadge.style.display = 'none';
            notifList.innerHTML = `
                <div style="padding: 20px; text-align: center; color: var(--danger); font-size: 13px;">
                    <i class="fas fa-exclamation-triangle" style="margin-right:6px;"></i>Failed to load notifications.<br>
                    <button class="btn btn-outline btn-sm" id="retryNotifsBtn" style="margin-top:8px; font-size:11px; padding:4px 10px;">
                        <i class="fas fa-redo"></i> Retry
                    </button>
                </div>
            `;
            const retryBtn = document.getElementById('retryNotifsBtn');
            if (retryBtn) retryBtn.addEventListener('click', loadNotifications);
        }
    }

    window.loadNotifications = loadNotifications;

    if (notifBell && notifDropdown) {
        notifBell.addEventListener('click', (e) => {
            e.stopPropagation();
            notifDropdown.classList.toggle('show');
            if (notifDropdown.classList.contains('show')) {
                loadNotifications();
            }
        });

        document.addEventListener('click', (e) => {
            if (!notifDropdown.contains(e.target) && !notifBell.contains(e.target)) {
                notifDropdown.classList.remove('show');
            }
        });
    }

    if (markAllRead) {
        markAllRead.addEventListener('click', () => {
            const allIds = notifications.map(n => n.id);
            const readIds = Array.from(new Set([...getReadIds(), ...allIds]));
            saveReadIds(readIds);
            notifications.forEach(n => n.unread = false);
            renderNotifications();
        });
    }

    if (clearNotifs) {
        clearNotifs.addEventListener('click', () => {
            const allIds = notifications.map(n => n.id);
            saveReadIds(Array.from(new Set([...getReadIds(), ...allIds])));
            notifications = [];
            renderNotifications();
        });
    }

    loadNotifications();
}

// Fast startup: initialize immediately if DOM is already ready, or on DOMContentLoaded
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initNotificationsApp);
} else {
    initNotificationsApp();
}
