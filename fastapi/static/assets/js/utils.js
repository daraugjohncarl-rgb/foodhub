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
    const icon = type === 'success' ? '✓' : type === 'danger' ? '⚠️' : 'ℹ';
    toast.innerHTML = `<span>${icon}</span> <span>${msg}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  },

  openModal(title, bodyHTML, footerHTML = "") {
    let container = document.getElementById("modal-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "modal-container";
      container.className = "modal-overlay";
      container.innerHTML = '<div class="modal" id="modal-content"></div>';
      document.body.appendChild(container);
    }

    const content = document.getElementById("modal-content");
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
    const receiptNo = order.receiptNumber || "N/A";
    const subtotal = Number(order.total_amount || order.net_amount || 0); // Assuming no discount/tax currently handled
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

    const footer = `
      <button class="btn btn-outline" onclick="Utils.closeModal()">Close</button>
      <button class="btn btn-primary" onclick="Utils.printReceipt(window.currentReceiptOrder)"><i class="fas fa-print"></i> Print Receipt</button>
    `;

    this.openModal("✓ Transaction Complete", html, footer);
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

  initSidebar() {
    const sidebar = document.getElementById("sidebar");
    const sidebarToggle = document.getElementById("sidebarToggle");
    const mobileMenuBtn = document.getElementById("mobileMenuBtn");
    const sidebarOverlay = document.getElementById("sidebarOverlay");
    const mainContent = document.querySelector(".main-content");

    if (!sidebar) return;

    // Apply saved state on load (desktop only)
    const isMobile = window.innerWidth <= 768;
    const savedCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';
    
    if (!isMobile && savedCollapsed) {
      sidebar.classList.add('collapsed');
      if (mainContent) mainContent.classList.add('sidebar-collapsed');
      if (sidebarToggle) sidebarToggle.innerHTML = '<i class="fas fa-bars"></i>';
    } else if (!isMobile) {
      if (sidebarToggle) sidebarToggle.innerHTML = '<i class="fas fa-times"></i>';
    }

    if (sidebarToggle) {
      sidebarToggle.addEventListener("click", () => {
        if (window.innerWidth <= 768) {
          // Mobile: Toggle off-canvas
          sidebar.classList.remove('open');
          if (sidebarOverlay) sidebarOverlay.classList.remove('open');
        } else {
          // Desktop: Collapse/Expand
          const isCollapsed = sidebar.classList.toggle('collapsed');
          if (mainContent) mainContent.classList.toggle('sidebar-collapsed');
          
          if (isCollapsed) {
            sidebarToggle.innerHTML = '<i class="fas fa-bars"></i>';
          } else {
            sidebarToggle.innerHTML = '<i class="fas fa-times"></i>';
          }
          
          localStorage.setItem('sidebar_collapsed', isCollapsed);
        }
      });
    }

    if (mobileMenuBtn && sidebarOverlay) {
      mobileMenuBtn.addEventListener("click", () => {
        sidebar.classList.add("open");
        sidebarOverlay.classList.add("open");
      });

      sidebarOverlay.addEventListener("click", () => {
        sidebar.classList.remove("open");
        sidebarOverlay.classList.remove("open");
      });
    }

    // Optional: Window resize handling to prevent stuck states
    window.addEventListener("resize", () => {
      if (window.innerWidth > 768) {
        sidebar.classList.remove("open");
        if (sidebarOverlay) sidebarOverlay.classList.remove("open");
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
