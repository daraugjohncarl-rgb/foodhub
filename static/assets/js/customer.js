/* =========================================================
   BLESSIE FOOD HUB
   MERGED CUSTOMER JS (REAL API + NEW UI)
========================================================= */

// Global State
let menu = [];
let cart = [];
let selectedProduct = null;
let selectedVariant = 0;
let selectedQuantity = 1;

let searchTerm = "";
let activeCategory = "All";

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

// Image fallback mapping
const fallbackImages = {
    "arroz caldo": "/static/assets/images/arrozcaldo.png",
    "burger": "/static/assets/images/burger solo.png",
    "burger with fries": "/static/assets/images/burger with fries.png",
    "molo": "/static/assets/images/MOLO.png",
    "nachos": "/static/assets/images/nachos.png",
    "pancit canton with toasted bread": "/static/assets/images/Pancit Canton with Toasted Bread.png",
    "pancit canton": "/static/assets/images/PANCIT CANTON.png",
    "sotanghon guisado": "/static/assets/images/sotanghon guisado.png",
    "spaghetti with bread": "/static/assets/images/spaghetti with bread.png",
    "spaghetti with burger": "/static/assets/images/spaghetti with burger.png",
    "toasted bread": "/static/assets/images/toasted bread.png",
    "tuna sandwich": "/static/assets/images/tuna sandwich.png",
    "caramel macchiato": "/static/assets/images/coffee/caramel macchiato.png",
    "coffee jelly": "/static/assets/images/coffee/coffee jelly.png",
    "dirty matcha": "/static/assets/images/coffee/dirty matcha.png",
    "french vanilla": "/static/assets/images/coffee/french vanill.png",
    "iced americano": "/static/assets/images/coffee/iced americano.png",
    "iced coffee": "/static/assets/images/coffee/iced coffe.png",
    "matcha milk": "/static/assets/images/coffee/matcha milk.png",
    "salted caramel": "/static/assets/images/coffee/salted caramel.png",
    "spanish latte": "/static/assets/images/coffee/spanish latte.png",
    "vietnamese coffee": "/static/assets/images/coffee/vietnamese coffee.png"
};

function resolveImage(product) {
    if (product.image_url) {
        let p = product.image_url;
        if (!p.startsWith("http") && !p.startsWith("/static")) {
            if (p.startsWith("images/")) return "/static/assets/" + p;
            if (p.startsWith("assets/images/")) return "/static/" + p;
            return "/static/assets/images/" + p;
        }
        return p;
    }
    if (product.name) {
        const nameLower = product.name.toLowerCase();
        // Exact match first
        if (fallbackImages[nameLower]) return fallbackImages[nameLower];
        // Partial match
        for (const key in fallbackImages) {
            if (nameLower.includes(key)) return fallbackImages[key];
        }
    }
    return "";
}

// Grouping Helper (Global)
function getBaseProductName(name) {
    // Detect typical size suffixes globally across any category
    // Examples: " - 16 oz", " 16oz", " — Large", " - M", " - Single", " - 2 pcs"
    const match = name.match(/^(.*?)(?:\s*[-–—]\s*|\s+)(\d+\s*oz|\d+\s*pcs|Large|Medium|Small|Regular|S|M|L|Single|Barkada)$/i);
    if (match) {
        return {
            baseName: match[1].trim(),
            variantName: match[2].trim()
        };
    }
    
    return {
        baseName: name.trim(),
        variantName: "Regular"
    };
}

// DOM Elements
const menuTitle = document.getElementById("menuTitle");
const menuCount = document.getElementById("menuCount");
const menuList = document.getElementById("menuList");

const productOverlay = document.getElementById("productOverlay");
const detailImage = document.getElementById("detailImage");
const detailTitle = document.getElementById("detailTitle");
const detailDescription = document.getElementById("detailDescription");
const variantSection = document.getElementById("variantSection");
const variantList = document.getElementById("variantList");
const detailPrice = document.getElementById("detailPrice");
const quantityValue = document.getElementById("quantityValue");
const detailTotal = document.getElementById("detailTotal");

const cartCount = document.getElementById("cartCount");
const floatingItems = document.getElementById("floatingItems");
const floatingTotal = document.getElementById("floatingTotal");
const cartDrawer = document.getElementById("cartDrawer");
const cartOverlay = document.getElementById("cartOverlay");
const cartList = document.getElementById("cartList");
const cartTotal = document.getElementById("cartTotal");

const toast = document.getElementById("toast");

const checkoutOverlay = document.getElementById("checkoutOverlay");
const checkoutContent = document.getElementById("checkoutContent");
const success = document.getElementById("success");

// Initialize Table Number from URL or storage
const urlParams = new URLSearchParams(window.location.search);
let tableParam = urlParams.get("table") || urlParams.get("table_number") || urlParams.get("t");
if (tableParam) {
    sessionStorage.setItem("customer_qr_table", tableParam);
    localStorage.setItem("customer_qr_table", tableParam);
} else {
    tableParam = sessionStorage.getItem("customer_qr_table") || localStorage.getItem("customer_qr_table");
}

