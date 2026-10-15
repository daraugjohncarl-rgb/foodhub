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

      if (data.must_change_password) {
        // New, reset or default accounts must choose their own password before using the system.
        const changed = await this.promptPasswordChange(password, data.access_token);
        if (!changed) {
          return { success: false, message: "You must set a new password before continuing." };
        }
        data.access_token = changed;
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

  /**
   * Shows a small blocking dialog asking for a new password (min. 10 characters) and calls
   * PUT /api/v1/auth/change-password. Resolves with the fresh token, or null if the user cancels.
   * Built with DOM APIs only (no HTML strings), so nothing here can inject markup.
   */
  promptPasswordChange(currentPassword, token) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:99999;";
      const box = document.createElement("form");
      box.style.cssText = "background:#fff;padding:24px;border-radius:14px;width:min(380px,92vw);font-family:inherit;box-shadow:0 20px 50px rgba(0,0,0,0.25);";
      const title = document.createElement("h3");
      title.textContent = "Choose a new password";
      title.style.cssText = "margin:0 0 6px;font-size:18px;color:#18181b;";
      const hint = document.createElement("p");
      hint.textContent = "Your account uses a temporary password. Set your own (at least 10 characters) to continue.";
      hint.style.cssText = "margin:0 0 14px;font-size:13px;color:#71717a;";
      const mk = (placeholder) => {
        const input = document.createElement("input");
        input.type = "password";
        input.placeholder = placeholder;
        input.required = true;
        input.minLength = 10;
        input.autocomplete = "new-password";
        input.style.cssText = "width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:10px;border:1px solid #d4d4d8;border-radius:8px;font-size:14px;";
        return input;
      };
      const pw1 = mk("New password");
      const pw2 = mk("Repeat new password");
      const error = document.createElement("div");
      error.style.cssText = "color:#ef4444;font-size:13px;min-height:18px;margin-bottom:8px;";
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:10px;justify-content:flex-end;";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.style.cssText = "padding:9px 16px;border-radius:8px;border:1px solid #d4d4d8;background:#fff;cursor:pointer;";
      const save = document.createElement("button");
      save.type = "submit";
      save.textContent = "Save password";
      save.style.cssText = "padding:9px 16px;border-radius:8px;border:none;background:#c9a227;color:#fff;font-weight:700;cursor:pointer;";
      actions.append(cancel, save);
      box.append(title, hint, pw1, pw2, error, actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      pw1.focus();

      cancel.onclick = () => { overlay.remove(); resolve(null); };
      box.onsubmit = async (e) => {
        e.preventDefault();
        if (pw1.value.length < 10) { error.textContent = "Use at least 10 characters."; return; }
        if (pw1.value !== pw2.value) { error.textContent = "The passwords do not match."; return; }
        save.disabled = true;
        try {
          const res = await fetch("/api/v1/auth/change-password", {
            method: "PUT",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            body: JSON.stringify({ current_password: currentPassword, new_password: pw1.value })
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            error.textContent = typeof body.detail === "string" ? body.detail
              : (Array.isArray(body.detail) ? body.detail.map(d => d.msg).join("; ") : "Could not change the password.");
            save.disabled = false;
            return;
          }
          overlay.remove();
          resolve(body.access_token);
        } catch (err) {
          error.textContent = "Server connection failed.";
          save.disabled = false;
        }
      };
    });
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
      if (res.status === 403 && res.headers.get("X-Password-Change-Required") === "1") {
        // The account must set its own password first: send the user back to the login screen.
        alert("Please sign in again and choose a new password to continue.");
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
