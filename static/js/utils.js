/**
 * UI Utilities, Modals, Toasts, Receipt Printing & Formatting
 */

const Utils = {
  showToast(msg, type = "info") {
    let container = document.getElementById("toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = `toast toast-${type === 'danger' ? 'danger' : type === 'success' ? 'success' : 'info'}`;
    const iconHtml = type === 'success' 
      ? '<i class="fas fa-check-circle" style="color:var(--success, #10b981);"></i>' 
      : type === 'danger' 
        ? '<i class="fas fa-exclamation-triangle" style="color:var(--danger, #ef4444);"></i>' 
        : '<i class="fas fa-info-circle" style="color:var(--info, #0284c7);"></i>';
    toast.innerHTML = `<span style="display:inline-flex; align-items:center;">${iconHtml}</span> <span>${msg}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  },

  openModal(title, bodyHTML, footerHTML = "", size = "") {
    let container = document.getElementById("modal-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "modal-container";
      container.className = "modal-overlay";
      container.innerHTML = '<div class="modal" id="modal-content"></div>';
      document.body.appendChild(container);
    }

    const content = document.getElementById("modal-content");
    content.className = "modal " + (size || "");
    content.removeAttribute("style");
    content.innerHTML = `
      <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; padding:18px 24px; border-bottom:1px solid rgba(205,190,150,0.25);">
        <h3 style="font-size:16px; font-weight:700; color:var(--text-main, #18181b);">${title}</h3>
        <button type="button" class="btn-icon" onclick="Utils.closeModal()" style="border:none; background:transparent; cursor:pointer; font-size:16px; color:var(--text-muted);"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body" style="padding:22px 24px;">${bodyHTML}</div>
      ${footerHTML ? `<div class="modal-footer" style="padding:16px 24px; border-top:1px solid rgba(205,190,150,0.25); display:flex; justify-content:flex-end; gap:12px;">${footerHTML}</div>` : ''}
    `;

    container.classList.remove("hidden");
    container.style.display = "flex";
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

generateReceiptHTML(order) {
    const itemsHtml = (order.items || []).map(it => `
      <div class="receipt-item">
        <span style="flex:1; padding-right:10px; word-break: break-word;">
            ${it.name}<br>
            <small>${it.quantity || 1} x ₱${Number(it.unit_price || it.price).toFixed(2)}</small>
        </span>
        <span style="white-space:nowrap;">₱${(Number(it.unit_price || it.price) * (it.quantity || 1)).toFixed(2)}</span>
      </div>
    `).join("");

    const dateStr = order.date ? new Date(order.date).toLocaleString() : new Date().toLocaleString();
    const cashierName = order.cashier || "Cashier";
    let receiptNo = order.receiptNumber || "N/A";
    if (order.id && (!receiptNo || receiptNo === "N/A" || receiptNo.length > 20)) {
      receiptNo = Utils.formatId('TXN', order.id);
    }
    const subtotal = Number(order.total_amount || order.net_amount || 0);
    const discount = Number(order.discount_amount || 0);
    const total = subtotal - discount; // Adjust if subtotal already implies net

    return `
      <div class="receipt-preview">
          <div class="receipt-header">
            <h3>BLESSIE FOOD HUB</h3>
            <p style="margin:2px 0;">INBOX</p>
            <p style="margin:2px 0;">Bago City, Negros Occidental</p>
          </div>
          <div class="receipt-divider"></div>
          <p style="margin:2px 0;">Receipt No: ${receiptNo}</p>
          <p style="margin:2px 0;">Date: ${dateStr}</p>
          <p style="margin:2px 0;">Cashier: ${cashierName}</p>
          <div class="receipt-divider"></div>
          <div style="font-size:0.85rem;">
            ${itemsHtml}
          </div>
          <div class="receipt-divider"></div>
          <div class="receipt-totals">
            <span>Subtotal:</span>
            <span>₱${subtotal.toFixed(2)}</span>
          </div>
          <div class="receipt-totals">
            <span>Discount:</span>
            <span>₱${discount.toFixed(2)}</span>
          </div>
          <div class="receipt-totals bold">
            <span>TOTAL:</span>
            <span>₱${total.toFixed(2)}</span>
          </div>
          <br>
          <div class="receipt-totals">
            <span>Payment (${order.payment_method || 'Cash'}):</span>
            <span></span>
          </div>
          <div class="receipt-totals">
            <span>Amount Received:</span>
            <span>₱${Number(order.amount_paid || order.total_amount || 0).toFixed(2)}</span>
          </div>
          <div class="receipt-totals">
            <span>Change:</span>
            <span>₱${Math.max(0, Number(order.amount_paid || order.total_amount || 0) - total).toFixed(2)}</span>
          </div>
          <div class="receipt-divider"></div>
          <div class="receipt-header" style="margin-top:16px;">
            <p>THANK YOU!</p>
            <p>PLEASE COME AGAIN</p>
          </div>
      </div>
    `;
  },

  printReceipt(order) {
    let receiptEl = document.getElementById("printReceipt");
    if (!receiptEl) {
      receiptEl = document.createElement("div");
      receiptEl.id = "printReceipt";
      document.body.appendChild(receiptEl);
    }
    
    // Store original order on window for print button
    window.currentReceiptOrder = order;

    receiptEl.innerHTML = this.generateReceiptHTML(order);
    window.print();
  },

  showReceiptModal(order) {
    const html = this.generateReceiptHTML(order);
    
    // Store for print button
    window.currentReceiptOrder = order;

    const cancelBtn = order.id ? `
      <button class="btn btn-outline" onclick="Utils.closeModal(); if (typeof promptRejectOrder === 'function') promptRejectOrder(${order.id});" style="border-color:#ef4444; color:#ef4444; font-size:12px; font-weight:700;" title="Cancel & Reject Order">
        <i class="fas fa-ban"></i> Cancel / Reject Order
      </button>
    ` : '';

    const footer = `
      ${cancelBtn}
      <button class="btn btn-outline" onclick="Utils.closeModal()">Close</button>
      <button class="btn btn-primary" onclick="Utils.printReceipt(window.currentReceiptOrder)"><i class="fas fa-print"></i> Print Receipt</button>
    `;

    this.openModal('<i class="fas fa-check-circle" style="color:var(--success, #10b981); margin-right:8px;"></i> Transaction Complete', html, footer);
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

    // Auto-close on nav-link clicks on mobile
    sidebar.querySelectorAll(".nav-link, .logout-btn").forEach(link => {
      if (!link.dataset.boundMobileClose) {
        link.dataset.boundMobileClose = "true";
        link.addEventListener("click", () => {
          if (isMobile()) {
            this.toggleMobileSidebar(false);
          }
        });
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
