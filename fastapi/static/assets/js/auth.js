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
        const u = JSON.parse(raw);
        if (u.first_name || u.last_name) {
          const full = [u.first_name, u.last_name].filter(p => p && p.trim()).join(" ");
          if (full) u.name = full;
        }
        return u;
      } catch (e) {}
    }
    const username = localStorage.getItem("username") || "User";
    const fullName = localStorage.getItem("full_name") || username;
    const role = (localStorage.getItem("role") || "").toLowerCase();
    return { username, name: fullName, role };
  },

  getRole() {
    const role = localStorage.getItem("role") || sessionStorage.getItem("role") || "";
    return role.toLowerCase();
  },

  isAuthenticated() {
    const token = this.getToken();
    if (!token) {
      // Check if user session credentials exist in storage or cookie
      const role = this.getRole();
      if (role) return true;
      return false;
    }
    try {
      const parts = token.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        if (payload.exp && Date.now() >= payload.exp * 1000) {
          console.warn("Session expired after 1 day. Logging out.");
          this.logout();
          return false;
        }
      }
    } catch (e) {}
    return true;
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
      case "customer":
        return "/customer";
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
        credentials: "include",
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

      const nameParts = [data.first_name, data.last_name].filter(p => p && p.trim());
      const fullName = nameParts.length > 0 ? nameParts.join(" ") : data.username;

      const storage = rememberMe ? localStorage : sessionStorage;
      storage.setItem("access_token", data.access_token);
      storage.setItem("username", data.username);
      storage.setItem("role", data.role);
      storage.setItem("first_name", data.first_name || "");
      storage.setItem("last_name", data.last_name || "");
      storage.setItem("full_name", fullName);
      storage.setItem("tenant_id", data.tenant_id !== null ? data.tenant_id : "GLOBAL");

      const userProfile = {
        username: data.username,
        name: fullName,
        first_name: data.first_name,
        last_name: data.last_name,
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
        redirect_url: data.redirect_url || this.getDashboardUrl(data.role),
        user: userProfile
      };
    } catch (err) {
      return { success: false, message: "Server connection failed. Please verify API is online." };
    }
  },

  async registerCustomer(payload) {
    try {
      const response = await fetch("/api/v1/auth/customer-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) {
        return { success: false, message: data.detail || "Registration failed" };
      }
      localStorage.setItem("access_token", data.access_token);
      localStorage.setItem("username", data.username);
      localStorage.setItem("role", "customer");
      localStorage.setItem("tenant_id", data.tenant_id || 1);
      const userProfile = {
        username: data.username,
        name: data.customer_name || data.username,
        role: "customer",
        tenant_id: data.tenant_id
      };
      localStorage.setItem("RESTOTRACK_USER", JSON.stringify(userProfile));
      localStorage.setItem("customer_name", data.customer_name || data.username);
      return { success: true, user: userProfile, message: data.message };
    } catch (e) {
      return { success: false, message: "Server connection failed." };
    }
  },

  async logout() {
    const token = this.getToken();

    // 1. Immediately wipe all client credentials to instantly terminate session
    localStorage.removeItem("access_token");
    localStorage.removeItem("username");
    localStorage.removeItem("role");
    localStorage.removeItem("tenant_id"); 
    localStorage.removeItem("first_name");
    localStorage.removeItem("last_name");
    localStorage.removeItem("full_name");
    localStorage.removeItem("RESTOTRACK_USER");
    localStorage.removeItem("RESTOTRACK_ROLE");
    sessionStorage.clear();

    // 2. Clear client-accessible cookies
    document.cookie = "session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;";

    // 3. Dispatch server logout notification with keepalive (browser guarantees execution without blocking UI)
    try {
      fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token || ""}`,
          "Content-Type": "application/json"
        },
        credentials: "include",
        keepalive: true
      }).catch(() => {});
    } catch (e) {}

    // 4. Instant redirect to login with confirmation
    window.location.replace("/login?logged_out=1");
  },

  /**
   * Authenticated Fetch Wrapper
   * Automatically attaches Bearer token, passes session cookies, and intercepts 401s
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
      headers,
      credentials: "include"
    };

    try {
      const res = await fetch(url, config);
      if (res.status === 401) {
        let errorDetail = "";
        try {
          const clone = res.clone();
          const errData = await clone.json();
          errorDetail = errData.detail || "";
        } catch (e) {}

        console.warn("Session expired or unauthorized (401).", errorDetail);
        if (errorDetail && errorDetail.toLowerCase().includes("another device")) {
          alert("Notice: Your account was logged in from another device. You have been automatically logged out on this device.");
        }
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
async function requireRoleAsync(allowedRoles = []) {
  // If local credentials missing, fast-restore from server session cookie
  if (!Auth.getToken() || !Auth.getRole()) {
    try {
      const res = await fetch("/api/v1/auth/session", { credentials: "include" });
      if (res.ok) {
        const sData = await res.json();
        if (sData.authenticated && sData.user) {
          const u = sData.user;
          const role = (u.role || "").toLowerCase();
          localStorage.setItem("role", role);
          localStorage.setItem("username", u.username);
          if (u.tenant_id) localStorage.setItem("tenant_id", u.tenant_id);
          const fullName = [u.first_name, u.last_name].filter(p => p && p.trim()).join(" ") || u.username;
          localStorage.setItem("full_name", fullName);
          const userProfile = {
            id: u.id,
            username: u.username,
            name: fullName,
            first_name: u.first_name,
            last_name: u.last_name,
            role: role,
            tenant_id: u.tenant_id
          };
          localStorage.setItem("RESTOTRACK_USER", JSON.stringify(userProfile));
          localStorage.setItem("RESTOTRACK_ROLE", role);
        }
      }
    } catch (e) {}
  }
  return requireRole(allowedRoles);
}

function requireRole(allowedRoles = []) {
  const currentRole = Auth.getRole();
  const normalizedAllowed = allowedRoles.map(r => r.toLowerCase());

  if (!Auth.isAuthenticated() && !currentRole) {
    window.location.href = "/";
    return null;
  }

  // SUPER_ADMIN has master access to admin views
  if (currentRole === "super_admin" && normalizedAllowed.includes("admin")) {
    return Auth.getUser();
  }

  if (currentRole && !normalizedAllowed.includes(currentRole)) {
    alert(`Access Denied: Your account role (${currentRole}) is not permitted on this dashboard.`);
    window.location.href = Auth.getDashboardUrl(currentRole);
    return null;
  }

  const user = Auth.getUser();
  // Populate UI tags if present on page
  const nameEl = document.getElementById("nav-user-name");
  const roleEl = document.getElementById("nav-user-role");
  const avatarEl = document.getElementById("nav-user-avatar");
  const sidebarName = document.getElementById("sidebarName");

  const displayName = user.name || user.username || "User";
  if (nameEl) nameEl.innerText = displayName;
  if (sidebarName) sidebarName.innerText = displayName;
  if (roleEl) roleEl.innerText = currentRole;
  if (avatarEl) avatarEl.innerText = displayName.charAt(0).toUpperCase();

  // Asynchronously fetch profile from /api/v1/auth/me to guarantee first and last name are loaded
  if (Auth.isAuthenticated()) {
    Auth.fetch("/api/v1/auth/me").then(res => res.json()).then(data => {
      if (data) {
        const parts = [data.first_name, data.last_name].filter(p => p && p.trim());
        const resolvedName = parts.length > 0 ? parts.join(" ") : (data.username || displayName);
        user.name = resolvedName;
        user.first_name = data.first_name;
        user.last_name = data.last_name;
        localStorage.setItem("RESTOTRACK_USER", JSON.stringify(user));
        localStorage.setItem("full_name", resolvedName);
        if (nameEl) nameEl.innerText = resolvedName;
        const sbEl = document.getElementById("sidebarName");
        if (sbEl) sbEl.innerText = resolvedName;
      }
    }).catch(() => {});
  }

  return user;
}

// Global helpers
Auth.requireRole = requireRole;
Auth.requireRoleAsync = requireRoleAsync;
window.Auth = Auth;
window.requireRole = requireRole;
window.requireRoleAsync = requireRoleAsync;
window.logout = () => Auth.logout();

// Periodic session heartbeat: validates single-device session and 1-day expiration in background
if (typeof window !== "undefined") {
  setInterval(async () => {
    if (Auth.isAuthenticated() && window.location.pathname !== "/" && window.location.pathname !== "/index.html" && window.location.pathname !== "/login") {
      try {
        await Auth.fetch("/api/v1/auth/me");
      } catch (e) {}
    }
  }, 45000);
}