function initCustomerApp() {
    // 1. Direct menu access (bypass landing page for seamless QR scan experience)
    const lp = document.getElementById("landingPage");
    if (lp) {
        lp.classList.add("is-hidden");
        lp.style.display = "none";
    }
    document.body.classList.remove("landing-active");

    // 2. Setup Table Number & Dine In
    const tableInput = document.getElementById("tableNumber");
    const tableGroup = document.getElementById("tableGroup");
    const notesGroup = document.getElementById("notesGroup");
    const orderTypeSelect = document.getElementById("orderType");
    const headerTableBadge = document.getElementById("headerTableBadge");
    const headerTableNum = document.getElementById("headerTableNum");
    
    if (tableParam) {
        if (tableInput) {
            tableInput.value = tableParam;
            tableInput.readOnly = true;
        }
        // When customer uses QR code, hide table number and notes so only Customer Name and Order Type are visible
        if (tableGroup) {
            tableGroup.style.display = "none";
        }
        if (notesGroup) {
            notesGroup.style.display = "none";
        }
        if (orderTypeSelect) {
            orderTypeSelect.value = "Dine In";
            orderTypeSelect.disabled = true;
        }
        if (headerTableBadge && headerTableNum) {
            headerTableNum.textContent = tableParam;
            headerTableBadge.style.display = "inline-flex";
        }
    } else {
        if (orderTypeSelect) {
            orderTypeSelect.addEventListener("change", () => {
                if (tableGroup) {
                    tableGroup.style.display = orderTypeSelect.value === "Dine In" ? "block" : "none";
                }
            });
        }
    }

    // 3. Update customer authentication UI (logged in vs guest)
    updateCustomerAuthUI();

    // 4. Automatically fetch and render menu immediately (no login required)
    if (typeof fetchMenu === "function") {
        fetchMenu();
    }
    
    // 4. Order Button fallback (if landing page is ever restored)
    const ob = document.getElementById("orderButton");
    if (ob) {
        ob.addEventListener("click", () => {
            if (lp) {
                lp.classList.add("is-hidden");
                lp.style.display = "none";
            }
            document.body.classList.remove("landing-active");
            if (typeof fetchMenu === "function") fetchMenu();
        });
    }
    
    // 3. Product Modal Buttons
    const closeBtn = document.getElementById("closeProduct");
    if (closeBtn) closeBtn.addEventListener("click", closeProduct);
    
    const qMinus = document.getElementById("quantityMinus");
    if (qMinus) qMinus.addEventListener("click", () => {
        if (selectedQuantity > 1) {
            selectedQuantity--;
            updateProduct();
        }
    });
    
    const qPlus = document.getElementById("quantityPlus");
    if (qPlus) qPlus.addEventListener("click", () => {
        selectedQuantity++;
        updateProduct();
    });
    
    const addToOrderBtn = document.getElementById("addToOrder");
    if (addToOrderBtn) addToOrderBtn.addEventListener("click", addToCart);
    
    if (productOverlay) {
        productOverlay.addEventListener("click", event => {
            if (event.target === productOverlay) closeProduct();
        });
    }

    // 4. Cart UI Buttons
    const headerCart = document.getElementById("headerCart");
    if (headerCart) headerCart.addEventListener("click", openCart);
    
    const closeCartBtn = document.getElementById("closeCart");
    if (closeCartBtn) closeCartBtn.addEventListener("click", closeCart);
    
    if (cartOverlay) {
        cartOverlay.addEventListener("click", event => {
            if (event.target === cartOverlay) closeCart();
        });
    }
    
    const floatingCart = document.getElementById("floatingCart");
    if (floatingCart) floatingCart.addEventListener("click", openCart);
    
    // 5. Checkout Buttons
    const checkoutButton = document.getElementById("checkoutButton");
    if (checkoutButton) checkoutButton.addEventListener("click", openCheckout);
    
    const cancelCheckout = document.getElementById("cancelCheckout");
    if (cancelCheckout) cancelCheckout.addEventListener("click", closeCheckout);
    
    if (checkoutOverlay) {
        checkoutOverlay.addEventListener("click", event => {
            if (event.target === checkoutOverlay) closeCheckout();
        });
    }
    
    const placeOrderBtn = document.getElementById("placeOrder");
    if (placeOrderBtn) placeOrderBtn.addEventListener("click", submitOrder);
    
    const doneButton = document.getElementById("doneButton");
    if (doneButton) doneButton.addEventListener("click", () => {
        closeCheckout();
        if (success) success.classList.remove("active");
        if (checkoutContent) checkoutContent.style.display = "block";
        cart = [];
        updateCart();
        window.scrollTo(0, 0);
        openCustomerOrdersModal();
    });

    // 6. Connect Customer Real-Time WebSocket and init badges
    updateCustomerOrdersBadge();
    connectCustomerWebSocket();

    // 7. Search
    const searchInput = document.getElementById("searchInput");
    if (searchInput) {
        searchInput.addEventListener("input", event => {
            searchTerm = event.target.value;
            renderMenu();
        });
    }

    // 7. Categories
    const categoriesContainer = document.getElementById("categories");
    if (categoriesContainer) {
        categoriesContainer.addEventListener("click", (event) => {
            const button = event.target.closest(".category");
            if (!button) return;

            event.preventDefault();
            event.stopPropagation();

            const category = button.dataset.category;
            if (!category) return;

            console.log("CATEGORY CLICK:", category);

            categoriesContainer.querySelectorAll(".category").forEach(btn => btn.classList.remove("active"));
            button.classList.add("active");

            activeCategory = category;
            
            if (menuTitle) {
                menuTitle.textContent = button.textContent.trim() || activeCategory;
            }
            
            renderMenu();
        });
    }

    updateCart();
}

// Fast startup: initialize immediately if DOM is already ready, or on DOMContentLoaded
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCustomerApp);
} else {
    initCustomerApp();
}

/* =========================================================
   UTILITIES
========================================================= */
function peso(amount) {
    return "₱" + parseFloat(amount).toFixed(2);
}

