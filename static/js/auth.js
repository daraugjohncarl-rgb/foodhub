/**
 * Centralized Authentication & API Fetch Wrapper
 * Blessie FoodHub / RestoTrack Multi-Role Dashboard
 */

const Auth = {
  getToken() {
    return localStorage.getItem("access_token") || sessionStorage.getItem("access_token");
  },

  getUser() {
    const raw = localStorage.getItem("RESTOTRACK_USER") || sessionStorage.getItem("RESTOTRACK_USER");
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch (e) {}
    }
    const username = localStorage.getItem("username") || "User";
    const role = (localStorage.getItem("role") || "").toLowerCase();
    return { username, name: username, role };
  },

  getRole() {
    const role = localStorage.getItem("role") || sessionStorage.getItem("role") || "";
    return role.toLowerCase();
  },

  isAuthenticated() {
    return !!this.getToken();
  },

  getDashboardUrl(role) {
    const r = (role || "").toLowerCase();
    switch (r) {
      case "super_admin":
        return "/dashboard";
      case "admin":
        return "/admin";
      case "manager":
        return "/manager";
      case "inventory":
        return "/inventory";
      case "cashier":
        return "/cashier";
      case "kitchen":
        return "/kitchen";
      default:
        return "/";
    }
  },

  async login(username, password, rememberMe = true) {
    const params = new URLSearchParams();
    params.append("username", username);
    params.append("password", password);

    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params
      });

      const data = await response.json();

      if (!response.ok) {
        let msg = "Invalid username or password.";
        if (typeof data.detail === "string") {
          msg = data.detail;
        } else if (Array.isArray(data.detail) && data.detail.length > 0) {
          msg = data.detail.map(e => e.msg || JSON.stringify(e)).join("; ");
        }
        return { success: false, message: msg };
      }

      const storage = rememberMe ? localStorage : sessionStorage;
      storage.setItem("access_token", data.access_token);
      storage.setItem("username", data.username);
      storage.setItem("role", data.role);
      storage.setItem("tenant_id", data.tenant_id !== null ? data.tenant_id : "GLOBAL");

      const userProfile = {
        username: data.username,
        name: data.username,
        role: (data.role || "").toLowerCase(),
        tenant_id: data.tenant_id
      };
      storage.setItem("RESTOTRACK_USER", JSON.stringify(userProfile));

      // Also mirror in localStorage for persistent background listeners
      localStorage.setItem("RESTOTRACK_ROLE", (data.role || "").toLowerCase());

      return {
        success: true,
        token: data.access_token,
        role: (data.role || "").toLowerCase(),
        user: userProfile
      };
    } catch (err) {
      return { success: false, message: "Server connection failed. Please verify API is online." };
    }
  },

  logout() {
    localStorage.removeItem("access_token");
    localStorage.removeItem("username");
    localStorage.removeItem("role");
    localStorage.removeItem("tenant_id"); 
    localStorage.removeItem("RESTOTRACK_USER");
    localStorage.removeItem("RESTOTRACK_ROLE");
    sessionStorage.clear();
    window.location.href = "/";
  },

  /**
   * Authenticated Fetch Wrapper
   * Automatically attaches Bearer token and intercepts 401s
   */
  async fetch(url, options = {}) {
    const token = this.getToken();
    const headers = Object.assign({}, options.headers || {});

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    if (!headers["Content-Type"] && !(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }

    const config = {
      ...options,
      headers
    };

    try {
      const res = await fetch(url, config);
      if (res.status === 401) {
        console.warn("Session expired or unauthorized (401). Redirecting to login.");
        this.logout();
        throw new Error("Unauthorized");
      }
      return res;
    } catch (err) {
      if (err.message !== "Unauthorized") {
        console.error(`API Fetch failed for ${url}:`, err);
      }
      throw err;
    }
  }
};

/**
 * Route Guard for Role Dashboard Shells
 */
function requireRole(allowedRoles = []) {
  if (!Auth.isAuthenticated()) {
    window.location.href = "/";
    return null;
  }

  const currentRole = Auth.getRole();
  const normalizedAllowed = allowedRoles.map(r => r.toLowerCase());

  // SUPER_ADMIN has master access to admin views
  if (currentRole === "super_admin" && normalizedAllowed.includes("admin")) {
    return Auth.getUser();
  }

  if (!normalizedAllowed.includes(currentRole)) {
    alert(`Access Denied: Your account role (${currentRole}) is not permitted on this dashboard.`);
    window.location.href = Auth.getDashboardUrl(currentRole);
    return null;
  }

  const user = Auth.getUser();
  // Populate UI tags if present on page
  const nameEl = document.getElementById("nav-user-name");
  const roleEl = document.getElementById("nav-user-role");
  const avatarEl = document.getElementById("nav-user-avatar");

  if (nameEl) nameEl.innerText = user.name || user.username;
  if (roleEl) roleEl.innerText = currentRole;
  if (avatarEl) avatarEl.innerText = (user.name || user.username || "U").charAt(0).toUpperCase();

  return user;
}

// Global helpers
Auth.requireRole = requireRole;
window.Auth = Auth;
window.requireRole = requireRole;
window.logout = () => Auth.logout();
