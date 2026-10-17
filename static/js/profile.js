/**
 * Profile Controller (profile.js)
 * Manages user profile display, edits, and password changes.
 */
function toggleProfilePw(fieldId, btn) {
    const input = document.getElementById(fieldId);
    if (!input) return;
    const icon = btn.querySelector('i');
    if (input.type === 'password') {
        input.type = 'text';
        if (icon) icon.className = 'fas fa-eye-slash';
    } else {
        input.type = 'password';
        if (icon) icon.className = 'fas fa-eye';
    }
}

document.addEventListener('DOMContentLoaded', async () => {
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

    // Tab Switching
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-tab');
            tabBtns.forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            const targetContent = document.getElementById(`tab-${target}`);
            if (targetContent) targetContent.classList.add('active');
        });
    });

    // Helper: Generate Initials
    function getInitials(name) {
        if (!name) return 'SA';
        const parts = name.trim().split(/[\s_.-]+/);
        if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    // Load Profile Info
    async function loadProfile() {
        try {
            const res = await Auth.fetch('/api/v1/auth/me');
            if (res.ok) {
                const user = await res.json();
                Storage.setUser(user);

                const fullName = user.first_name && user.last_name ? `${user.first_name} ${user.last_name}` : user.username;
                const initials = getInitials(fullName);

                // Update Top/Sidebar elements
                const sidebarName = document.getElementById('sidebarName');
                const sidebarAvatar = document.getElementById('sidebarAvatar');
                const headerAvatar = document.getElementById('headerAvatar');
                if (sidebarName) sidebarName.textContent = fullName;
                if (sidebarAvatar) sidebarAvatar.textContent = initials;
                if (headerAvatar) headerAvatar.textContent = initials;

                // Update Profile Card elements
                const profileName = document.getElementById('profileName');
                const profileEmail = document.getElementById('profileEmail');
                const profilePhone = document.getElementById('profilePhone');
                const profileSince = document.getElementById('profileSince');

                if (profileName) profileName.textContent = fullName;
                if (profileEmail) profileEmail.textContent = user.email || 'No email specified';
                if (profilePhone) profilePhone.textContent = user.phone || 'No phone specified';
                if (profileSince) {
                    profileSince.textContent = user.created_at ? `Member since ${new Date(user.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : 'Member';
                }

                // Populate Form Fields
                const pf_firstName = document.getElementById('pf_firstName');
                const pf_lastName = document.getElementById('pf_lastName');
                const pf_email = document.getElementById('pf_email');
                const pf_phone = document.getElementById('pf_phone');

                if (pf_firstName) pf_firstName.value = user.first_name || '';
                if (pf_lastName) pf_lastName.value = user.last_name || '';
                if (pf_email) pf_email.value = user.email || '';
                if (pf_phone) pf_phone.value = user.phone || '';
            }
        } catch (err) {
            console.error('Failed to load profile data:', err);
        }
    }

    // Save Profile Changes
    const saveProfileBtn = document.getElementById('saveProfileBtn');
    if (saveProfileBtn) {
        saveProfileBtn.addEventListener('click', async () => {
            const firstName = document.getElementById('pf_firstName')?.value.trim();
            const lastName = document.getElementById('pf_lastName')?.value.trim();
            const email = document.getElementById('pf_email')?.value.trim();
            const phone = document.getElementById('pf_phone')?.value.trim();

            try {
                const res = await Auth.fetch('/api/v1/auth/me', {
                    method: 'PUT',
                    body: JSON.stringify({
                        first_name: firstName || null,
                        last_name: lastName || null,
                        email: email || null,
                        phone: phone || null
                    })
                });

                if (res.ok) {
                    showToast('Profile updated successfully.');
                    loadProfile();
                } else {
                    const err = await res.json();
                    showToast(err.detail || 'Failed to update profile.', 'error');
                }
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // Change Password
    const changePasswordBtn = document.getElementById('changePasswordBtn');
    if (changePasswordBtn) {
        changePasswordBtn.addEventListener('click', async () => {
            const currentPw = document.getElementById('pf_currentPw')?.value;
            const newPw = document.getElementById('pf_newPw')?.value;
            const confirmPw = document.getElementById('pf_confirmPw')?.value;

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
                    showToast('Password changed successfully.');
                    document.getElementById('pf_currentPw').value = '';
                    document.getElementById('pf_newPw').value = '';
                    document.getElementById('pf_confirmPw').value = '';
                } else {
                    const err = await res.json();
                    showToast(err.detail || 'Failed to change password.', 'error');
                }
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    loadProfile();
});