function escapeHTML(str) {
    if (!str) return "";
    return str
        .toString()
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

/* =========================================================
   API FETCH MENU
========================================================= */
async function fetchMenu() {
    const lp = document.getElementById("landingPage");
    if (lp) lp.classList.add("is-loading");

    try {
        const response = await fetch(`/api/v1/customer-orders/menu?tenant_id=${tenantId}`);
        if (!response.ok) throw new Error("Failed to load menu data");
        const data = await response.json();
        
        menu = [];
        const categoriesList = [];

        data.forEach(category => {
            const catName = category.name || "Other";
            if (!categoriesList.includes(catName)) {
                categoriesList.push(catName);
            }
            if (category.products && category.products.length > 0) {
                category.products.forEach(product => {
                    // Do not show inactive products in customer menu
                    if (product.is_active === false || product.is_active === 0 || product.is_active === "0") return;

                    let imagePath = resolveImage(product);
                    const priceNum = parseFloat(product.price) || 0;

                    // Exactly match Cashier POS menu items without artificial regex grouping
                    menu.push({
                        id: product.id,
                        name: product.name,
                        category: catName,
                        description: product.description || "",
                        image: imagePath,
                        price: priceNum,
                        options: [{
                            id: product.id,
                            label: "Regular",
                            price: priceNum
                        }]
                    });
                });
            }
        });

        // Dynamically update category tabs to match current categories
        const categoriesContainer = document.getElementById("categories");
        if (categoriesContainer) {
            let catHTML = `<button class="category active" data-category="All" type="button">All Items</button>`;
            categoriesList.forEach(catName => {
                catHTML += `<button class="category" data-category="${escapeHTML(catName)}" type="button">${escapeHTML(catName)}</button>`;
            });
            categoriesContainer.innerHTML = catHTML;
        }
        
        if (lp) lp.classList.add("is-hidden");
        
        renderMenu();

    } catch (error) {
        console.error("Error fetching menu:", error);
        showToast("Error loading menu. Please refresh.");
        if (lp) {
            lp.classList.remove("is-loading");
            lp.classList.add("is-hidden");
            lp.style.display = "none";
        }
    }
}

/* =========================================================
   PRODUCT IMAGE
========================================================= */
function productImage(product) {
    if (product.image) {
        return `
            <img
                src="${escapeHTML(product.image)}"
                alt="${escapeHTML(product.name)}"
                onerror="
                    this.style.display='none';
                    this.parentElement.style.background='#ebe7df';
                    let span = this.parentElement.querySelector('.image-placeholder');
                    if(span) span.style.display='flex';
                "
            >
            <div class="image-placeholder" style="display:none; align-items:center; justify-content:center; width:100%; height:100%; font-size:12px; color:#999; text-align:center; padding:10px;">
                ${escapeHTML(product.name)}
            </div>
        `;
    } else {
        return `
            <div class="image-placeholder" style="display:flex; align-items:center; justify-content:center; width:100%; height:100%; font-size:12px; color:#999; text-align:center; padding:10px; background:#ebe7df;">
                ${escapeHTML(product.name)}
            </div>
        `;
    }
}

/* =========================================================
   FILTER & RENDER MENU
========================================================= */
function getFilteredProducts() {
    return menu.filter(product => {
        const catA = String(activeCategory).toLowerCase().trim();
        const catB = String(product.category).toLowerCase().trim();
        
        const categoryMatch = catA === "all" || catB === catA;
        
        const searchable = (
            product.name + " " + product.category + " " + product.description + " " +
            product.options.map(option => option.label).join(" ")
        ).toLowerCase();
        
        const searchMatch = searchable.includes(searchTerm.toLowerCase());
        
        return categoryMatch && searchMatch;
    });
}

function renderMenu() {
    if (!menuList) return;
    const products = getFilteredProducts();

    if (products.length === 0) {
        menuList.innerHTML = `<div style="text-align:center; padding: 48px 20px; color: var(--muted); font-size: 14px; grid-column: 1 / -1; width: 100%;">
            <div style="font-size: 36px; margin-bottom: 8px; color: var(--accent, #c9a227);"><i class="fas fa-utensils"></i></div>
            <strong>No items found in this category</strong>
            <p style="font-size: 13px; margin-top: 6px; color: #a1a1aa;">Items will appear here once added in the POS.</p>
        </div>`;
        if (menuCount) menuCount.textContent = "0 items";
        return;
    }

    menuList.innerHTML = products.map((product) => {
        const priceVal = product.price || (product.options && product.options[0] ? product.options[0].price : 0);
        const priceText = peso(priceVal);

        return `
            <article class="menu-item" data-product-id="${product.id}">
                <div class="menu-image">${productImage(product)}</div>
                <div class="menu-info">
                    <div class="menu-category">${escapeHTML(product.category)}</div>
                    <div class="menu-name">${escapeHTML(product.name)}</div>
                    ${product.description ? `<div class="menu-description">${escapeHTML(product.description)}</div>` : ''}
                    <div class="menu-bottom">
                        <div class="menu-price">${priceText}</div>
                        <button class="select-button select-product" type="button" data-product-id="${product.id}">Select</button>
                    </div>
                </div>
            </article>
        `;
    }).join("");

    if (menuCount) menuCount.textContent = products.length + (products.length === 1 ? " item" : " items");
}

// Event Delegation for Menu List
if (menuList) {
    menuList.addEventListener("click", (event) => {
        const button = event.target.closest(".select-product");
        const card = event.target.closest(".menu-item");
        
        let productId = null;
        if (button) {
            productId = button.dataset.productId;
        } else if (card) {
            productId = card.dataset.productId;
        }

        if (productId) {
            const product = menu.find(p => String(p.id) === String(productId));
            if (product) {
                openProduct(product);
            }
        }
    });
}

/* =========================================================
   PRODUCT MODAL
========================================================= */
function openProduct(product) {
    selectedProduct = product;
    selectedVariant = 0;
    selectedQuantity = 1;

    if (productOverlay) productOverlay.classList.add("active");
    document.body.classList.add("modal-open");

    if (detailImage) detailImage.innerHTML = productImage(selectedProduct);
    if (detailTitle) detailTitle.textContent = selectedProduct.name;
    if (detailDescription) detailDescription.textContent = selectedProduct.description;

    renderVariants();
    updateProduct();
}

function closeProduct() {
    if (productOverlay) productOverlay.classList.remove("active");
    document.body.classList.remove("modal-open");
    selectedProduct = null;
}

function renderVariants() {
    if (!variantSection || !variantList) return;
    
    if (selectedProduct.options.length <= 1) {
        variantSection.style.display = "none";
        variantList.innerHTML = "";
        return;
    }

    variantSection.style.display = "block";
    variantList.innerHTML = selectedProduct.options.map((option, index) => `
        <label class="variant-option">
            <input type="radio" name="variant" value="${index}" ${index === selectedVariant ? "checked" : ""}>
            <span>${escapeHTML(option.label)}</span>
            <strong>${peso(option.price)}</strong>
        </label>
    `).join("");

    variantList.querySelectorAll("input").forEach(input => {
        input.addEventListener("change", () => {
            selectedVariant = Number(input.value);
            updateProduct();
        });
    });
}

function updateProduct() {
    if (!selectedProduct) return;
    const price = selectedProduct.options[selectedVariant].price;
    if (detailPrice) detailPrice.textContent = peso(price);
    if (quantityValue) quantityValue.textContent = selectedQuantity;
    if (detailTotal) detailTotal.textContent = peso(price * selectedQuantity);
}


/* =========================================================
   CART
========================================================= */
function addToCart() {
    if (!selectedProduct) return;
    const option = selectedProduct.options[selectedVariant];
    const existing = cart.find(item => item.product_id === option.id);

    if (existing) {
        existing.quantity += selectedQuantity;
    } else {
        cart.push({
            product_id: option.id,
            name: selectedProduct.name,
            variant: option.label !== "Regular" ? option.label : "",
            price: option.price,
            quantity: selectedQuantity
        });
    }

    closeProduct();
    updateCart();
    showToast("Added to cart");
}

function updateCart() {
    const count = cart.reduce((sum, item) => sum + item.quantity, 0);
    const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

    if (cartCount) cartCount.textContent = count;
    if (floatingItems) floatingItems.textContent = count + (count === 1 ? " item" : " items");
    if (floatingTotal) floatingTotal.textContent = peso(total);

    const floatingCart = document.getElementById("floatingCart");
    if (floatingCart) {
        if (count > 0) {
            floatingCart.classList.add("active");
            floatingCart.style.display = "flex";
        } else {
            floatingCart.classList.remove("active");
            floatingCart.style.display = "none";
        }
    }

    renderCart();
}

function renderCart() {
    if (!cartList) return;
    
    if (cart.length === 0) {
        cartList.innerHTML = `<div class="empty-cart">Your cart is empty.</div>`;
        if (cartTotal) cartTotal.textContent = peso(0);
        return;
    }

    cartList.innerHTML = cart.map((item, index) => `
        <div class="cart-item">
            <div class="cart-item-info">
                <strong>${escapeHTML(item.name)}</strong>
                <span>${item.variant ? escapeHTML(item.variant) : ""}</span>
                <small>${peso(item.price)} each</small>
            </div>
            <div class="cart-item-actions">
                <button type="button" data-action="decrease" data-index="${index}">−</button>
                <span>${item.quantity}</span>
                <button type="button" data-action="increase" data-index="${index}">+</button>
            </div>
            <strong class="cart-item-total">${peso(item.price * item.quantity)}</strong>
        </div>
    `).join("");

    const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    if (cartTotal) cartTotal.textContent = peso(total);

    cartList.querySelectorAll("button").forEach(button => {
        button.addEventListener("click", () => {
            const index = Number(button.dataset.index);
            const action = button.dataset.action;
            if (action === "increase") {
                cart[index].quantity++;
            } else {
                cart[index].quantity--;
                if (cart[index].quantity <= 0) cart.splice(index, 1);
            }
            updateCart();
        });
    });
}

function openCart() {
    if (cartDrawer) cartDrawer.classList.add("active");
    if (cartOverlay) cartOverlay.classList.add("active");
    document.body.classList.add("modal-open");
}

function closeCart() {
    if (cartDrawer) cartDrawer.classList.remove("active");
    if (cartOverlay) cartOverlay.classList.remove("active");
    document.body.classList.remove("modal-open");
}

/* =========================================================
   CHECKOUT & API SUBMISSION
========================================================= */
function openCheckout() {
    if (cart.length === 0) {
        showToast("Your cart is empty");
        return;
    }
    closeCart();

    // Auto-fill logged in customer name if available
    const customerNameInput = document.getElementById("customerName");
    const savedCustomerName = localStorage.getItem("customer_name") || localStorage.getItem("username");
    if (customerNameInput && savedCustomerName && !customerNameInput.value) {
        customerNameInput.value = savedCustomerName;
    }

    // When customer uses QR code, ensure tableGroup and notesGroup are hidden so only Customer Name and Order Type are visible
    const tableGroup = document.getElementById("tableGroup");
    const notesGroup = document.getElementById("notesGroup");
    const tableInput = document.getElementById("tableNumber");
    const orderTypeEl = document.getElementById("orderType");

    if (tableParam) {
        if (tableGroup) tableGroup.style.display = "none";
        if (notesGroup) notesGroup.style.display = "none";
        if (tableInput) {
            tableInput.value = tableParam;
            tableInput.readOnly = true;
        }
        if (orderTypeEl) {
            orderTypeEl.value = "Dine In";
            orderTypeEl.disabled = true;
        }
    }

    if (checkoutOverlay) checkoutOverlay.classList.add("active");
    document.body.classList.add("modal-open");
}

function closeCheckout() {
    if (checkoutOverlay) checkoutOverlay.classList.remove("active");
    document.body.classList.remove("modal-open");
}

async function submitOrder(event) {
    if (event) event.preventDefault();

    if (cart.length === 0) {
        showToast("Your cart is empty", "danger");
        return;
    }

    const rawName = document.getElementById("customerName") ? document.getElementById("customerName").value.trim() : "";
    const orderTypeEl = document.getElementById("orderType");
    const orderType = orderTypeEl ? orderTypeEl.value : (tableParam ? "Dine In" : "Take Out");
    const tableNumberInput = document.getElementById("tableNumber");
    const tableNumber = (tableNumberInput ? tableNumberInput.value.trim() : "") || tableParam || "";
    const notes = document.getElementById("orderNotes") ? document.getElementById("orderNotes").value : "";
    const customerName = rawName || (tableNumber ? `Table ${tableNumber} Guest` : "Guest Customer");
    
    const submitBtn = event.currentTarget || document.getElementById("placeOrder");
    const originalText = submitBtn ? submitBtn.textContent : "Place Order";
    if (submitBtn) {
        submitBtn.textContent = "Processing...";
        submitBtn.disabled = true;
    }

    try {
        const payload = {
            tenant_id: tenantId,
            customer_name: customerName,
            order_type: orderType,
            table_number: tableNumber,
            notes: notes,
            items: cart.map(item => ({
                product_id: item.product_id,
                quantity: item.quantity
            }))
        };

        const response = await fetch("/api/v1/customer-orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Server returned ${response.status}`);
        }

        const data = await response.json();
        
        if (checkoutContent) checkoutContent.style.display = "none";
        if (success) success.classList.add("active");
        
        const orderNumEl = document.getElementById("orderNumber");
        if (orderNumEl) orderNumEl.textContent = data.order_number;
        const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
        const successTotalEl = document.getElementById("successTotal");
        if (successTotalEl) successTotalEl.textContent = peso(total);

        // Update live status text
        const liveStatusEl = document.getElementById("liveStatusText");
        if (liveStatusEl) {
            liveStatusEl.innerHTML = '<i class="fas fa-clock" style="margin-right:5px; color:#d97706;"></i> Awaiting Cashier Confirmation';
            liveStatusEl.style.color = "#b45309";
        }

        // Save order to persistent customer orders
        const savedOrder = {
            id: data.order_id,
            order_number: data.order_number,
            customer_name: customerName,
            table_number: tableNumber,
            order_type: orderType,
            total_amount: total,
            status: "pending",
            items: cart.map(i => ({ name: i.name, variant: i.variant, price: i.price, quantity: i.quantity })),
            created_at: new Date().toISOString()
        };
        saveCustomerOrder(savedOrder);

        // Clear cart so previous order items don't stay in cart
        cart = [];
        updateCart();
        updateCustomerOrdersBadge();
        startOrderLiveTracking(data.order_number);

    } catch (error) {
        console.error("Order submission failed:", error);
        showToast("Failed to place order. Please try again.");
    } finally {
        if (submitBtn) {
            submitBtn.textContent = originalText;
            submitBtn.disabled = false;
        }
    }
}

/* =========================================================
   TOAST
========================================================= */
let toastTimer;
function showToast(message, type="info") {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        toast.classList.remove("show");
    }, 2200);
}

