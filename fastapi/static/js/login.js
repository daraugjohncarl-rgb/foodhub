try { localStorage.removeItem("access_token"); sessionStorage.removeItem("access_token"); } catch (e) {} // legacy JWT copies are purged: the session lives only in the HttpOnly cookie
// Password Toggle Functionality
function togglePassword() {
    const input = document.getElementById("passwordInput");
    const toggleIcon = document.getElementById("toggleIcon");
    if (!input || !toggleIcon) return;

    if (input.type === "password") {
        input.type = "text";
        toggleIcon.className = "fas fa-eye-slash";
    } else {
        input.type = "password";
        toggleIcon.className = "fas fa-eye";
    }
}

// Role Dashboard URL helper
function getRoleDashboardUrl(role) {
    if (typeof Auth !== "undefined" && typeof Auth.getDashboardUrl === "function") {
        return Auth.getDashboardUrl(role);
    }
    const r = (role || "").toLowerCase();
    switch (r) {
        case "super_admin": return "/dashboard";
        case "admin": return "/admin";
        case "manager": return "/manager";
        case "inventory": return "/inventory";
        case "cashier": return "/cashier";
        case "kitchen": return "/kitchen";
        default: return "/dashboard";
    }
}

function initLoginApp() {
    // If already logged in, redirect directly to user's assigned dashboard
    // Live sessions are redirected away from /login by the server (cookie check); stored UI state is not trusted here.

    const loginForm = document.getElementById("loginForm");
    const usernameInput = document.getElementById("usernameInput");
    const passwordInput = document.getElementById("passwordInput");
    const rememberMeCheckbox = document.getElementById("rememberMe");
    const errorBanner = document.getElementById("errorBanner");
    const errorMessage = document.getElementById("errorMessage");
    const signinBtn = document.getElementById("signinBtn");
    const signinBtnText = document.getElementById("signinBtnText");
    const signinSpinner = document.getElementById("signinSpinner");
    const signinIcon = document.getElementById("signinIcon");

    // Load saved username if Remember Me was previously checked
    const savedUser = localStorage.getItem("remembered_user");
    if (savedUser && usernameInput) {
        usernameInput.value = savedUser;
        if (rememberMeCheckbox) rememberMeCheckbox.checked = true;
    }

    if (!loginForm) return;

    loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        // Clear error display
        if (errorBanner) errorBanner.style.display = "none";

        // Set button loading state
        if (signinBtn) signinBtn.disabled = true;
        if (signinBtnText) signinBtnText.textContent = "Signing In...";
        if (signinSpinner) signinSpinner.style.display = "inline-block";
        if (signinIcon) signinIcon.style.display = "none";

        const username = usernameInput ? usernameInput.value.trim() : "";
        const password = passwordInput ? passwordInput.value : "";

        // Build URL encoded parameters for OAuth2PasswordRequestForm
        const params = new URLSearchParams();
        params.append("username", username);
        params.append("password", password);

        try {
            const response = await fetch("/api/v1/auth/login", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: params,
            });

            const data = await response.json();

            if (!response.ok) {
                let errorMsg = "Incorrect username, email, or password.";
                if (typeof data.detail === "string") {
                    errorMsg = data.detail;
                } else if (Array.isArray(data.detail) && data.detail.length > 0) {
                    errorMsg = data.detail.map((e) => e.msg || JSON.stringify(e)).join("; ");
                } else if (data.message) {
                    errorMsg = data.message;
                }
                throw new Error(errorMsg);
            }

            // Handle Remember Me storage
            if (rememberMeCheckbox && rememberMeCheckbox.checked) {
                localStorage.setItem("remembered_user", username);
            } else {
                localStorage.removeItem("remembered_user");
            }

            // Cache Authentication session
            localStorage.setItem("username", data.username);
            localStorage.setItem("role", data.role);
            localStorage.setItem("tenant_id", data.tenant_id !== null ? data.tenant_id : "GLOBAL");

            const userProfile = {
                username: data.username,
                name: data.username,
                role: (data.role || "").toLowerCase(),
                tenant_id: data.tenant_id
            };
            localStorage.setItem("RESTOTRACK_USER", JSON.stringify(userProfile));
            localStorage.setItem("RESTOTRACK_ROLE", (data.role || "").toLowerCase());

            // Redirect to appropriate Dashboard
            window.location.href = getRoleDashboardUrl(data.role);
        } catch (err) {
            if (errorMessage) errorMessage.textContent = err.message || "Failed to authenticate.";
            if (errorBanner) {
                errorBanner.style.display = "flex";
                // Trigger reflow to restart shake animation
                errorBanner.style.animation = "none";
                errorBanner.offsetHeight;
                errorBanner.style.animation = null;
            }
        } finally {
            if (signinBtn) signinBtn.disabled = false;
            if (signinBtnText) signinBtnText.textContent = "Sign In";
            if (signinSpinner) signinSpinner.style.display = "none";
            if (signinIcon) signinIcon.style.display = "inline-block";
        }
    });
}

// Fast startup: initialize immediately if DOM is already ready, or on DOMContentLoaded
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLoginApp);
} else {
    initLoginApp();
}
