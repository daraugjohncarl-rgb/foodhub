// --- AUTHENTICATION & SESSION ---
window.currentUser = null;

function getCurrentUser() {
  if (window.currentUser) return window.currentUser;
  let savedUser = localStorage.getItem("RESTOTRACK_USER") || sessionStorage.getItem("RESTOTRACK_USER");
  if (savedUser) {
    try {
      window.currentUser = JSON.parse(savedUser);
      return window.currentUser;
    } catch(e) {}
  }
  return null;
}

function isAuthenticated() {
  return getCurrentUser() !== null;
}

function getCurrentRole() {
  const user = getCurrentUser();
  return user ? user.role : null;
}

function login(username, password, rememberMe) {
  loadDB(); // Ensure DB is loaded
  const found = DB.users.find(x => x.username === username && x.password === password);
  
  if (found) {
    if (found.status !== "Active") {
      return { success: false, message: "Account deactivated." };
    }
    window.currentUser = found;
    window.currentUser.lastLogin = new Date().toISOString().replace('T', ' ').slice(0, 16);
    saveDB();
    
    if (rememberMe) {
      localStorage.setItem("RESTOTRACK_USER", JSON.stringify(window.currentUser));
    } else {
      sessionStorage.setItem("RESTOTRACK_USER", JSON.stringify(window.currentUser));
    }
    
    logActivity("User Login", "Auth", `Logged in as ${window.currentUser.role}`);
    return { success: true, user: window.currentUser };
  } else {
    return { success: false, message: "Invalid Username or Password!" };
  }
}

function logout() {
  if (typeof confirmAction === 'function') {
    confirmAction("Logout", "Are you sure you want to end your session?", () => {
      executeLogout();
    });
  } else {
    executeLogout();
  }
}

function executeLogout() {
  logActivity("User Logout", "Auth", `Logged out`);
  window.currentUser = null;
  localStorage.removeItem("RESTOTRACK_USER");
  sessionStorage.removeItem("RESTOTRACK_USER");
  window.location.href = "index.html";
}

function requireAuth() {
  if (!isAuthenticated()) {
    window.location.href = "index.html";
  }
}

function getDashboardUrl(role) {
  const rolePages = {
    'admin': 'admin.html',
    'manager': 'manager.html',
    'inventory': 'inventory.html',
    'cashier': 'cashier.html',
    'kitchen': 'kitchen.html'
  };
  return rolePages[role] || 'index.html';
}

function requireRole(expectedRole) {
  requireAuth();
  const currentRole = getCurrentRole();
  if (currentRole !== expectedRole) {
    window.location.href = getDashboardUrl(currentRole);
  }
}
