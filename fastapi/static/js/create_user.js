/**
 * Create User Controller (create_user.js)
 * Validates and submits new user account creation to FastAPI backend.
 */
function togglePw(fieldId, btn) {
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

    // Populate Sidebar User info
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

    // Avatar preview
    const photoInput = document.getElementById('photoInput');
    const avatarPreview = document.getElementById('avatarPreview');
    if (photoInput && avatarPreview) {
        photoInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => avatarPreview.src = event.target.result;
                reader.readAsDataURL(file);
            }
        });
    }

    // Form submission
    const createUserBtn = document.getElementById('createUserBtn');
    if (createUserBtn) {
        createUserBtn.addEventListener('click', async (e) => {
            e.preventDefault();

            // Clear errors
            document.querySelectorAll('.field-error').forEach(el => el.classList.remove('show'));
            document.querySelectorAll('.input-field').forEach(el => el.classList.remove('invalid'));

            const username = document.getElementById('cu_username')?.value.trim();
            const firstName = document.getElementById('cu_firstName')?.value.trim();
            const lastName = document.getElementById('cu_lastName')?.value.trim();
            const middleName = document.getElementById('cu_middleName')?.value.trim();
            const phone = document.getElementById('cu_phone')?.value.trim();
            const email = document.getElementById('cu_email')?.value.trim();
            const password = document.getElementById('cu_password')?.value;
            const confirm = document.getElementById('cu_confirm')?.value;
            const role = document.getElementById('cu_role')?.value;
            const status = document.getElementById('cu_status')?.value;

            let hasError = false;

            if (!username) {
                document.getElementById('err_username')?.classList.add('show');
                document.getElementById('cu_username')?.classList.add('invalid');
                hasError = true;
            }
            if (!firstName) {
                document.getElementById('err_firstName')?.classList.add('show');
                document.getElementById('cu_firstName')?.classList.add('invalid');
                hasError = true;
            }
            if (!lastName) {
                document.getElementById('err_lastName')?.classList.add('show');
                document.getElementById('cu_lastName')?.classList.add('invalid');
                hasError = true;
            }
            if (!email || !email.includes('@')) {
                document.getElementById('err_email')?.classList.add('show');
                document.getElementById('cu_email')?.classList.add('invalid');
                hasError = true;
            }
            if (!password || password.length < 6) {
                document.getElementById('err_password')?.classList.add('show');
                document.getElementById('cu_password')?.classList.add('invalid');
                hasError = true;
            }
            if (password !== confirm) {
                document.getElementById('err_confirm')?.classList.add('show');
                document.getElementById('cu_confirm')?.classList.add('invalid');
                hasError = true;
            }
            if (!role) {
                document.getElementById('err_role')?.classList.add('show');
                document.getElementById('cu_role')?.classList.add('invalid');
                hasError = true;
            }

            if (hasError) return;

            createUserBtn.disabled = true;
            createUserBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating User...';

            // Role formatting
            const cleanRole = role.replace('_STAFF', '');

            const payload = {
                username: username,
                first_name: firstName,
                last_name: lastName,
                email: email,
                phone: phone || null,
                password: password,
                role: cleanRole,
                is_active: status === 'Active'
            };

            try {
                const res = await Auth.fetch('/api/v1/users', {
                    method: 'POST',
                    body: JSON.stringify(payload)
                });

                if (res.ok) {
                    showToast('User created successfully! Redirecting...');
                    setTimeout(() => {
                        window.location.href = 'users.html';
                    }, 1200);
                } else {
                    const err = await res.json();
                    showToast(err.detail || 'Failed to create user account.', 'error');
                }
            } catch (err) {
                showToast(err.message, 'error');
            } finally {
                createUserBtn.disabled = false;
                createUserBtn.innerHTML = '<i class="fas fa-user-plus"></i> Create User';
            }
        });
    }
});