/* =========================================================
   CUSTOMER AUTHENTICATION & ACCOUNT CREATION
========================================================= */
function updateCustomerAuthUI() {
    const loginBtn = document.getElementById("headerLoginBtn");
    const profileBadge = document.getElementById("customerProfileBadge");
    const greeting = document.getElementById("customerGreeting");
    const customerNameInput = document.getElementById("customerName");

    // Check if customer is authenticated
    const token = localStorage.getItem("access_token");
    const customerName = localStorage.getItem("customer_name") || localStorage.getItem("username");
    const role = (localStorage.getItem("role") || "").toLowerCase();

    if (token && (role === "customer" || customerName)) {
        if (loginBtn) loginBtn.style.display = "none";
        if (profileBadge) {
            profileBadge.style.display = "inline-flex";
            if (greeting) greeting.innerHTML = `<i class="fas fa-user-circle" style="margin-right:5px; color:var(--accent, #c9a227);"></i> ${customerName}`;
        }
        if (customerNameInput && !customerNameInput.value) {
            customerNameInput.value = customerName;
        }
    } else {
        if (loginBtn) loginBtn.style.display = "inline-flex";
        if (profileBadge) profileBadge.style.display = "none";
    }
}

function openCustomerAuthModal(tab = "login") {
    const overlay = document.getElementById("customerAuthOverlay");
    if (!overlay) return;
    overlay.style.display = "flex";
    overlay.classList.add("active");
    document.body.classList.add("modal-open");
    switchCustomerAuthTab(tab);
}

