/**
 * Settings Controller (settings.js)
 * Manages theme selection, notification toggles, and security settings.
 */
function setTheme(theme) {
    Storage.setTheme(theme);
    updateThemeSelectionUI(theme);
    showToast(`Theme changed to ${theme === 'dark' ? 'Dark Mode' : 'Light Mode'}.`);
}

function updateThemeSelectionUI(theme) {
    const lightCard = document.getElementById('themeLight');
    const darkCard = document.getElementById('themeDark');
    if (!lightCard || !darkCard) return;

    if (theme === 'dark') {
        darkCard.classList.add('selected');
        lightCard.classList.remove('selected');
    } else {
        lightCard.classList.add('selected');
        darkCard.classList.remove('selected');
    }
}

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

    // Initialize Theme UI
    const currentTheme = Storage.getTheme();
    updateThemeSelectionUI(currentTheme);

    // Notification Toggles
    const toggleSysNotif = document.getElementById('toggle_sysNotif');
    const toggleLoginAlert = document.getElementById('toggle_loginAlert');

    if (toggleSysNotif) {
        toggleSysNotif.checked = localStorage.getItem('sys_notif_enabled') !== 'false';
        toggleSysNotif.addEventListener('change', () => {
            localStorage.setItem('sys_notif_enabled', toggleSysNotif.checked);
            showToast('Notification preference updated.');
        });
    }

    if (toggleLoginAlert) {
        toggleLoginAlert.checked = localStorage.getItem('login_alert_enabled') !== 'false';
        toggleLoginAlert.addEventListener('change', () => {
            localStorage.setItem('login_alert_enabled', toggleLoginAlert.checked);
            showToast('Login alert preference updated.');
        });
    }

    // Password Update inside Settings
    const savePasswordBtn = document.getElementById('savePasswordBtn');
    if (savePasswordBtn) {
        savePasswordBtn.addEventListener('click', async () => {
            const currentPw = document.getElementById('sec_currentPw')?.value;
            const newPw = document.getElementById('sec_newPw')?.value;
            const confirmPw = document.getElementById('sec_confirmPw')?.value;

            if (!currentPw) {
                showToast('Please enter your current password.', 'error');
                return;
            }
            if (!newPw || newPw.length < 6) {
                showToast('New password must be at least 6 characters.', 'error');
                return;
            }
            if (newPw !== confirmPw) {
                showToast('New passwords do not match.', 'error');
                return;
            }

            try {
                const res = await Auth.fetch('/api/v1/auth/change-password', {
                    method: 'PUT',
                    body: JSON.stringify({
                        current_password: currentPw,
                        new_password: newPw
                    })
                });

                if (res.ok) {
                    showToast('Password updated successfully.');
                    document.getElementById('sec_currentPw').value = '';
                    document.getElementById('sec_newPw').value = '';
                    document.getElementById('sec_confirmPw').value = '';
                } else {
                    const err = await res.json();
                    showToast(err.detail || 'Failed to update password.', 'error');
                }
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }
});
