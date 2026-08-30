/**
 * Blessie FoodHub — Customer Portal & Live Order Tracker (customer.js)
 * Modern API-driven frontend for customer ordering, search, cart, and live tracking.
 */

// Global State
let menuData = [];
let cart = [];
let lastPlacedOrderNumber = null;
let currentView = "menu"; // 'menu' | 'orders'
let searchDebounceTimeout = null;

// Tenant ID resolution
let tenantId = new URLSearchParams(window.location.search).get("tenant_id");
if (!tenantId) {
    const storedTenant = localStorage.getItem("tenant_id");
    if (storedTenant && storedTenant !== "GLOBAL" && !isNaN(parseInt(storedTenant))) {
        tenantId = parseInt(storedTenant);
    } else {
        tenantId = 1;
    }
}

document.addEventListener("DOMContentLoaded", () => {
    // DOM Elements
    const categoryNav = document.getElementById("categoryNav");
    const menuSections = document.getElementById("menuSections");
    const cartToggleBtn = document.getElementById("cartToggleBtn");
    const cartSidebar = document.getElementById("cartSidebar");
    const closeCartBtn = document.getElementById("closeCartBtn");
    const overlay = document.getElementById("overlay");
    const cartBadge = document.getElementById("cartBadge");
    const cartItemsContainer = document.getElementById("cartItems");
    const cartSubtotalEl = document.getElementById("cartSubtotal");
    const cartTotalEl = document.getElementById("cartTotal");
    const checkoutForm = document.getElementById("checkoutForm");
    const successModal = document.getElementById("successModal");
    const newOrderBtn = document.getElementById("newOrderBtn");
    const menuSearchInput = document.getElementById("menuSearchInput");
    const clearSearchBtn = document.getElementById("clearSearchBtn");

    // Initialize Auth / Session
    initCustomerSession();

    // Fetch Initial Menu
    fetchMenu();

    // Event Listeners
    if (cartToggleBtn) cartToggleBtn.addEventListener("click", openCart);
    if (closeCartBtn) closeCartBtn.addEventListener("click", closeCart);
    if (overlay) overlay.addEventListener("click", () => {
        closeCart();
        closeModal();
    });

    if (checkoutForm) {
        checkoutForm.addEventListener("submit", (e) => {
            e.preventDefault();
            submitOrder();
        });
    }

    if (newOrderBtn) {
        newOrderBtn.addEventListener("click", () => {
            closeModal();
            switchView("menu");
            const notesEl = document.getElementById("orderNotes");
            if (notesEl) notesEl.value = "";
        });
    }

    // Search Listener
    if (menuSearchInput) {
        menuSearchInput.addEventListener("input", (e) => {
            const query = e.target.value.trim().toLowerCase();
            if (clearSearchBtn) clearSearchBtn.style.display = query ? "block" : "none";
            clearTimeout(searchDebounceTimeout);
            searchDebounceTimeout = setTimeout(() => {
                filterMenu(query);
            }, 180);
        });
    }

    if (clearSearchBtn) {
        clearSearchBtn.addEventListener("click", () => {
            if (menuSearchInput) {
                menuSearchInput.value = "";
                menuSearchInput.focus();
            }
            clearSearchBtn.style.display = "none";
            filterMenu("");
        });
    }

    // Scroll spy for active category pill
    window.addEventListener("scroll", handleScrollSpy);
});

// ────────────────────────────────────────────────────────────
// SESSION & AUTH
// ────────────────────────────────────────────────────────────
function initCustomerSession() {
    const loggedInUser = localStorage.getItem("username");
    if (loggedInUser) {
        const nameInput = document.getElementById("customerName");
        if (nameInput && !nameInput.value) {
            nameInput.value = loggedInUser;
        }
        const badgeContainer = document.getElementById("userBadgeContainer");
        const userLabel = document.getElementById("customerUserLabel");
        if (badgeContainer && userLabel) {
            userLabel.innerHTML = `<i class="fas fa-user-circle"></i> ${loggedInUser}`;
            badgeContainer.style.display = "flex";
        }
    }

    const logoutBtn = document.getElementById("customerLogoutBtn");
    if (logoutBtn) {
        logoutBtn.addEventListener("click", () => {
            localStorage.removeItem("access_token");
            localStorage.removeItem("username");
            localStorage.removeItem("role");
            localStorage.removeItem("tenant_id");
            localStorage.removeItem("RESTOTRACK_USER");
            localStorage.removeItem("RESTOTRACK_ROLE");
            sessionStorage.clear();
            showToast("Signed out successfully", "info");
            setTimeout(() => {
                window.location.href = "/";
            }, 500);
        });
    }
}

