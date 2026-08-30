/**
 * Notifications & Live Clock Module (notifications.js)
 */
document.addEventListener('DOMContentLoaded', () => {
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

    // 2. Notification Dropdown Toggle
    const notifBell = document.getElementById('notifBell');
    const notifDropdown = document.getElementById('notifDropdown');
    const notifBadge = document.getElementById('notifBadge');
    const notifList = document.getElementById('notifList');
    const markAllRead = document.getElementById('markAllRead');
    const clearNotifs = document.getElementById('clearNotifs');

    let notifications = [
        { id: 1, text: 'Super Admin logged into the platform.', time: 'Just now', unread: true },
        { id: 2, text: 'Database tables verified and operational.', time: '5m ago', unread: true },
        { id: 3, text: 'FastAPI Backend connected successfully.', time: '10m ago', unread: false }
    ];

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
                <div class="notif-time">${n.time}</div>
            </div>
        `).join('');
    }

    if (notifBell && notifDropdown) {
        notifBell.addEventListener('click', (e) => {
            e.stopPropagation();
            notifDropdown.classList.toggle('show');
        });

        document.addEventListener('click', (e) => {
            if (!notifDropdown.contains(e.target) && !notifBell.contains(e.target)) {
                notifDropdown.classList.remove('show');
            }
        });
    }

    if (markAllRead) {
        markAllRead.addEventListener('click', () => {
            notifications.forEach(n => n.unread = false);
            renderNotifications();
        });
    }

    if (clearNotifs) {
        clearNotifs.addEventListener('click', () => {
            notifications = [];
            renderNotifications();
        });
    }

    renderNotifications();
});