function closeCustomerAuthModal() {
    const overlay = document.getElementById("customerAuthOverlay");
    if (!overlay) return;
    overlay.style.display = "none";
    overlay.classList.remove("active");
    document.body.classList.remove("modal-open");
    const errBanner = document.getElementById("authErrorBanner");
    if (errBanner) errBanner.style.display = "none";
}

function switchCustomerAuthTab(tab) {
    const tLogin = document.getElementById("tabCustomerLogin");
    const tReg = document.getElementById("tabCustomerRegister");
    const fLogin = document.getElementById("customerLoginForm");
    const fReg = document.getElementById("customerRegisterForm");
    const subtitle = document.getElementById("authSubtitle");
    const errBanner = document.getElementById("authErrorBanner");
    if (errBanner) errBanner.style.display = "none";

    if (tab === "register") {
        if (tLogin) {
            tLogin.style.fontWeight = "600";
            tLogin.style.color = "#71717a";
            tLogin.style.borderBottom = "2px solid transparent";
        }
        if (tReg) {
            tReg.style.fontWeight = "800";
            tReg.style.color = "#18181b";
            tReg.style.borderBottom = "2px solid #c9a227";
        }
        if (fLogin) fLogin.style.display = "none";
        if (fReg) fReg.style.display = "block";
        if (subtitle) subtitle.textContent = "Create an account to track orders and save points.";
    } else {
        if (tLogin) {
            tLogin.style.fontWeight = "800";
            tLogin.style.color = "#18181b";
            tLogin.style.borderBottom = "2px solid #c9a227";
        }
        if (tReg) {
            tReg.style.fontWeight = "600";
            tReg.style.color = "#71717a";
            tReg.style.borderBottom = "2px solid transparent";
        }
        if (fLogin) fLogin.style.display = "block";
        if (fReg) fReg.style.display = "none";
        if (subtitle) subtitle.textContent = "Sign in to save your orders & track status.";
    }
}

