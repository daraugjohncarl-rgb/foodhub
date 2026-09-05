import os

def create_merged_customer_js():
    js_content = """
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

// DOM Elements
const landingPage = document.getElementById("landingPage");
const orderNowButton = document.getElementById("orderNowButton");

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

// Initialize Table Number from URL
const urlParams = new URLSearchParams(window.location.search);
const tableParam = urlParams.get("table");

document.addEventListener("DOMContentLoaded", () => {
    const tableInput = document.getElementById("tableNumber");
    const orderTypeSelect = document.getElementById("orderType");
    
    if (tableParam && tableInput) {
        tableInput.value = tableParam;
        tableInput.readOnly = true;
        if (orderTypeSelect) {
            orderTypeSelect.value = "Dine In";
            // Disable changing order type if QR scan for table
            orderTypeSelect.disabled = true;
        }
    }
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
    landingPage.classList.add("is-loading");

    try {
        const response = await fetch(`/api/v1/customer-orders/menu?tenant_id=${tenantId}`);
        if (!response.ok) throw new Error("Failed to load menu data");
        const data = await response.json();
        
        // Transform the backend data format to match the new UI's expected format
        menu = [];
        data.forEach(category => {
            if (category.products && category.products.length > 0) {
                category.products.forEach(product => {
                    // Try to extract image, or use placeholder
                    let imagePath = "images/box.png";
                    if (product.image_url) {
                        imagePath = product.image_url;
                    }
                    
                    // The backend variants (if any) are not fully structured in this endpoint typically,
                    // but if the backend provides product.price, we format it as an option.
                    // If your backend supports actual variants in this endpoint, adjust here.
                    let options = [["Regular", product.price]];
                    
                    menu.push({
                        id: product.id,
                        name: product.name,
                        category: category.name,
                        description: product.description || "",
                        image: imagePath,
                        options: options
                    });
                });
            }
        });
        
        landingPage.classList.add("is-hidden");
        
        // Auto-generate category buttons
        const categoryNav = document.querySelector('.category-nav');
        if (categoryNav) {
            const uniqueCategories = [...new Set(menu.map(p => p.category))];
            
            // Keep Popular (All)
            let catHTML = `<button class="category active" type="button" data-category="All">Popular</button>`;
            
            uniqueCategories.forEach(cat => {
                catHTML += `<button class="category" type="button" data-category="${escapeHTML(cat)}">${escapeHTML(cat)}</button>`;
            });
            categoryNav.innerHTML = catHTML;
            
            // Re-attach listeners
            document.querySelectorAll(".category").forEach(button => {
                button.addEventListener("click", () => {
                    activeCategory = button.dataset.category;
                    document.querySelectorAll(".category").forEach(item => {
                        item.classList.toggle("active", item === button);
                    });
                    menuTitle.textContent = activeCategory;
                    renderMenu();
                });
            });
        }
        
        renderMenu();

    } catch (error) {
        console.error("Error fetching menu:", error);
        showToast("Error loading menu. Please refresh.");
        landingPage.classList.remove("is-loading");
    }
}

if (orderNowButton) {
    orderNowButton.addEventListener("click", fetchMenu);
}


/* =========================================================
   PRODUCT IMAGE
========================================================= */
function productImage(product) {
    return `
        <img
            src="${product.image}"
            alt="${escapeHTML(product.name)}"
            onerror="
                this.style.display='none';
                this.parentElement
                    .querySelector('.image-placeholder')
                    .style.display='flex';
            "
        >
        <div class="image-placeholder" style="display:none;">
            ${escapeHTML(product.name)}
        </div>
    `;
}

/* =========================================================
   FILTER & RENDER MENU
========================================================= */
function getFilteredProducts() {
    return menu.filter(product => {
        const categoryMatch = activeCategory === "All" || product.category === activeCategory;
        const searchable = (
            product.name + " " + product.category + " " + product.description + " " +
            product.options.map(option => option[0]).join(" ")
        ).toLowerCase();
        const searchMatch = searchable.includes(searchTerm.toLowerCase());
        return categoryMatch && searchMatch;
    });
}

function renderMenu() {
    const products = getFilteredProducts();

    if (products.length === 0) {
        menuList.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--muted);">No products found.</div>`;
        menuCount.textContent = "0 items";
        return;
    }

    menuList.innerHTML = products.map((product) => {
        const originalIndex = menu.indexOf(product);
        const prices = product.options.map(option => option[1]);
        const lowest = Math.min(...prices);
        const highest = Math.max(...prices);
        let priceText = lowest === highest ? peso(lowest) : (peso(lowest) + " - " + peso(highest));

        return `
            <article class="menu-item" data-index="${originalIndex}">
                <div class="menu-image">${productImage(product)}</div>
                <div class="menu-info">
                    <div class="menu-category">${escapeHTML(product.category)}</div>
                    <div class="menu-name">${escapeHTML(product.name)}</div>
                    <div class="menu-description">${escapeHTML(product.description)}</div>
                    <div class="menu-bottom">
                        <div class="menu-price">${priceText}</div>
                        <button class="select-button" type="button" data-index="${originalIndex}">Select</button>
                    </div>
                </div>
            </article>
        `;
    }).join("");

    menuCount.textContent = products.length + (products.length === 1 ? " item" : " items");

    menuList.querySelectorAll(".menu-item").forEach(card => {
        card.addEventListener("click", event => {
            if (event.target.closest(".select-button")) return;
            openProduct(Number(card.dataset.index));
        });
    });

    menuList.querySelectorAll(".select-button").forEach(button => {
        button.addEventListener("click", (e) => {
            e.stopPropagation();
            openProduct(Number(button.dataset.index));
        });
    });
}

/* =========================================================
   PRODUCT MODAL
========================================================= */
function openProduct(index) {
    selectedProduct = menu[index];
    selectedVariant = 0;
    selectedQuantity = 1;

    productOverlay.classList.add("active");
    document.body.classList.add("modal-open");

    detailImage.innerHTML = productImage(selectedProduct);
    detailTitle.textContent = selectedProduct.name;
    detailDescription.textContent = selectedProduct.description;

    renderVariants();
    updateProduct();
}

function closeProduct() {
    productOverlay.classList.remove("active");
    document.body.classList.remove("modal-open");
}

function renderVariants() {
    if (selectedProduct.options.length <= 1) {
        variantSection.style.display = "none";
        variantList.innerHTML = "";
        return;
    }

    variantSection.style.display = "block";
    variantList.innerHTML = selectedProduct.options.map((option, index) => `
        <label class="variant-option">
            <input type="radio" name="variant" value="${index}" ${index === selectedVariant ? "checked" : ""}>
            <span>${escapeHTML(option[0])}</span>
            <strong>${peso(option[1])}</strong>
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
    const price = selectedProduct.options[selectedVariant][1];
    detailPrice.textContent = peso(price);
    quantityValue.textContent = selectedQuantity;
    detailTotal.textContent = peso(price * selectedQuantity);
}

document.getElementById("closeProduct").addEventListener("click", closeProduct);
document.getElementById("decreaseQuantity").addEventListener("click", () => {
    if (selectedQuantity > 1) {
        selectedQuantity--;
        updateProduct();
    }
});
document.getElementById("increaseQuantity").addEventListener("click", () => {
    selectedQuantity++;
    updateProduct();
});
document.getElementById("addToCart").addEventListener("click", addToCart);
productOverlay.addEventListener("click", event => {
    if (event.target === productOverlay) closeProduct();
});

/* =========================================================
   CART
========================================================= */
function addToCart() {
    const option = selectedProduct.options[selectedVariant];
    const existing = cart.find(item => item.product_id === selectedProduct.id && item.variant === option[0]);

    if (existing) {
        existing.quantity += selectedQuantity;
    } else {
        cart.push({
            product_id: selectedProduct.id,
            name: selectedProduct.name,
            variant: option[0],
            price: option[1],
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

    cartCount.textContent = count;
    floatingItems.textContent = count + (count === 1 ? " item" : " items");
    floatingTotal.textContent = peso(total);

    if (count > 0) {
        document.getElementById("floatingCart").classList.add("active");
    } else {
        document.getElementById("floatingCart").classList.remove("active");
    }

    renderCart();
}

function renderCart() {
    if (cart.length === 0) {
        cartList.innerHTML = `<div class="empty-cart">Your cart is empty.</div>`;
        cartTotal.textContent = peso(0);
        return;
    }

    cartList.innerHTML = cart.map((item, index) => `
        <div class="cart-item">
            <div class="cart-item-info">
                <strong>${escapeHTML(item.name)}</strong>
                <span>${item.variant !== "Regular" ? escapeHTML(item.variant) : ""}</span>
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
    cartTotal.textContent = peso(total);

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
    cartDrawer.classList.add("active");
    cartOverlay.classList.add("active");
    document.body.classList.add("modal-open");
}

function closeCart() {
    cartDrawer.classList.remove("active");
    cartOverlay.classList.remove("active");
    document.body.classList.remove("modal-open");
}

document.getElementById("headerCart").addEventListener("click", openCart);
document.getElementById("closeCart").addEventListener("click", closeCart);
cartOverlay.addEventListener("click", closeCart);
document.getElementById("floatingCart").addEventListener("click", openCart);

/* =========================================================
   SEARCH
========================================================= */
const searchInput = document.getElementById("searchInput");
if (searchInput) {
    searchInput.addEventListener("input", event => {
        searchTerm = event.target.value;
        renderMenu();
    });
}

/* =========================================================
   CHECKOUT & API SUBMISSION
========================================================= */
const checkoutOverlay = document.getElementById("checkoutOverlay");
const checkoutContent = document.getElementById("checkoutContent");
const success = document.getElementById("success");

document.getElementById("checkoutButton").addEventListener("click", openCheckout);
document.getElementById("closeCheckout").addEventListener("click", closeCheckout);
checkoutOverlay.addEventListener("click", event => {
    if (event.target === checkoutOverlay) closeCheckout();
});
document.getElementById("checkoutForm").addEventListener("submit", submitOrder);
document.getElementById("doneButton").addEventListener("click", () => {
    closeCheckout();
    success.classList.remove("active");
    checkoutContent.style.display = "block";
    cart = [];
    updateCart();
    
    // Switch to landing page or scroll to top
    window.scrollTo(0, 0);
});

function openCheckout() {
    if (cart.length === 0) {
        showToast("Your cart is empty");
        return;
    }
    checkoutOverlay.classList.add("active");
    document.body.classList.add("modal-open");
}

function closeCheckout() {
    checkoutOverlay.classList.remove("active");
    document.body.classList.remove("modal-open");
}

async function submitOrder(event) {
    event.preventDefault();

    if (cart.length === 0) {
        showToast("Your cart is empty", "danger");
        return;
    }

    const customerName = document.getElementById("customerName").value;
    // For new UI, orderType is standard select or input, get value
    const orderTypeEl = document.getElementById("orderType");
    const orderType = orderTypeEl ? orderTypeEl.value : "Dine In";
    const tableNumber = document.getElementById("tableNumber").value;
    const notes = document.getElementById("orderNotes").value;
    
    const submitBtn = event.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = "Processing...";
    submitBtn.disabled = true;

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
        
        // Hide checkout, show success with real order number
        checkoutContent.style.display = "none";
        success.classList.add("active");
        
        document.getElementById("orderNumber").textContent = data.order_number;
        const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
        document.getElementById("successTotal").textContent = peso(total);

    } catch (error) {
        console.error("Order submission failed:", error);
        showToast("Failed to place order. Please try again.");
    } finally {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
}

/* =========================================================
   TOAST
========================================================= */
let toastTimer;
function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        toast.classList.remove("show");
    }, 2200);
}
"""
    with open('fastapi/static/js/customer.js', 'w', encoding='utf-8') as f:
        f.write(js_content)

if __name__ == '__main__':
    create_merged_customer_js()
