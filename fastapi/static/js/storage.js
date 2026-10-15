/**
 * Storage & UI Utility Helper Module (storage.js)
 * Manages localStorage session data, theme preferences, and UI toast alerts.
 * Loaded first on every page, so it also defines the HTML-escaping helpers used by all templates.
 */

/**
 * Escapes text for safe insertion into HTML (element content or a quoted attribute).
 * Every value that came from the server or a user must pass through esc() before it is put into innerHTML.
 */
function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/`/g, "&#96;");
}

/**
 * Escapes text for a single-quoted JavaScript string inside an inline handler attribute, e.g.
 *   onclick="openItem('${escJs(item.name)}')"
 * The JS escaping runs first; esc() then protects the surrounding HTML attribute.
 */
function escJs(value) {
    if (value === null || value === undefined) return "";
    const js = String(value)
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/</g, "\\x3c")
        .replace(/>/g, "\\x3e")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
    return esc(js);
}

window.esc = esc;
window.escJs = escJs;

const Storage = {
    getToken() {
        return localStorage.getItem('access_token') || sessionStorage.getItem('access_token');
    },
    setToken(token) {
        localStorage.setItem('access_token', token);
    },
    getUser() {
        return {
            username: localStorage.getItem('username') || sessionStorage.getItem('username') || 'Super Admin',
            role: localStorage.getItem('role') || sessionStorage.getItem('role') || 'SUPER_ADMIN',
            tenantId: localStorage.getItem('tenant_id') || sessionStorage.getItem('tenant_id') || 'GLOBAL'
        };
    },
    setUser(user) {
        if (user.username) localStorage.setItem('username', user.username);
        if (user.role) localStorage.setItem('role', user.role);
        if (user.tenant_id !== undefined) {
            localStorage.setItem('tenant_id', user.tenant_id !== null ? user.tenant_id : 'GLOBAL');
        }
    },
    clear() {
        localStorage.removeItem('access_token');
        localStorage.removeItem('username');
        localStorage.removeItem('role');
        localStorage.removeItem('tenant_id');
        localStorage.removeItem('RESTOTRACK_USER');
        sessionStorage.clear();
    },
    getTheme() {
        return localStorage.getItem('blessie_theme') || 'light';
    },
    setTheme(theme) {
        localStorage.setItem('blessie_theme', theme);
        if (theme === 'dark') {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
    }
};

// Global Toast Notification Helper
function showToast(message, type = 'success') {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle';
    const iconColor = type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#0284c7';

    toast.innerHTML = `
        <i class="fas fa-${icon}" style="color:${iconColor}; font-size:16px;"></i>
        <span>${message}</span>
    `;

    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// Modal closing utility
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.style.display = 'none';
}

// Apply stored theme on initial load
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = Storage.getTheme();
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
    }
});