async function handleCustomerLogin(e) {
    if (e) e.preventDefault();
    const uInput = document.getElementById("loginUsername");
    const pInput = document.getElementById("loginPassword");
    const errBanner = document.getElementById("authErrorBanner");
    const btn = document.getElementById("btnCustomerLogin");
    if (errBanner) errBanner.style.display = "none";

    const username = uInput ? uInput.value.trim() : "";
    const password = pInput ? pInput.value : "";
    if (!username || !password) return;

    if (btn) {
        btn.textContent = "Signing In...";
        btn.disabled = true;
    }

    try {
        const res = typeof Auth !== "undefined" && Auth.login ? 
            await Auth.login(username, password) : 
            await (async () => {
                const params = new URLSearchParams();
                params.append("username", username);
                params.append("password", password);
                const r = await fetch("/api/v1/auth/login", {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: params
                });
                const d = await r.json();
                if (!r.ok) return { success: false, message: d.detail || "Login failed" };
                localStorage.setItem("access_token", d.access_token);
                localStorage.setItem("username", d.username);
                localStorage.setItem("customer_name", d.username);
                localStorage.setItem("role", (d.role || "customer").toLowerCase());
                return { success: true };
            })();

        if (res.success) {
            const storedName = localStorage.getItem("customer_name") || username;
            showToast(`Welcome back, ${storedName}!`);
            closeCustomerAuthModal();
            updateCustomerAuthUI();
        } else {
            if (errBanner) {
                errBanner.textContent = res.message || "Invalid credentials.";
                errBanner.style.display = "block";
            }
        }
    } catch (err) {
        if (errBanner) {
            errBanner.textContent = "Failed to sign in. Please try again.";
            errBanner.style.display = "block";
        }
    } finally {
        if (btn) {
            btn.textContent = "Sign In";
            btn.disabled = false;
        }
    }
}