// ────────────────────────────────────────────────────────────
// VIEW SWITCHER (MENU / ORDERS)
// ────────────────────────────────────────────────────────────
window.switchView = function(viewName) {
    currentView = viewName;
    const menuView = document.getElementById("menuView");
    const ordersView = document.getElementById("ordersView");
    const tabMenuBtn = document.getElementById("tabMenuBtn");
    const tabOrdersBtn = document.getElementById("tabOrdersBtn");

    if (viewName === "menu") {
        if (menuView) menuView.style.display = "block";
        if (ordersView) ordersView.style.display = "none";
        if (tabMenuBtn) tabMenuBtn.classList.add("active");
        if (tabOrdersBtn) tabOrdersBtn.classList.remove("active");
    } else {
        if (menuView) menuView.style.display = "none";
        if (ordersView) ordersView.style.display = "block";
        if (tabMenuBtn) tabMenuBtn.classList.remove("active");
        if (tabOrdersBtn) tabOrdersBtn.classList.add("active");
        loadOrderHistory();
    }
};

// ────────────────────────────────────────────────────────────
// MENU FETCHING & RENDERING
// ────────────────────────────────────────────────────────────
async function fetchMenu() {
    const menuSections = document.getElementById("menuSections");
    try {
        const response = await fetch(`/api/v1/customer-orders/menu?tenant_id=${tenantId}`);
        if (!response.ok) throw new Error("Failed to load menu data");
        menuData = await response.json();
        renderMenu(menuData);
    } catch (error) {
        console.error("Error fetching menu:", error);
        if (menuSections) {
            menuSections.innerHTML = `
                <div class="loader-container">
                    <i class="fas fa-exclamation-triangle" style="font-size:2.5rem; color:#ef4444; margin-bottom:12px;"></i>
                    <h3 style="color:#ffffff; margin-bottom:6px;">Unable to load menu</h3>
                    <p style="font-size:13px; color:var(--text-muted);">Please check your network connection and retry.</p>
                    <button class="btn-primary" onclick="fetchMenu()" style="margin-top:16px;">
                        <i class="fas fa-redo"></i> Retry
                    </button>
                </div>
            `;
        }
    }
}

function renderMenu(data) {
    const categoryNav = document.getElementById("categoryNav");
    const menuSections = document.getElementById("menuSections");
    if (!categoryNav || !menuSections) return;

    if (!data || data.length === 0) {
        menuSections.innerHTML = `
            <div class="loader-container">
                <i class="fas fa-utensils" style="font-size:2.5rem; color:var(--text-gold); margin-bottom:12px;"></i>
                <h3 style="color:#ffffff;">No menu items currently available</h3>
                <p style="font-size:13px; color:var(--text-muted);">Please check back shortly or ask our staff.</p>
            </div>
        `;
        categoryNav.innerHTML = "";
        return;
    }

    categoryNav.innerHTML = "";
    menuSections.innerHTML = "";

    data.forEach((category, index) => {
        if (!category.products || category.products.length === 0) return;

        // 1. Create Category Pill Button
        const catBtn = document.createElement("button");
        catBtn.className = `cat-btn ${index === 0 ? 'active' : ''}`;
        catBtn.id = `cat-btn-${category.id}`;
        catBtn.innerHTML = `<span>${category.name}</span> <small style="opacity:0.65;">(${category.products.length})</small>`;
        catBtn.onclick = () => scrollToCategory(category.id, catBtn);
        categoryNav.appendChild(catBtn);

        // 2. Create Section Card
        const section = document.createElement("div");
        section.className = "menu-section";
        section.id = `cat-section-${category.id}`;

        // Header
        const header = document.createElement("div");
        header.className = "menu-section-header";
        header.innerHTML = `
            <h2>${category.name}</h2>
            <span class="item-count">${category.products.length} Items</span>
        `;
        section.appendChild(header);

        // Products Grid
        const grid = document.createElement("div");
        grid.className = "product-grid";

        category.products.forEach(product => {
            const card = document.createElement("div");
            card.className = "product-card";

            // Determine Food Icon based on name
            const iconClass = getFoodIcon(product.name);

            card.innerHTML = `
                <div class="product-img-wrap">
                    <i class="fas ${iconClass} product-icon"></i>
                </div>
                <div class="product-info">
                    <div class="product-name">${escapeHtml(product.name)}</div>
                    <div class="product-footer">
                        <div class="product-price">₱${parseFloat(product.price).toFixed(2)}</div>
                        <button class="add-btn" onclick="addToCart(${product.id}, '${escapeQuote(product.name)}', ${product.price}, event)">
                            <i class="fas fa-plus"></i> Add
                        </button>
                    </div>
                </div>
            `;
            grid.appendChild(card);
        });

        section.appendChild(grid);
        menuSections.appendChild(section);
    });
}

