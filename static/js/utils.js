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

  printReceipt(order) {
    let receiptEl = document.getElementById("printable-receipt");
    if (!receiptEl) {
      receiptEl = document.createElement("div");
      receiptEl.id = "printable-receipt";
      receiptEl.className = "hidden";
      document.body.appendChild(receiptEl);
    }

    const itemsHtml = (order.items || []).map(it => `
      <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
        <span>${it.quantity || 1}x ${it.name}</span>
        <span>₱${(Number(it.unit_price || it.price) * (it.quantity || 1)).toFixed(2)}</span>
      </div>
    `).join("");

    receiptEl.innerHTML = `
      <div style="text-align:center; margin-bottom:12px;">
        <h2 style="font-size:1.2rem; margin:0;">Blessie FoodHub</h2>
        <p style="font-size:0.8rem; margin:2px 0;">Official Sales Receipt</p>
        <p style="font-size:0.75rem; color:#666;">Date: ${new Date().toLocaleString()}</p>
        <hr style="border:none; border-top:1px dashed #000; margin:8px 0;">
      </div>
      <div style="font-size:0.85rem;">
        ${itemsHtml}
      </div>
      <hr style="border:none; border-top:1px dashed #000; margin:8px 0;">
      <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:0.95rem;">
        <span>TOTAL:</span>
        <span>₱${Number(order.total_amount || order.net_amount || 0).toFixed(2)}</span>
      </div>
      <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-top:4px;">
        <span>Payment (${order.payment_method || 'Cash'}):</span>
        <span>₱${Number(order.amount_paid || order.total_amount || 0).toFixed(2)}</span>
      </div>
      <div style="text-align:center; margin-top:16px; font-size:0.75rem;">
        <p>Thank you for dining with us!</p>
      </div>
    `;

    window.print();
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
  }
};

window.Utils = Utils;
window.showToast = (msg, type) => Utils.showToast(msg, type);
window.openModal = (t, b, f) => Utils.openModal(t, b, f);
window.closeModal = () => Utils.closeModal();
window.confirmAction = (t, m, c) => Utils.confirmAction(t, m, c);
