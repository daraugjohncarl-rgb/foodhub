/**
 * User Management Controller (users.js)
 * Connects User Lists page to FastAPI backend endpoints.
 */
document.addEventListener('DOMContentLoaded', () => {
    let currentPage = 1;
    const pageSize = 10;
    let totalUsersCount = 0;
    let selectedUserId = null;
    let cachedUsers = [];

    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = '';
    }
    const roleFilter = document.getElementById('roleFilter');
    const statusFilter = document.getElementById('statusFilter');
    const usersTableBody = document.getElementById('usersTableBody');
    const userCountEl = document.getElementById('userCount');
    const pageInfoEl = document.getElementById('pageInfo');
    const prevPageBtn = document.getElementById('prevPage');
    const nextPageBtn = document.getElementById('nextPage');
    const pageNumbersEl = document.getElementById('pageNumbers');

    // Sidebar & Navigation helpers
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

    // Helper: Generate Initials
    function getInitials(name) {
        if (!name) return 'U';
        const parts = name.trim().split(/[\s_.-]+/);
        if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    // Fetch and render users
    async function loadUsers() {
        if (!usersTableBody) return;
        usersTableBody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted);">
                    <i class="fas fa-spinner fa-spin" style="margin-right:8px;"></i> Loading users...
                </td>
            </tr>
        `;

        const query = searchInput ? searchInput.value.trim() : '';
        const role = roleFilter ? roleFilter.value : '';
        const status = statusFilter ? statusFilter.value : '';
        const offset = (currentPage - 1) * pageSize;

        const params = new URLSearchParams();
        params.append('limit', pageSize);
        params.append('offset', offset);
        params.append('exclude_self', 'true');
        if (query) params.append('q', query);
        if (role) params.append('role', role);
        if (status) params.append('status', status);

        try {
            // Load stats & users in parallel
            const [usersRes, statsRes] = await Promise.all([
                Auth.fetch(`/api/v1/users?${params.toString()}`),
                Auth.fetch(`/api/v1/users/stats`)
            ]);

            if (statsRes && statsRes.ok) {
                const stats = await statsRes.json();
                const totalEl = document.getElementById('statTotalUsers');
                const adminsEl = document.getElementById('statAdmins');
                const cashiersEl = document.getElementById('statCashiers');
                const kitchenInvEl = document.getElementById('statKitchenInv');

                if (totalEl) totalEl.textContent = stats.total_users || 0;
                if (adminsEl) adminsEl.textContent = (stats.admins || 0) + (stats.managers || 0);
                if (cashiersEl) cashiersEl.textContent = stats.cashiers || 0;
                if (kitchenInvEl) kitchenInvEl.textContent = (stats.kitchen || 0) + (stats.inventory || 0);
            }

            if (usersRes.ok) {
                const users = await usersRes.json();
                cachedUsers = users;
                totalUsersCount = users.length;

                if (userCountEl) userCountEl.textContent = `${users.length} users`;
                if (pageInfoEl) pageInfoEl.textContent = `Showing ${users.length > 0 ? offset + 1 : 0}–${offset + users.length}`;

                if (users.length === 0) {
                    usersTableBody.innerHTML = `
                        <tr>
                            <td colspan="6" style="text-align:center; padding:40px; color:var(--text-muted);">
                                No users match your search criteria.
                            </td>
                        </tr>
                    `;
                    return;
                }

                usersTableBody.innerHTML = users.map(user => {
                    const initials = getInitials(user.first_name && user.last_name ? `${user.first_name} ${user.last_name}` : user.username);
                    const displayName = user.first_name && user.last_name ? `${user.first_name} ${user.last_name}` : user.username;
                    const roleLower = (user.role || 'cashier').toLowerCase();
                    const formattedRole = (user.role || 'CASHIER').replace('_', ' ');
                    const createdDate = user.created_at ? new Date(user.created_at).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric'
                    }) : '—';

                    return `
                        <tr>
                            <td>
                                <div class="user-cell">
                                    <div class="user-avatar">${initials}</div>
                                    <div>
                                        <div class="user-info-name">${displayName}</div>
                                        <div class="user-info-email">${user.email || user.username}</div>
                                    </div>
                                </div>
                            </td>
                            <td>${user.phone || '—'}</td>
                            <td><span class="badge badge-${roleLower}">${formattedRole}</span></td>
                            <td>
                                <span class="${user.is_active ? 'status-active' : 'status-inactive'}">
                                    ${user.is_active ? 'Active' : 'Inactive'}
                                </span>
                            </td>
                            <td style="color:var(--text-muted); font-size:13px;">${createdDate}</td>
                            <td>
                                <div class="action-btns">
                                    <button class="btn btn-outline" style="padding:6px 10px; height:32px; font-size:12px;" onclick="openViewModal(${user.id})" title="View Details">
                                        <i class="fas fa-eye"></i>
                                    </button>
                                    <button class="btn btn-outline" style="padding:6px 10px; height:32px; font-size:12px;" onclick="openEditModal(${user.id})" title="Edit User">
                                        <i class="fas fa-edit"></i>
                                    </button>
                                    <button class="btn btn-outline" style="padding:6px 10px; height:32px; font-size:12px;" onclick="openResetPwModal(${user.id})" title="Reset Password">
                                        <i class="fas fa-key"></i>
                                    </button>
                                    <button class="btn btn-outline" style="padding:6px 10px; height:32px; font-size:12px; color:${user.is_active ? 'var(--warning)' : 'var(--success)'};" onclick="openDeactivateModal(${user.id}, ${user.is_active})" title="${user.is_active ? 'Deactivate' : 'Activate'}">
                                        <i class="fas fa-${user.is_active ? 'user-slash' : 'user-check'}"></i>
                                    </button>
                                    <button class="btn btn-danger" style="padding:6px 10px; height:32px; font-size:12px;" onclick="openDeleteModal(${user.id})" title="Delete User">
                                        <i class="fas fa-trash"></i>
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `;
                }).join('');
            }
        } catch (err) {
            console.error('Failed to load users:', err);
            usersTableBody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align:center; padding:30px; color:var(--danger);">
                        Failed to load user list from server.
                    </td>
                </tr>
            `;
        }
    }

    // Modal Actions
    window.openViewModal = (id) => {
        const user = cachedUsers.find(u => u.id === id);
        if (!user) return;
        selectedUserId = id;

        const body = document.getElementById('viewModalBody');
        if (body) {
            body.innerHTML = `
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; font-size:13px;">
                    <div><strong>Username:</strong> <div>${user.username}</div></div>
                    <div><strong>Full Name:</strong> <div>${user.first_name || ''} ${user.last_name || ''}</div></div>
                    <div><strong>Email:</strong> <div>${user.email || '—'}</div></div>
                    <div><strong>Phone:</strong> <div>${user.phone || '—'}</div></div>
                    <div><strong>Role:</strong> <div><span class="badge badge-${(user.role || '').toLowerCase()}">${user.role}</span></div></div>
                    <div><strong>Status:</strong> <div>${user.is_active ? 'Active' : 'Inactive'}</div></div>
                    <div><strong>Created At:</strong> <div>${new Date(user.created_at).toLocaleString()}</div></div>
                </div>
            `;
        }
        document.getElementById('viewModal').style.display = 'flex';
    };

    const viewEditBtn = document.getElementById('viewEditBtn');
    if (viewEditBtn) {
        viewEditBtn.addEventListener('click', () => {
            closeModal('viewModal');
            if (selectedUserId) openEditModal(selectedUserId);
        });
    }

    window.openEditModal = (id) => {
        const user = cachedUsers.find(u => u.id === id);
        if (!user) return;
        selectedUserId = id;

        const body = document.getElementById('editModalBody');
        if (body) {
            body.innerHTML = `
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                    <div class="input-group">
                        <label>First Name</label>
                        <input class="input-field" id="edit_first_name" value="${user.first_name || ''}" placeholder="First name">
                    </div>
                    <div class="input-group">
                        <label>Last Name</label>
                        <input class="input-field" id="edit_last_name" value="${user.last_name || ''}" placeholder="Last name">
                    </div>
                    <div class="input-group">
                        <label>Email</label>
                        <input class="input-field" type="email" id="edit_email" value="${user.email || ''}" placeholder="Email">
                    </div>
                    <div class="input-group">
                        <label>Phone</label>
                        <input class="input-field" id="edit_phone" value="${user.phone || ''}" placeholder="Phone">
                    </div>
                    <div class="input-group">
                        <label>Role</label>
                        <select class="input-field" id="edit_role">
                            <option value="ADMIN" ${user.role === 'ADMIN' ? 'selected' : ''}>Admin</option>
                            <option value="MANAGER" ${user.role === 'MANAGER' ? 'selected' : ''}>Manager</option>
                            <option value="INVENTORY" ${user.role === 'INVENTORY' ? 'selected' : ''}>Inventory Staff</option>
                            <option value="CASHIER" ${user.role === 'CASHIER' ? 'selected' : ''}>Cashier</option>
                            <option value="KITCHEN" ${user.role === 'KITCHEN' ? 'selected' : ''}>Kitchen Staff</option>
                        </select>
                    </div>
                    <div class="input-group">
                        <label>Status</label>
                        <select class="input-field" id="edit_status">
                            <option value="true" ${user.is_active ? 'selected' : ''}>Active</option>
                            <option value="false" ${!user.is_active ? 'selected' : ''}>Inactive</option>
                        </select>
                    </div>
                </div>
            `;
        }
        document.getElementById('editModal').style.display = 'flex';
    };

    const saveEditBtn = document.getElementById('saveEditBtn');
    if (saveEditBtn) {
        saveEditBtn.addEventListener('click', async () => {
            if (!selectedUserId) return;
            const updatedData = {
                first_name: document.getElementById('edit_first_name')?.value.trim() || null,
                last_name: document.getElementById('edit_last_name')?.value.trim() || null,
                email: document.getElementById('edit_email')?.value.trim() || null,
                phone: document.getElementById('edit_phone')?.value.trim() || null,
                role: document.getElementById('edit_role')?.value,
                is_active: document.getElementById('edit_status')?.value === 'true'
            };

            try {
                const res = await Auth.fetch(`/api/v1/users/${selectedUserId}`, {
                    method: 'PUT',
                    body: JSON.stringify(updatedData)
                });
                if (res.ok) {
                    showToast('User details updated successfully.');
                    closeModal('editModal');
                    loadUsers();
                } else {
                    const err = await res.json();
                    showToast(err.detail || 'Failed to update user.', 'error');
                }
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // Reset Password Modal
    window.openResetPwModal = (id) => {
        selectedUserId = id;
        document.getElementById('newPwInput').value = '';
        document.getElementById('confirmPwInput').value = '';
        document.getElementById('resetPwModal').style.display = 'flex';
    };

    const saveResetPwBtn = document.getElementById('saveResetPwBtn');
    if (saveResetPwBtn) {
        saveResetPwBtn.addEventListener('click', async () => {
            const newPw = document.getElementById('newPwInput')?.value;
            const confirmPw = document.getElementById('confirmPwInput')?.value;

            if (!newPw || newPw.length < 6) {
                showToast('Password must be at least 6 characters.', 'error');
                return;
            }
            if (newPw !== confirmPw) {
                showToast('Passwords do not match.', 'error');
                return;
            }

            try {
                const res = await Auth.fetch(`/api/v1/users/${selectedUserId}/password`, {
                    method: 'PUT',
                    body: JSON.stringify({ new_password: newPw })
                });
                if (res.ok) {
                    showToast('Password reset successfully.');
                    closeModal('resetPwModal');
                } else {
                    const err = await res.json();
                    showToast(err.detail || 'Failed to reset password.', 'error');
                }
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // Deactivate Modal
    window.openDeactivateModal = (id, isActive) => {
        selectedUserId = id;
        const title = document.getElementById('deactivateModalTitle');
        if (title) title.textContent = isActive ? 'Deactivate User?' : 'Activate User?';
        document.getElementById('deactivateModal').style.display = 'flex';
    };

    const confirmDeactivateBtn = document.getElementById('confirmDeactivateBtn');
    if (confirmDeactivateBtn) {
        confirmDeactivateBtn.addEventListener('click', async () => {
            if (!selectedUserId) return;
            try {
                const res = await Auth.fetch(`/api/v1/users/${selectedUserId}/status`, { method: 'PUT' });
                if (res.ok) {
                    showToast('User status updated successfully.');
                    closeModal('deactivateModal');
                    loadUsers();
                }
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // Delete Modal
    window.openDeleteModal = (id) => {
        selectedUserId = id;
        document.getElementById('deleteModal').style.display = 'flex';
    };

    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', async () => {
            if (!selectedUserId) return;
            try {
                const res = await Auth.fetch(`/api/v1/users/${selectedUserId}`, { method: 'DELETE' });
                if (res.ok) {
                    showToast('User deleted successfully.');
                    closeModal('deleteModal');
                    loadUsers();
                }
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // Event Listeners for Filters
    let debounceTimer;
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                currentPage = 1;
                loadUsers();
            }, 300);
        });
    }

    if (roleFilter) {
        roleFilter.addEventListener('change', () => {
            currentPage = 1;
            loadUsers();
        });
    }

    if (statusFilter) {
        statusFilter.addEventListener('change', () => {
            currentPage = 1;
            loadUsers();
        });
    }

    if (prevPageBtn) {
        prevPageBtn.addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                loadUsers();
            }
        });
    }

    if (nextPageBtn) {
        nextPageBtn.addEventListener('click', () => {
            if (totalUsersCount >= pageSize) {
                currentPage++;
                loadUsers();
            }
        });
    }

    // Initial Load & Autofill wipe
    if (searchInput) searchInput.value = '';
    loadUsers();

    // Prevent browser password managers from auto-populating credentials into search box
    [100, 300, 600, 1000].forEach(delay => {
        setTimeout(() => {
            if (searchInput && searchInput.value) {
                searchInput.value = '';
                currentPage = 1;
                loadUsers();
            }
        }, delay);
    });
});