async function handleCustomerRegister(e) {
    if (e) e.preventDefault();
    const fnInput = document.getElementById("regFirstName");
    const lnInput = document.getElementById("regLastName");
    const uInput = document.getElementById("regUsername");
    const phInput = document.getElementById("regPhone");
    const pwInput = document.getElementById("regPassword");
    const errBanner = document.getElementById("authErrorBanner");
    const btn = document.getElementById("btnCustomerRegister");
    if (errBanner) errBanner.style.display = "none";

    const username = uInput ? uInput.value.trim() : "";
    const password = pwInput ? pwInput.value : "";
    const firstName = fnInput ? fnInput.value.trim() : "";
    const lastName = lnInput ? lnInput.value.trim() : "";
    const phone = phInput ? phInput.value.trim() : "";

    if (!username || !password) return;

    if (btn) {
        btn.textContent = "Creating Account...";
        btn.disabled = true;
    }

    try {
        const payload = {
            username: username,
            password: password,
            first_name: firstName || undefined,
            last_name: lastName || undefined,
            phone: phone || undefined,
            tenant_id: tenantId || 1
        };

        const res = typeof Auth !== "undefined" && Auth.registerCustomer ?
            await Auth.registerCustomer(payload) :
            await (async () => {
                const r = await fetch("/api/v1/auth/customer-register", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                const d = await r.json();
                if (!r.ok) return { success: false, message: d.detail || "Registration failed" };
                localStorage.setItem("access_token", d.access_token);
                localStorage.setItem("username", d.username);
                localStorage.setItem("customer_name", d.customer_name || d.username);
                localStorage.setItem("role", "customer");
                return { success: true, message: d.message };
            })();

        if (res.success) {
            const customerName = localStorage.getItem("customer_name") || username;
            showToast(`Account created! Welcome, ${customerName}!`);
            closeCustomerAuthModal();
            updateCustomerAuthUI();
        } else {
            if (errBanner) {
                errBanner.textContent = res.message || "Could not create account.";
                errBanner.style.display = "block";
            }
        }
    } catch (err) {
        if (errBanner) {
            errBanner.textContent = "Account creation failed. Please check network.";
            errBanner.style.display = "block";
        }
    } finally {
        if (btn) {
            btn.textContent = "Create Account & Sign In";
            btn.disabled = false;
        }
    }
}

function customerLogout() {
    if (typeof Auth !== "undefined" && Auth.logout) {
        localStorage.removeItem("access_token");
        localStorage.removeItem("username");
        localStorage.removeItem("role");
        localStorage.removeItem("customer_name");
        localStorage.removeItem("RESTOTRACK_USER");
    } else {
        localStorage.clear();
    }
    updateCustomerAuthUI();
    showToast("Signed out successfully.");
}

/* =========================================================
   REAL-TIME CUSTOMER ORDER TRACKING & WEBSOCKET ENGINE
========================================================= */
let customerWs = null;
let orderTrackingTimer = null;

function saveCustomerOrder(order) {
    try {
        const list = JSON.parse(localStorage.getItem("customer_orders") || "[]");
        const idx = list.findIndex(o => o.order_number === order.order_number);
        if (idx >= 0) {
            list[idx] = { ...list[idx], ...order };
        } else {
            list.unshift(order);
        }
        localStorage.setItem("customer_orders", JSON.stringify(list.slice(0, 30)));
    } catch (e) {}
}

function getCustomerOrders() {
    try {
        return JSON.parse(localStorage.getItem("customer_orders") || "[]");
    } catch (e) {
        return [];
    }
}

function updateCustomerOrdersBadge() {
    const badge = document.getElementById("custOrdersBadge");
    if (!badge) return;
    const orders = getCustomerOrders();
    const activeOrders = orders.filter(o => o.status !== "completed" && o.status !== "rejected" && o.status !== "cancelled");
    if (activeOrders.length > 0) {
        badge.textContent = activeOrders.length;
        badge.style.display = "inline-block";
    } else if (orders.length > 0) {
        badge.textContent = orders.length;
        badge.style.display = "inline-block";
    } else {
        badge.style.display = "none";
    }
}

function getStatusBadgeHtml(status) {
    const s = (status || "").toLowerCase();
    switch (s) {
        case "pending":
            return '<span style="background:#fef3c7; color:#92400e; font-size:11px; font-weight:700; padding:3px 8px; border-radius:12px;"><i class="fas fa-clock" style="margin-right:4px;"></i> Pending Cashier</span>';
        case "accepted":
        case "preparing":
            return '<span style="background:#dbeafe; color:#1e40af; font-size:11px; font-weight:700; padding:3px 8px; border-radius:12px;"><i class="fas fa-fire-burner" style="margin-right:4px;"></i> Preparing</span>';
        case "ready":
            return '<span style="background:#d1fae5; color:#065f46; font-size:11px; font-weight:700; padding:3px 8px; border-radius:12px;"><i class="fas fa-bell" style="margin-right:4px;"></i> Ready</span>';
        case "completed":
            return '<span style="background:#f3f4f6; color:#374151; font-size:11px; font-weight:700; padding:3px 8px; border-radius:12px;"><i class="fas fa-check-circle" style="margin-right:4px;"></i> Completed</span>';
        case "rejected":
        case "cancelled":
            return '<span style="background:#fee2e2; color:#991b1b; font-size:11px; font-weight:700; padding:3px 8px; border-radius:12px;"><i class="fas fa-times-circle" style="margin-right:4px;"></i> Cancelled</span>';
        default:
            return `<span style="background:#f4f4f5; color:#71717a; font-size:11px; font-weight:700; padding:3px 8px; border-radius:12px;">${status || 'Pending'}</span>`;
    }
}

function openCustomerOrdersModal() {
    const overlay = document.getElementById("customerOrdersOverlay");
    if (overlay) {
        overlay.style.display = "flex";
        overlay.classList.add("active");
        document.body.classList.add("modal-open");
    }
    renderCustomerOrdersModalList();
}

function closeCustomerOrdersModal() {
    const overlay = document.getElementById("customerOrdersOverlay");
    if (overlay) {
        overlay.style.display = "none";
        overlay.classList.remove("active");
        document.body.classList.remove("modal-open");
    }
}

async function renderCustomerOrdersModalList() {
    const listEl = document.getElementById("customerOrdersList");
    if (!listEl) return;

    let orders = getCustomerOrders();
    if (!orders || orders.length === 0) {
        listEl.innerHTML = `
            <div style="text-align: center; color: #71717a; padding: 30px 10px;">
                <div style="font-size: 28px; margin-bottom: 8px; display: block; color: var(--accent, #c9a227);"><i class="fas fa-clipboard-list"></i></div>
                <strong>No active orders found</strong>
                <p style="font-size: 12px; margin-top: 4px;">Orders you place from the menu will appear here live!</p>
            </div>
        `;
        return;
    }

    // Refresh live status for recent orders
    for (const o of orders.slice(0, 5)) {
        if (o.status !== "completed" && o.status !== "rejected" && o.status !== "cancelled") {
            try {
                const res = await fetch(`/api/v1/customer-orders/track/${o.order_number}`);
                if (res.ok) {
                    const trackData = await res.json();
                    if (trackData && trackData.status) {
                        o.status = trackData.status;
                        saveCustomerOrder(o);
                    }
                }
            } catch (e) {}
        }
    }

    listEl.innerHTML = orders.map(o => {
        const itemsStr = (o.items || []).map(i => `${i.quantity}x ${i.name}`).join(", ") || "Menu Items";
        return `
            <div style="padding: 14px; border: 1px solid #e4e4e7; border-radius: 14px; margin-bottom: 12px; background: #fafafa;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <div>
                        <strong style="font-size: 14px; color: #18181b;">${o.order_number}</strong>
                        <span style="font-size: 11px; color: #71717a; margin-left: 6px;">${o.table_number ? 'Table ' + o.table_number : o.order_type || 'Takeout'}</span>
                    </div>
                    ${getStatusBadgeHtml(o.status)}
                </div>
                <div style="font-size: 12px; color: #52525b; margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                    ${itemsStr}
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px;">
                    <span style="font-weight: 800; color: #c9a227; font-size: 14px;">${peso(o.total_amount)}</span>
                    <span style="color: #a1a1aa; font-size: 11px;">${o.created_at ? new Date(o.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ''}</span>
                </div>
            </div>
        `;
    }).join("");

    updateCustomerOrdersBadge();
}

function handleCustomerOrderUpdate(data) {
    if (!data) return;
    const orderNumber = data.order_number;
    const status = data.status;

    const orders = getCustomerOrders();
    const matched = orders.find(o => o.order_number === orderNumber);
    if (matched) {
        matched.status = status;
        saveCustomerOrder(matched);
        updateCustomerOrdersBadge();

        const overlay = document.getElementById("customerOrdersOverlay");
        if (overlay && overlay.classList.contains("active")) {
            renderCustomerOrdersModalList();
        }

        // If current success screen is active with this order, update live text
        const curOrderEl = document.getElementById("orderNumber");
        if (curOrderEl && curOrderEl.textContent.trim() === orderNumber) {
            const liveStatusEl = document.getElementById("liveStatusText");
            if (liveStatusEl) {
                if (status === "accepted" || status === "preparing") {
                    liveStatusEl.innerHTML = '<i class="fas fa-fire-burner" style="margin-right:5px; color:#1e40af;"></i> Order Confirmed & Preparing in Kitchen';
                    liveStatusEl.style.color = "#1e40af";
                } else if (status === "ready") {
                    liveStatusEl.innerHTML = '<i class="fas fa-bell" style="margin-right:5px; color:#065f46;"></i> Order Ready for Pickup / Serving!';
                    liveStatusEl.style.color = "#065f46";
                } else if (status === "completed") {
                    liveStatusEl.innerHTML = '<i class="fas fa-check-circle" style="margin-right:5px; color:#15803d;"></i> Order Completed. Thank you!';
                    liveStatusEl.style.color = "#15803d";
                } else if (status === "rejected" || status === "cancelled") {
                    liveStatusEl.innerHTML = '<i class="fas fa-times-circle" style="margin-right:5px; color:#991b1b;"></i> Order Cancelled';
                    liveStatusEl.style.color = "#991b1b";
                }
            }
        }

        showToast(`Order ${orderNumber} is now ${status.toUpperCase()}!`);
    }
}

function startOrderLiveTracking(orderNumber) {
    if (orderTrackingTimer) clearInterval(orderTrackingTimer);
    orderTrackingTimer = setInterval(async () => {
        try {
            const res = await fetch(`/api/v1/customer-orders/track/${orderNumber}`);
            if (res.ok) {
                const data = await res.json();
                if (data && data.status) {
                    handleCustomerOrderUpdate(data);
                    if (data.status === "completed" || data.status === "rejected" || data.status === "cancelled") {
                        clearInterval(orderTrackingTimer);
                        orderTrackingTimer = null;
                    }
                }
            }
        } catch (e) {}
    }, 4000);
}

function connectCustomerWebSocket() {
    try {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const host = window.location.host;
        if (!host) return;

        const wsUrl = `${protocol}//${host}/api/v1/ws/${tenantId}`;
        customerWs = new WebSocket(wsUrl);

        customerWs.onmessage = (event) => {
            if (event.data === "pong") return;
            try {
                const payload = JSON.parse(event.data);
                if (!payload || !payload.event) return;

                if (payload.event === "ORDER_UPDATED" || payload.event === "CUSTOMER_ORDER_UPDATED") {
                    handleCustomerOrderUpdate(payload.data);
                } else if (payload.event === "INVENTORY_UPDATED" || payload.event === "MENU_UPDATED") {
                    if (typeof fetchMenu === "function") fetchMenu();
                }
            } catch (e) {}
        };

        customerWs.onclose = () => {
            setTimeout(connectCustomerWebSocket, 6000);
        };
    } catch (e) {}
}

// Make accessible to window
window.openCustomerAuthModal = openCustomerAuthModal;
window.closeCustomerAuthModal = closeCustomerAuthModal;
window.switchCustomerAuthTab = switchCustomerAuthTab;
window.handleCustomerLogin = handleCustomerLogin;
window.handleCustomerRegister = handleCustomerRegister;
window.customerLogout = customerLogout;
window.openCustomerOrdersModal = openCustomerOrdersModal;
window.closeCustomerOrdersModal = closeCustomerOrdersModal;
window.renderCustomerOrdersModalList = renderCustomerOrdersModalList;