function filterMenu(query) {
    if (!query) {
        renderMenu(menuData);
        return;
    }

    const filtered = [];
    menuData.forEach(cat => {
        const matchingProds = (cat.products || []).filter(p => 
            p.name.toLowerCase().includes(query) || cat.name.toLowerCase().includes(query)
        );
        if (matchingProds.length > 0) {
            filtered.push({
                ...cat,
                products: matchingProds
            });
        }
    });

    renderMenu(filtered);
}

function scrollToCategory(id, btnElement) {
    document.querySelectorAll(".cat-btn").forEach(btn => btn.classList.remove("active"));
    if (btnElement) btnElement.classList.add("active");

    const section = document.getElementById(`cat-section-${id}`);
    if (section) {
        const topOffset = section.getBoundingClientRect().top + window.pageYOffset - 160;
        window.scrollTo({ top: topOffset, behavior: "smooth" });
    }
}

function handleScrollSpy() {
    if (currentView !== "menu") return;
    const sections = document.querySelectorAll(".menu-section");
    let currentId = "";

    sections.forEach(sec => {
        const secTop = sec.offsetTop;
        if (window.pageYOffset >= secTop - 180) {
            currentId = sec.getAttribute("id");
        }
    });

    if (currentId) {
        const cleanId = currentId.replace("cat-section-", "");
        document.querySelectorAll(".cat-btn").forEach(btn => {
            btn.classList.remove("active");
            if (btn.id === `cat-btn-${cleanId}`) {
                btn.classList.add("active");
            }
        });
    }
}

function getFoodIcon(name) {
    const l = name.toLowerCase();
    if (l.includes("burger") || l.includes("patty") || l.includes("sandwich")) return "fa-hamburger";
    if (l.includes("pizza")) return "fa-pizza-slice";
    if (l.includes("coffee") || l.includes("latte") || l.includes("cappuccino") || l.includes("espresso")) return "fa-mug-hot";
    if (l.includes("tea") || l.includes("milk tea") || l.includes("boba")) return "fa-glass-water";
    if (l.includes("chicken") || l.includes("wings") || l.includes("chick")) return "fa-drumstick-bite";
    if (l.includes("rice") || l.includes("bowl") || l.includes("fried rice")) return "fa-bowl-rice";
    if (l.includes("fries") || l.includes("potato") || l.includes("chips")) return "fa-fire";
    if (l.includes("beer") || l.includes("drink") || l.includes("soda") || l.includes("beverage")) return "fa-wine-bottle";
    if (l.includes("ice cream") || l.includes("cake") || l.includes("dessert") || l.includes("halo")) return "fa-ice-cream";
    return "fa-utensils";
}

// ────────────────────────────────────────────────────────────
// CART MANAGEMENT
// ────────────────────────────────────────────────────────────
window.addToCart = function(id, name, price, e) {
    const existing = cart.find(item => item.id === id);
    if (existing) {
        existing.quantity += 1;
    } else {
        cart.push({ id, name, price: parseFloat(price), quantity: 1 });
    }

    updateCartUI();

    // Button feedback
    if (e && e.currentTarget) {
        const btn = e.currentTarget;
        const orig = btn.innerHTML;
        btn.innerHTML = `<i class="fas fa-check"></i> Added`;
        btn.style.background = "#10b981";
        btn.style.color = "#ffffff";
        setTimeout(() => {
            btn.innerHTML = orig;
            btn.style.background = "";
            btn.style.color = "";
        }, 800);
    }

    showToast(`Added 1x ${name} to your tray`, "success");
};

window.updateQuantity = function(id, delta) {
    const item = cart.find(i => i.id === id);
    if (!item) return;

    item.quantity += delta;
    if (item.quantity <= 0) {
        removeFromCart(id);
    } else {
        updateCartUI();
    }
};

