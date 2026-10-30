/**
 * UI Utilities, Modals, Toasts, Receipt Printing & Formatting
 */

const Utils = {
  /** Escape text before interpolating it into an HTML string (customer-controlled data!). */
  escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (ch) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
  },

  /** Value for an inline event-handler argument: a JSON string literal, then HTML-escaped (HTML escaping alone is not enough inside JS). */
  jsArg(value) {
    return this.escapeHtml(JSON.stringify(String(value === null || value === undefined ? "" : value)));
  },

  showToast(msg, type = "info") {
    // Toast notifications erased across the system
    return;
  },

  openModal(title, bodyHTML, footerHTML = "", size = "") {
    let container = document.getElementById("modal-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "modal-container";
      container.className = "modal-overlay";
      container.innerHTML = '<div class="modal" id="modal-content"></div>';
      container.addEventListener("click", (e) => {
        if (e.target === container) Utils.closeModal();
      });
      document.body.appendChild(container);
    } else if (!container.dataset.backdropBound) {
      container.dataset.backdropBound = "true";
      container.addEventListener("click", (e) => {
        if (e.target === container) Utils.closeModal();
      });
    }

    const content = document.getElementById("modal-content");
    content.className = "modal " + (size || "");
    content.removeAttribute("style");
    content.innerHTML = `
      <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-bottom:1px solid rgba(205,190,150,0.25);">
        <h3 style="font-size:16px; font-weight:700; color:var(--text-main, #18181b); margin:0;">${title}</h3>
        <button type="button" class="btn-icon" onclick="Utils.closeModal()" style="border:none; background:transparent; cursor:pointer; font-size:18px; color:var(--text-muted); display:inline-flex; align-items:center; justify-content:center; width:44px; height:44px; min-width:44px; min-height:44px; border-radius:8px;" aria-label="Close dialog"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body" style="padding:16px 18px; overflow-y:auto; max-height:calc(85dvh - 120px);">${bodyHTML}</div>
      ${(footerHTML && footerHTML !== "undefined") ? `<div class="modal-footer" style="padding:12px 18px; border-top:1px solid rgba(205,190,150,0.25); display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap;">${footerHTML}</div>` : ''}
    `;

    container.classList.remove("hidden");
    container.style.display = "flex";
    document.body.style.overflow = "hidden";
  },

  closeModal() {
    const container = document.getElementById("modal-container");
    if (container) {
      container.classList.add("hidden");
      container.style.display = "none";
    }
    const content = document.getElementById("modal-content");
    if (content) {
      content.className = "modal";
      content.removeAttribute("style");
    }
    const sidebar = document.getElementById("sidebar");
    if (!sidebar || !sidebar.classList.contains("open")) {
      document.body.style.overflow = "";
    }
  },

  confirmAction(title, msg, onConfirm) {
    this.openModal(
      title,
      `<p style="margin: 0.5rem 0; color: var(--text-main); font-size: 0.95rem;">${msg}</p>`,
      `
        <button class="btn btn-outline" onclick="Utils.closeModal()">Cancel</button>
        <button class="btn btn-danger" id="confirm-btn-action">Confirm</button>
      `
    );
    document.getElementById("confirm-btn-action").onclick = () => {
      this.closeModal();
      onConfirm();
    };
  },

  formatCurrency(amount) {
    const num = Number(amount) || 0;
    return "₱" + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  formatId(prefix, id, digits = 4) {
    if (!id && id !== 0) return '—';
    if (typeof id === 'string' && id.includes('-') && !/^[0-9a-f]{8}-/i.test(id)) {
      return id;
    }
    const num = parseInt(id, 10);
    if (isNaN(num)) return `${prefix}-${id}`;
    return `${prefix}-${String(num).padStart(digits, '0')}`;
  },

  exportCSV(filename, rows) {
    if (!rows || !rows.length) {
      this.showToast("No data to export", "danger");
      return;
    }
    const headers = Object.keys(rows[0]).join(",");
    const csvLines = rows.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const csvContent = "data:text/csv;charset=utf-8," + [headers, ...csvLines].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `${filename}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    this.showToast("CSV exported successfully", "success");
  },

generateReceiptHTML(order, isPrint = false) {
    if (!order) return '<div style="padding:20px; text-align:center; color:#71717a;">No receipt data available.</div>';

    const items = order.items || [];
    const itemsHtml = items.map(it => {
      const name = it.name || (it.product ? it.product.name : `Item #${it.product_id || ''}`);
      const qty = Number(it.quantity || it.qty || 1);
      const unitPrice = Number(it.unit_price !== undefined ? it.unit_price : (it.price !== undefined ? it.price : 0));
      const lineTotal = Number(it.total_price !== undefined ? it.total_price : (unitPrice * qty));
      return `
        <div class="receipt-item-row" style="display:flex; justify-content:space-between; align-items:flex-start; padding:5px 0; border-bottom:1px dotted #e4e4e7; font-size:12px;">
          <div class="receipt-item-name" style="flex:1; padding-right:8px; word-break:break-word; text-align:left;">
            <div style="font-weight:700; color:#18181b;">${name}</div>
            <div class="receipt-item-qty" style="font-size:11px; color:#71717a;">${qty} x ₱${unitPrice.toFixed(2)}</div>
          </div>
          <div class="receipt-item-price" style="white-space:nowrap; font-weight:700; color:#18181b; text-align:right;">
            ₱${lineTotal.toFixed(2)}
          </div>
        </div>
      `;
    }).join("");

    const rawDate = order.date || order.created_at || new Date().toISOString();
    let dateStr = "—";
    try {
      dateStr = new Date(rawDate).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    } catch (e) {
      dateStr = String(rawDate);
    }

    const cashierName = order.cashier || order.cashier_name || "Staff";
    let receiptNo = order.receiptNumber || order.receipt_no || "N/A";
    if (order.id && (!receiptNo || receiptNo === "N/A" || receiptNo.length > 20)) {
      receiptNo = (typeof Utils !== 'undefined' && Utils.formatId) ? Utils.formatId('TXN', order.id) : `TXN-${String(order.id).padStart(4, '0')}`;
    }
    const orderCode = order.orderCode || order.order_code || receiptNo;

    // Financial calculations
    const subtotal = Number(order.total_amount !== undefined ? order.total_amount : (order.net_amount || 0));
    const discount = Number(order.discount_amount || 0);
    const tax = Number(order.tax_amount || 0);
    const netTotal = Number(order.net_amount !== undefined ? order.net_amount : (subtotal - discount));

    // Payments
    let paymentMethod = (order.payment_method || (order.payments && order.payments[0] && order.payments[0].payment_method) || "Cash").toUpperCase();
    const paymentStatus = (order.payment_status || order.status || "COMPLETED").toUpperCase();
    const amountPaid = Number(order.amount_paid !== undefined ? order.amount_paid : ((order.payments && order.payments[0] && order.payments[0].amount) || netTotal));
    const change = order.change !== undefined ? Number(order.change) : Math.max(0, amountPaid - netTotal);

    return `
      <div class="receipt-paper" style="background:#ffffff; color:#18181b; font-family:'Courier New', Courier, monospace; width:100%; max-width:380px; margin:0 auto; padding:${isPrint ? '10px 8px' : '22px 18px'}; border-radius:8px; box-sizing:border-box;">
        
        <!-- HEADER -->
        <div class="receipt-header-center" style="text-align:center; margin-bottom:12px;">
          <img src="/static/images/blessie.png" alt="Blessie FoodHub Logo" class="receipt-logo-img" style="width:58px; height:58px; object-fit:contain; border-radius:50%; margin:0 auto 6px auto; display:block; background:#ffffff; border:1px solid rgba(205,190,150,0.4); padding:2px;" onerror="this.onerror=null; this.src='/images/blessie.png';">
          <h2 class="receipt-brand-title" style="font-family:'Inter', -apple-system, sans-serif; font-size:18px; font-weight:800; letter-spacing:0.5px; margin:0 0 2px 0; color:#18181b;">BLESSIE FOODHUB</h2>
          <div class="receipt-subtitle" style="font-size:11px; font-weight:700; color:#52525b; letter-spacing:0.5px; margin-bottom:4px;">COFFEE &amp; COMFORT FOOD</div>
          <div class="receipt-address" style="font-size:11px; color:#71717a; margin:1px 0;">INBOX, Bago City, Negros Occidental</div>
          <div class="receipt-contact" style="font-size:11px; color:#71717a; margin:1px 0;">Tel: (034) 123-4567 &bull; Mobile: +63 912 345 6789</div>
        </div>

        <div class="receipt-divider" style="border-top:1px dashed #a1a1aa; margin:10px 0;"></div>

        <!-- TRANSACTION METADATA -->
        <div style="font-size:11px; line-height:1.6; color:#3f3f46;">
          <div class="receipt-meta-row" style="display:flex; justify-content:space-between;">
            <span>Receipt No:</span>
            <strong style="color:#18181b;">${receiptNo}</strong>
          </div>
          <div class="receipt-meta-row" style="display:flex; justify-content:space-between;">
            <span>Order Code:</span>
            <strong style="color:#18181b;">${orderCode}</strong>
          </div>
          <div class="receipt-meta-row" style="display:flex; justify-content:space-between;">
            <span>Date &amp; Time:</span>
            <span>${dateStr}</span>
          </div>
          <div class="receipt-meta-row" style="display:flex; justify-content:space-between;">
            <span>Cashier:</span>
            <strong style="color:#18181b;">${cashierName}</strong>
          </div>
          ${order.table_number ? `
          <div class="receipt-meta-row" style="display:flex; justify-content:space-between;">
            <span>Table / Dine:</span>
            <strong style="color:#c9a227;">Table ${order.table_number}</strong>
          </div>
          ` : ''}
        </div>

        <div class="receipt-divider" style="border-top:1px dashed #a1a1aa; margin:10px 0;"></div>

        <!-- ITEMIZED SUMMARY HEADER -->
        <div style="display:flex; justify-content:space-between; font-size:11px; font-weight:700; color:#71717a; text-transform:uppercase; margin-bottom:6px; letter-spacing:0.5px;">
          <span>Item &amp; Qty</span>
          <span>Amount</span>
        </div>

        <!-- ITEMS LIST (FOOD + DRINKS + ALL PRODUCTS) -->
        <div style="margin-bottom:8px;">
          ${itemsHtml.length ? itemsHtml : '<div style="text-align:center; padding:10px; font-size:12px; color:#71717a;">No items found</div>'}
        </div>

        <div class="receipt-divider" style="border-top:1px dashed #a1a1aa; margin:10px 0;"></div>

        <!-- TOTALS BREAKDOWN -->
        <div style="font-size:12px; line-height:1.7; color:#3f3f46;">
          <div class="receipt-total-row" style="display:flex; justify-content:space-between;">
            <span>Subtotal:</span>
            <span>₱${subtotal.toFixed(2)}</span>
          </div>
          ${discount > 0 ? `
          <div class="receipt-total-row" style="display:flex; justify-content:space-between; color:#ef4444;">
            <span>Discount:</span>
            <span>-₱${discount.toFixed(2)}</span>
          </div>
          ` : ''}
          ${tax > 0 ? `
          <div class="receipt-total-row" style="display:flex; justify-content:space-between;">
            <span>Tax / VAT:</span>
            <span>₱${tax.toFixed(2)}</span>
          </div>
          ` : ''}
          
          <div class="receipt-total-row grand-total" style="display:flex; justify-content:space-between; font-size:16px; font-weight:800; color:#18181b; margin-top:6px; padding-top:6px; border-top:1px solid #18181b;">
            <span>TOTAL AMOUNT:</span>
            <span style="color:#18181b;">₱${netTotal.toFixed(2)}</span>
          </div>
        </div>

        <div class="receipt-divider" style="border-top:1px dashed #a1a1aa; margin:10px 0;"></div>

        <!-- PAYMENT INFORMATION -->
        <div style="font-size:11px; line-height:1.7; color:#3f3f46;">
          <div class="receipt-meta-row" style="display:flex; justify-content:space-between;">
            <span>Payment Method:</span>
            <strong style="color:#18181b;">${paymentMethod}</strong>
          </div>
          <div class="receipt-meta-row" style="display:flex; justify-content:space-between;">
            <span>Payment Status:</span>
            <strong style="color:#10b981;">${paymentStatus}</strong>
          </div>
          <div class="receipt-meta-row" style="display:flex; justify-content:space-between;">
            <span>Amount Tendered:</span>
            <span>₱${amountPaid.toFixed(2)}</span>
          </div>
          ${paymentMethod.includes('CASH') ? `
          <div class="receipt-meta-row" style="display:flex; justify-content:space-between;">
            <span>Change:</span>
            <strong style="color:#10b981;">₱${change.toFixed(2)}</strong>
          </div>
          ` : ''}
        </div>

        <div class="receipt-divider" style="border-top:1px dashed #a1a1aa; margin:10px 0;"></div>

        <!-- FOOTER MESSAGE -->
        <div class="receipt-footer-center" style="text-align:center; font-size:11px; color:#52525b; margin-top:12px;">
          <p style="margin:2px 0; font-weight:700; letter-spacing:0.5px;">*** THANK YOU FOR YOUR VISIT! ***</p>
          <p style="margin:2px 0;">Please come again!</p>
          <p style="margin:4px 0 0 0; font-size:10px; color:#a1a1aa;">Blessie FoodHub POS System</p>
        </div>

      </div>
    `;
  },

  printReceipt(order) {
    if (!order) order = window.currentReceiptOrder;
    if (!order) {
      this.showToast("No receipt data available to print.", "warning");
      return;
    }

    let receiptEl = document.getElementById("printReceipt");
    if (!receiptEl) {
      receiptEl = document.createElement("div");
      receiptEl.id = "printReceipt";
      document.body.appendChild(receiptEl);
    }
    
    // Store original order on window for print button
    window.currentReceiptOrder = order;

    receiptEl.innerHTML = this.generateReceiptHTML(order, true);
    setTimeout(() => {
      window.print();
    }, 120);
  },

  showReceiptModal(order, customTitle) {
    if (!order) return;
    window.currentReceiptOrder = order;

    const html = this.generateReceiptHTML(order, false);
    const receiptNo = order.receiptNumber || order.receipt_no || (order.id ? ((typeof Utils !== 'undefined' && Utils.formatId) ? Utils.formatId('TXN', order.id) : `TXN-${String(order.id).padStart(4, '0')}`) : 'Receipt');

    const cancelBtn = (order.id && (order.status === 'pending' || order.status === 'preparing')) ? `
      <button class="btn btn-outline" onclick="Utils.closeModal(); if (typeof promptRejectOrder === 'function') promptRejectOrder(${order.id});" style="border-color:#ef4444; color:#ef4444; font-size:12px; font-weight:700;" title="Cancel & Reject Order">
        <i class="fas fa-ban"></i> Cancel Order
      </button>
    ` : '';

    const footer = `
      <div style="display:flex; justify-content:space-between; align-items:center; width:100%; gap:10px; flex-wrap:wrap;">
        <div>
          ${cancelBtn}
        </div>
        <div style="display:flex; gap:8px;">
          <button type="button" class="btn btn-outline" onclick="Utils.closeModal()" style="padding:8px 18px; font-size:13px; font-weight:600;">
            <i class="fas fa-times"></i> Close Preview
          </button>
          <button type="button" class="btn btn-primary" onclick="Utils.printReceipt(window.currentReceiptOrder)" style="padding:8px 20px; font-size:13px; font-weight:700; background:linear-gradient(135deg, #c9a227, #987719); border:none; box-shadow:0 4px 12px rgba(201,162,39,0.25);">
            <i class="fas fa-print" style="margin-right:6px;"></i> Print Receipt
          </button>
        </div>
      </div>
    `;

    const title = customTitle || `<i class="fas fa-receipt" style="color:#c9a227; margin-right:8px;"></i> Receipt Preview — ${receiptNo}`;
    this.openModal(title, html, footer);
  },

  initTheme() {
    const savedTheme = localStorage.getItem("RESTOTRACK_THEME") || "light";
    document.body.setAttribute("data-theme", savedTheme);

    const toggleBtn = document.getElementById("btn-dark-mode");
    if (toggleBtn) {
      toggleBtn.onclick = () => {
        const isDark = document.body.getAttribute("data-theme") === "dark";
        const next = isDark ? "light" : "dark";
        document.body.setAttribute("data-theme", next);
        localStorage.setItem("RESTOTRACK_THEME", next);
      };
    }
  },

  toggleMobileSidebar(forceState) {
    const sidebar = document.getElementById("sidebar");
    let sidebarOverlay = document.getElementById("sidebarOverlay");
    if (!sidebarOverlay) {
      sidebarOverlay = document.createElement("div");
      sidebarOverlay.id = "sidebarOverlay";
      sidebarOverlay.className = "sidebar-overlay";
      document.body.appendChild(sidebarOverlay);
    }
    const mobileMenuBtns = document.querySelectorAll(".mobile-menu-btn, #mobileMenuBtn");
    const sidebarToggle = document.getElementById("sidebarToggle");
    if (!sidebar) return;

    const isMobile = window.innerWidth <= 1024;
    const currentState = sidebar.classList.contains("open");
    const isOpen = typeof forceState === "boolean" ? forceState : !currentState;

    sidebar.classList.toggle("open", isOpen);
    if (sidebarOverlay) sidebarOverlay.classList.toggle("open", isOpen);

    if (isOpen && isMobile) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    // Synchronize all hamburger / close trigger icons
    mobileMenuBtns.forEach(btn => {
      btn.innerHTML = isOpen ? '<i class="fas fa-times"></i>' : '<i class="fas fa-bars"></i>';
      btn.setAttribute('title', isOpen ? 'Close Menu' : 'Open Menu');
      btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    if (sidebarToggle) {
      if (isMobile) {
        sidebarToggle.innerHTML = isOpen ? '<i class="fas fa-times"></i>' : '<i class="fas fa-bars"></i>';
        sidebarToggle.setAttribute('title', isOpen ? 'Close Menu' : 'Open Menu');
      } else {
        const isCollapsed = sidebar.classList.contains("collapsed");
        sidebarToggle.innerHTML = '<i class="fas fa-bars"></i>';
        sidebarToggle.setAttribute('title', isCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar');
      }
    }
  },

  initSidebar() {
    const sidebar = document.getElementById("sidebar");
    const sidebarToggle = document.getElementById("sidebarToggle");
    let sidebarOverlay = document.getElementById("sidebarOverlay");
    const mainContent = document.querySelector(".main-content") || document.getElementById("mainContent");

    if (!sidebar) return;

    // Guarantee that an overlay exists in the DOM for mobile dismissal
    if (!sidebarOverlay) {
      sidebarOverlay = document.createElement("div");
      sidebarOverlay.id = "sidebarOverlay";
      sidebarOverlay.className = "sidebar-overlay";
      document.body.appendChild(sidebarOverlay);
    }

    window.toggleMobileSidebar = (forceState) => this.toggleMobileSidebar(forceState);

    const isMobile = () => window.innerWidth <= 1024;

    const updateIcon = (collapsed) => {
      if (!sidebarToggle) return;
      if (isMobile()) {
        sidebarToggle.innerHTML = sidebar.classList.contains('open') ? '<i class="fas fa-times"></i>' : '<i class="fas fa-bars"></i>';
        sidebarToggle.setAttribute('title', sidebar.classList.contains('open') ? 'Close Menu' : 'Open Menu');
      } else {
        sidebarToggle.innerHTML = '<i class="fas fa-bars"></i>';
        sidebarToggle.setAttribute('title', collapsed ? 'Expand Sidebar' : 'Collapse Sidebar');
      }
    };

    // Apply saved state on load (desktop only)
    const savedCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';
    if (!isMobile() && savedCollapsed) {
      sidebar.classList.add('collapsed');
      document.body.classList.add('sidebar-collapsed');
      if (mainContent) mainContent.classList.add('sidebar-collapsed');
      updateIcon(true);
    } else {
      sidebar.classList.remove('collapsed');
      document.body.classList.remove('sidebar-collapsed');
      if (mainContent) mainContent.classList.remove('sidebar-collapsed');
      updateIcon(false);
    }

    // Bind sidebarToggle (desktop collapse or mobile close)
    if (sidebarToggle && !sidebarToggle.dataset.bound) {
      sidebarToggle.dataset.bound = "true";
      sidebarToggle.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (isMobile()) {
          this.toggleMobileSidebar();
        } else {
          const isCollapsed = sidebar.classList.toggle('collapsed');
          document.body.classList.toggle('sidebar-collapsed', isCollapsed);
          if (mainContent) mainContent.classList.toggle('sidebar-collapsed', isCollapsed);
          updateIcon(isCollapsed);
          localStorage.setItem('sidebar_collapsed', isCollapsed ? 'true' : 'false');
        }
      });
    }

    // Bind all mobile menu trigger buttons (in header or mobile bottom nav)
    const bindTriggers = () => {
      document.querySelectorAll(".mobile-menu-btn, #mobileMenuBtn, #mobileNavMoreBtn").forEach(btn => {
        if (!btn.dataset.bound) {
          btn.dataset.bound = "true";
          btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleMobileSidebar();
          });
        }
      });
    };
    bindTriggers();
    window.bindMobileNavTriggers = bindTriggers;

    // Overlay click to close
    if (sidebarOverlay && !sidebarOverlay.dataset.bound) {
      sidebarOverlay.dataset.bound = "true";
      sidebarOverlay.addEventListener("click", (e) => {
        e.preventDefault();
        this.toggleMobileSidebar(false);
      });
    }

    // Auto-close on nav-link clicks on mobile (event delegation for dynamically created links)
    sidebar.addEventListener("click", (e) => {
      const link = e.target.closest(".nav-link, .logout-btn");
      if (link && isMobile()) {
        this.toggleMobileSidebar(false);
      }
    });

    // Close modal or sidebar on Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.key === "Esc") {
        const modalContainer = document.getElementById("modal-container");
        if (modalContainer && !modalContainer.classList.contains("hidden") && modalContainer.style.display !== "none") {
          this.closeModal();
          return;
        }
        const openModals = document.querySelectorAll('.modal-overlay:not(.hidden)');
        let closedAny = false;
        openModals.forEach(m => {
          if (m.style.display !== 'none' && m.id !== 'sidebarOverlay') {
            m.style.display = 'none';
            m.classList.add('hidden');
            closedAny = true;
          }
        });
        if (closedAny) {
          const sb = document.getElementById("sidebar");
          if (!sb || !sb.classList.contains("open")) {
            document.body.style.overflow = "";
          }
          return;
        }
        if (sidebar && sidebar.classList.contains("open")) {
          this.toggleMobileSidebar(false);
        }
      }
    });

    // Dismiss any modal overlay when its backdrop is clicked
    document.addEventListener("click", (e) => {
      if (e.target && e.target.classList && e.target.classList.contains("modal-overlay")) {
        e.target.style.display = "none";
        e.target.classList.add("hidden");
        const sb = document.getElementById("sidebar");
        if (!sb || !sb.classList.contains("open")) {
          document.body.style.overflow = "";
        }
      }
    });

    // Mobile Swipe Left to Close gesture
    let touchStartX = 0;
    let touchStartY = 0;
    sidebar.addEventListener("touchstart", (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    sidebar.addEventListener("touchend", (e) => {
      const deltaX = e.changedTouches[0].clientX - touchStartX;
      const deltaY = Math.abs(e.changedTouches[0].clientY - touchStartY);
      if (deltaX < -45 && deltaY < 80) {
        this.toggleMobileSidebar(false);
      }
    }, { passive: true });

    // Floating accessible tooltip for desktop collapsed sidebar items
    let tooltipEl = document.getElementById("sidebar-floating-tooltip");
    if (!tooltipEl) {
      tooltipEl = document.createElement("div");
      tooltipEl.id = "sidebar-floating-tooltip";
      tooltipEl.style.cssText = "position:fixed; background:#18181b; color:#f4f4f5; font-size:12px; font-weight:600; padding:6px 12px; border-radius:8px; border:1px solid rgba(201,162,39,0.4); box-shadow:0 8px 24px rgba(0,0,0,0.6); pointer-events:none; z-index:100005; opacity:0; transform:translateY(-50%) scale(0.92); transition:opacity 0.15s ease, transform 0.15s ease; white-space:nowrap;";
      document.body.appendChild(tooltipEl);
    }

    sidebar.addEventListener("mouseover", (e) => {
      if (!sidebar.classList.contains("collapsed") || isMobile()) return;
      const item = e.target.closest(".nav-link, .logout-btn");
      if (!item) return;
      const title = item.getAttribute("data-title") || item.getAttribute("title");
      if (!title) return;
      const rect = item.getBoundingClientRect();
      tooltipEl.textContent = title;
      tooltipEl.style.left = (rect.right + 12) + "px";
      tooltipEl.style.top = (rect.top + rect.height / 2) + "px";
      tooltipEl.style.opacity = "1";
      tooltipEl.style.transform = "translateY(-50%) scale(1)";
    });

    sidebar.addEventListener("mouseout", (e) => {
      const item = e.target.closest(".nav-link, .logout-btn");
      if (item && tooltipEl) {
        tooltipEl.style.opacity = "0";
        tooltipEl.style.transform = "translateY(-50%) scale(0.92)";
      }
    });

    window.addEventListener("resize", () => {
      if (!isMobile()) {
        this.toggleMobileSidebar(false);
        document.body.style.overflow = "";
      }
    });
  }
};

window.Utils = Utils;

if (document.readyState === 'loading') {
  document.addEventListener("DOMContentLoaded", () => window.Utils.initSidebar());
} else {
  window.Utils.initSidebar();
}

window.Utils = Utils;
window.showToast = (msg, type) => Utils.showToast(msg, type);
window.openModal = (t, b, f) => Utils.openModal(t, b, f);
window.closeModal = () => Utils.closeModal();
window.confirmAction = (t, m, c) => Utils.confirmAction(t, m, c);
