// --- UI HELPER FUNCTIONS ---
function showToast(msg, type = "info") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${type === 'danger' ? 'danger' : type === 'success' ? 'success' : 'info'}`;
  toast.innerHTML = `<span>${type === 'success' ? '✓' : type === 'danger' ? '⚠️' : 'ℹ'}</span> <span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function openModal(title, bodyHTML, footerHTML = "") {
  let container = document.getElementById("modal-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "modal-container";
    container.className = "modal-overlay hidden";
    container.innerHTML = `<div class="modal" id="modal-content"></div>`;
    document.body.appendChild(container);
  }
  const content = document.getElementById("modal-content");
  content.innerHTML = `
    <div class="modal-header">
      <h3>${title}</h3>
      <button class="btn btn-outline btn-sm" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">${bodyHTML}</div>
    ${footerHTML ? `<div class="modal-footer">${footerHTML}</div>` : ''}
  `;
  container.classList.remove("hidden");
}

function closeModal() {
  const container = document.getElementById("modal-container");
  if (container) {
    container.classList.add("hidden");
  }
}

function confirmAction(title, msg, onConfirm) {
  openModal(title, `<p>${msg}</p>`, `
    <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    <button class="btn btn-danger" id="confirm-btn-action">Confirm</button>
  `);
  document.getElementById("confirm-btn-action").onclick = () => {
    closeModal();
    onConfirm();
  };
}

function getStockStatus(item) {
  if (item.quantity <= 0) return { label: "Out of Stock", class: "badge-danger" };
  if (item.quantity <= item.minStock) return { label: "Low Stock", class: "badge-warning" };
  return { label: "In Stock", class: "badge-success" };
}

function getExpStatus(expDateStr) {
  if (!expDateStr) return { label: "Safe", class: "badge-success" };
  const today = new Date();
  const exp = new Date(expDateStr);
  const diffTime = exp - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays < 0) return { label: "Expired", class: "badge-danger" };
  if (diffDays === 0) return { label: "Expires Today", class: "badge-danger" };
  if (diffDays <= 7) return { label: "Expiring Soon", class: "badge-warning" };
  return { label: "Safe", class: "badge-success" };
}