window.removeFromCart = function(id) {
    const item = cart.find(i => i.id === id);
    cart = cart.filter(i => i.id !== id);
    updateCartUI();
    if (item) showToast(`Removed ${item.name} from tray`, "info");
};

function updateCartUI() {
    const cartBadge = document.getElementById("cartBadge");
    const cartItemsContainer = document.getElementById("cartItems");
    const cartSubtotalEl = document.getElementById("cartSubtotal");
    const cartTotalEl = document.getElementById("cartTotal");

    // Total Items
    const totalQty = cart.reduce((sum, i) => sum + i.quantity, 0);
    if (cartBadge) {
        cartBadge.textContent = totalQty;
        cartBadge.style.transform = "scale(1.25)";
        setTimeout(() => { cartBadge.style.transform = "scale(1)"; }, 200);
    }

    if (!cartItemsContainer) return;

    if (cart.length === 0) {
        cartItemsContainer.innerHTML = `
            <div class="empty-cart-state">
                <i class="fas fa-shopping-basket"></i>
                <h4>Your tray is empty</h4>
                <p>Select delicious dishes from the menu to start your order.</p>
            </div>
        `;
        if (cartSubtotalEl) cartSubtotalEl.textContent = "₱0.00";
        if (cartTotalEl) cartTotalEl.textContent = "₱0.00";
        return;
    }

    cartItemsContainer.innerHTML = "";
    let total = 0;

    cart.forEach(item => {
        const itemTotal = item.price * item.quantity;
        total += itemTotal;

        const row = document.createElement("div");
        row.className = "cart-item";
        row.innerHTML = `
            <div class="cart-item-header">
                <span class="cart-item-title">${escapeHtml(item.name)}</span>
                <span class="cart-item-price">₱${itemTotal.toFixed(2)}</span>
            </div>
            <div class="cart-item-controls">
                <div class="qty-control">
                    <button type="button" class="qty-btn" onclick="updateQuantity(${item.id}, -1)">
                        <i class="fas fa-minus"></i>
                    </button>
                    <span class="qty-display">${item.quantity}</span>
                    <button type="button" class="qty-btn" onclick="updateQuantity(${item.id}, 1)">
                        <i class="fas fa-plus"></i>
                    </button>
                </div>
                <button type="button" class="remove-btn" onclick="removeFromCart(${item.id})">
                    <i class="fas fa-trash-alt"></i> Remove
                </button>
            </div>
        `;
        cartItemsContainer.appendChild(row);
    });

    if (cartSubtotalEl) cartSubtotalEl.textContent = `₱${total.toFixed(2)}`;
    if (cartTotalEl) cartTotalEl.textContent = `₱${total.toFixed(2)}`;
}

function openCart() {
    const sidebar = document.getElementById("cartSidebar");
    const overlay = document.getElementById("overlay");
    if (sidebar) sidebar.classList.add("open");
    if (overlay) overlay.classList.add("active");
}

function closeCart() {
    const sidebar = document.getElementById("cartSidebar");
    const overlay = document.getElementById("overlay");
    if (sidebar) sidebar.classList.remove("open");
    if (overlay) overlay.classList.remove("active");
}

