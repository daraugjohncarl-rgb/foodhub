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

// Initialize Table Number from URL
const urlParams = new URLSearchParams(window.location.search);
const tableParam = urlParams.get("table");

document.addEventListener("DOMContentLoaded", () => {
    // 1. Table Input
    const tableInput = document.getElementById("tableNumber");
    const orderTypeSelect = document.getElementById("orderType");
    
    if (tableParam && tableInput) {
        tableInput.value = tableParam;
        tableInput.readOnly = true;
        if (orderTypeSelect) {
            orderTypeSelect.value = "Dine In";
            orderTypeSelect.disabled = true;
        }
    }
    
    // 2. Order Button
    const ob = document.getElementById("orderButton");
    const lp = document.getElementById("landingPage");
    
    if (ob) {
        ob.addEventListener("click", () => {
            if (lp) lp.classList.add("is-hidden");
            document.body.classList.remove("landing-active");
            
            const main = document.querySelector("main");
            if (main) main.scrollIntoView({ behavior: "smooth", block: "start" });
            
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
    });

    // 6. Search
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
});

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
        const groupedMap = new Map();

        data.forEach(category => {
            if (category.products && category.products.length > 0) {
                category.products.forEach(product => {
                    let imagePath = resolveImage(product);
                    const parsed = getBaseProductName(product.name);
                    const baseName = parsed.baseName;
                    const variantName = parsed.variantName;
                    
                    const groupKey = category.name + "||" + baseName;
                    
                    if (groupedMap.has(groupKey)) {
                        const existing = groupedMap.get(groupKey);
                        existing.options.push({
                            id: product.id,
                            label: variantName !== "Regular" ? variantName : product.name,
                            price: product.price
                        });
                        if (!existing.image && imagePath) {
                            existing.image = imagePath;
                        }
                    } else {
                        groupedMap.set(groupKey, {
                            id: "group_" + product.id,
                            name: baseName,
                            category: category.name,
                            description: product.description || "",
                            image: imagePath,
                            options: [{
                                id: product.id,
                                label: variantName,
                                price: product.price
                            }]
                        });
                    }
                });
            }
        });
        
        menu = Array.from(groupedMap.values());
        
        if (lp) lp.classList.add("is-hidden");
        
        renderMenu();

    } catch (error) {
        console.error("Error fetching menu:", error);
        showToast("Error loading menu. Please refresh.");
        if (lp) lp.classList.remove("is-loading");
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
        menuList.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--muted);">No products found.</div>`;
        if (menuCount) menuCount.textContent = "0 items";
        return;
    }

    menuList.innerHTML = products.map((product) => {
        const prices = product.options.map(option => option.price);
        const lowest = Math.min(...prices);
        const highest = Math.max(...prices);
        let priceText = lowest === highest ? peso(lowest) : (peso(lowest) + " - " + peso(highest));

        return `
            <article class="menu-item" data-product-id="${product.id}">
                <div class="menu-image">${productImage(product)}</div>
                <div class="menu-info">
                    <div class="menu-category">${escapeHTML(product.category)}</div>
                    <div class="menu-name">${escapeHTML(product.name)}</div>
                    <div class="menu-description">${escapeHTML(product.description)}</div>
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

    const customerName = document.getElementById("customerName") ? document.getElementById("customerName").value : "";
    const orderTypeEl = document.getElementById("orderType");
    const orderType = orderTypeEl ? orderTypeEl.value : "Dine In";
    const tableNumber = document.getElementById("tableNumber") ? document.getElementById("tableNumber").value : "";
    const notes = document.getElementById("orderNotes") ? document.getElementById("orderNotes").value : "";
    
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