// ────────────────────────────────────────────────────────────
// ORDER SUBMISSION
// ────────────────────────────────────────────────────────────
async function submitOrder() {
    if (cart.length === 0) {
        showToast("Your tray is empty. Add items from the menu first!", "danger");
        return;
    }

    const nameInput = document.getElementById("customerName");
    const tableInput = document.getElementById("tableNumber");
    const typeInput = document.getElementById("orderType");
    const notesInput = document.getElementById("orderNotes");
    const submitBtn = document.getElementById("submitOrderBtn");
    const submitText = document.getElementById("submitOrderText");

    const name = nameInput ? nameInput.value.trim() : "";
    const table = tableInput ? tableInput.value.trim() : "";
    const type = typeInput ? typeInput.value : "Dine-in";
    const notes = notesInput ? notesInput.value.trim() : "";

    if (!name) {
        showToast("Please enter your name to proceed", "danger");
        if (nameInput) nameInput.focus();
        return;
    }

    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const randomHex = Math.random().toString(36).substring(2, 8).toUpperCase();
    const orderNumber = `CUST-${randomHex}`;

    const payload = {
        order_number: orderNumber,
        customer_name: name,
        order_type: type,
        table_number: table || (type === "Takeout" ? "Takeout" : "Dine-In"),
        notes: notes,
        total: total,
        items: cart.map(i => ({
            name: i.name,
            variant: null,
            price: i.price,
            quantity: i.quantity
        }))
    };

    if (submitBtn) submitBtn.disabled = true;
    if (submitText) submitText.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Transmitting...`;

    try {
        const response = await fetch("/api/v1/customer-orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.detail || "Failed to submit order.");
        }

        // Save order number in local store for customer history tracking
        saveOrderToHistory(orderNumber);
        lastPlacedOrderNumber = orderNumber;

        // Clear cart & close drawer
        cart = [];
        updateCartUI();
        closeCart();

        // Show Success Dialog
        const orderNumEl = document.getElementById("createdOrderNumber");
        if (orderNumEl) orderNumEl.textContent = orderNumber;

        const successModal = document.getElementById("successModal");
        const overlay = document.getElementById("overlay");
        if (successModal) successModal.classList.add("active");
        if (overlay) overlay.classList.add("active");

        showToast("Order transmitted to kitchen!", "success");

    } catch (err) {
        console.error("Order submission failed:", err);
        showToast(err.message || "Failed to send order. Please try again.", "danger");
    } finally {
        if (submitBtn) submitBtn.disabled = false;
        if (submitText) submitText.textContent = "Place Order Now";
    }
}

function saveOrderToHistory(orderNum) {
    try {
        let history = JSON.parse(localStorage.getItem("CUSTOMER_ORDERS_HISTORY") || "[]");
        if (!history.includes(orderNum)) {
            history.unshift(orderNum);
            localStorage.setItem("CUSTOMER_ORDERS_HISTORY", JSON.stringify(history.slice(0, 30)));
        }
    } catch (e) {}
}

window.copyOrderNumber = function() {
    if (!lastPlacedOrderNumber) return;
    navigator.clipboard.writeText(lastPlacedOrderNumber).then(() => {
        showToast("Order number copied to clipboard!", "info");
    });
};

window.viewOrderInTracker = function() {
    closeModal();
    switchView("orders");
    if (lastPlacedOrderNumber) {
        const trackInput = document.getElementById("orderTrackInput");
        if (trackInput) trackInput.value = lastPlacedOrderNumber;
        trackSpecificOrder();
    }
};

function closeModal() {
    const successModal = document.getElementById("successModal");
    const overlay = document.getElementById("overlay");
    if (successModal) successModal.classList.remove("active");
    if (overlay) overlay.classList.remove("active");
}

// ────────────────────────────────────────────────────────────
// LIVE ORDER TRACKER & HISTORY
// ────────────────────────────────────────────────────────────
window.trackSpecificOrder = async function() {
    const trackInput = document.getElementById("orderTrackInput");
    const resultContainer = document.getElementById("trackedOrderResult");
    if (!trackInput || !resultContainer) return;

    const orderNum = trackInput.value.trim().toUpperCase();
    if (!orderNum) {
        showToast("Please enter an order number", "danger");
        return;
    }

    resultContainer.style.display = "block";
    resultContainer.innerHTML = `
        <div class="loader-container">
            <div class="spinner"></div>
            <p>Searching for order ${orderNum}...</p>
        </div>
    `;

    try {
        const response = await fetch(`/api/v1/customer-orders/track/${encodeURIComponent(orderNum)}`);
        if (!response.ok) {
            resultContainer.innerHTML = `
                <div class="glass-panel" style="padding:20px; text-align:center; color:var(--text-muted);">
                    <i class="fas fa-search" style="font-size:24px; color:#ef4444; margin-bottom:8px;"></i>
                    <h4 style="color:#ffffff;">Order Not Found</h4>
                    <p style="font-size:13px;">No active order found with tracking number <strong>${orderNum}</strong>.</p>
                </div>
            `;
            return;
        }

        const ord = await response.json();
        resultContainer.innerHTML = renderOrderTrackCard(ord);
        showToast(`Tracking status for ${orderNum}`, "info");
    } catch (err) {
        resultContainer.innerHTML = `
            <div class="glass-panel" style="padding:20px; text-align:center; color:#ef4444;">
                Failed to communicate with tracking server.
            </div>
        `;
    }
};

window.loadOrderHistory = async function() {
    const container = document.getElementById("ordersHistoryList");
    if (!container) return;

    const loggedInUser = localStorage.getItem("username") || "";
    let url = `/api/v1/customer-orders/history?limit=25`;
    if (loggedInUser && loggedInUser !== "customer") {
        url += `&customer_name=${encodeURIComponent(loggedInUser)}`;
    }

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load history");
        const orders = await res.json();

        if (orders.length === 0) {
            container.innerHTML = `
                <div class="glass-panel" style="padding:40px 20px; text-align:center; color:var(--text-muted);">
                    <i class="fas fa-receipt" style="font-size:36px; color:var(--text-gold); margin-bottom:12px; opacity:0.6;"></i>
                    <h4 style="color:#ffffff; margin-bottom:4px;">No Orders Recorded Yet</h4>
                    <p style="font-size:13px;">Your recent orders will appear here for live status tracking.</p>
                    <button class="btn-primary" onclick="switchView('menu')" style="margin-top:16px;">
                        <i class="fas fa-utensils"></i> Browse Menu
                    </button>
                </div>
            `;
            return;
        }

        container.innerHTML = orders.map(ord => renderOrderTrackCard(ord)).join("");

    } catch (err) {
        container.innerHTML = `
            <div class="glass-panel" style="padding:20px; text-align:center; color:var(--text-muted);">
                <p>Could not refresh order history at this time.</p>
            </div>
        `;
    }
};

function renderOrderTrackCard(ord) {
    const status = (ord.status || "pending").toLowerCase();
    let statusClass = "status-pending";
    let statusLabel = "⏳ PENDING CONFIRMATION";
    let statusDesc = "Received. Waiting for cashier verification.";

    if (status === "accepted" || status === "preparing") {
        statusClass = "status-accepted";
        statusLabel = "🍳 IN KITCHEN / PREPARING";
        statusDesc = "Accepted by kitchen. Your meal is being cooked!";
    } else if (status === "completed" || status === "ready") {
        statusClass = "status-completed";
        statusLabel = "✅ READY / COMPLETED";
        statusDesc = "Your order is ready to serve! Enjoy your meal!";
    } else if (status === "rejected") {
        statusClass = "status-rejected";
        statusLabel = "❌ CANCELLED / REJECTED";
        statusDesc = "Order was cancelled.";
    }

    const dateStr = ord.created_at ? new Date(ord.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "Just now";

    return `
        <div class="order-track-card">
            <div class="order-card-header">
                <div>
                    <span class="order-num-tag"><i class="fas fa-receipt"></i> ${ord.order_number}</span>
                    <div class="order-meta">
                        <span><i class="far fa-clock"></i> ${dateStr}</span> • 
                        <span><i class="fas fa-user"></i> ${escapeHtml(ord.customer_name)}</span> • 
                        <span><i class="fas fa-chair"></i> ${ord.table_number || ord.order_type}</span>
                    </div>
                </div>
                <div style="text-align:right;">
                    <span class="status-badge ${statusClass}">${statusLabel}</span>
                    <div style="font-size:11.5px; color:var(--text-muted); margin-top:4px;">${statusDesc}</div>
                </div>
            </div>
            <div class="order-card-body">
                <ul class="order-items-list">
                    ${(ord.items || []).map(it => `
                        <li class="order-item-row">
                            <span><strong style="color:var(--text-gold);">${it.quantity}x</strong> ${escapeHtml(it.name)}</span>
                            <span style="color:var(--text-muted);">₱${(it.price * it.quantity).toFixed(2)}</span>
                        </li>
                    `).join('')}
                </ul>
                ${ord.notes ? `<div style="font-size:12px; color:var(--text-gold); background:rgba(201,162,39,0.08); padding:6px 10px; border-radius:6px; border-left:2px solid var(--primary);"><i class="fas fa-info-circle"></i> Note: ${escapeHtml(ord.notes)}</div>` : ''}
            </div>
            <div class="order-card-footer">
                <span>Payment Mode: Cash / Counter</span>
                <span style="font-size:15px; color:var(--text-gold);">Total: ₱${parseFloat(ord.total_amount).toFixed(2)}</span>
            </div>
        </div>
    `;
}

// ────────────────────────────────────────────────────────────
// TOAST NOTIFICATIONS & HELPERS
// ────────────────────────────────────────────────────────────
function showToast(message, type = "info") {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;

    let icon = "fa-info-circle";
    if (type === "success") icon = "fa-check-circle";
    if (type === "danger") icon = "fa-exclamation-triangle";

    toast.innerHTML = `<i class="fas ${icon}"></i> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(10px)";
        toast.style.transition = "all 0.3s ease";
        setTimeout(() => toast.remove(), 300);
    }, 3200);
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function escapeQuote(str) {
    if (!str) return "";
    return String(str).replace(/'/g, "\\'");
}
