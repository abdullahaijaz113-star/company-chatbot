const API_URL = "https://brewly-chatbot-api.vercel.app";

const loginView = document.getElementById("login-view");
const dashboardView = document.getElementById("dashboard-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const welcome = document.getElementById("welcome");
const logoutBtn = document.getElementById("logout-button");
const productForm = document.getElementById("product-form");
const productMessage = document.getElementById("product-message");
const productList = document.getElementById("product-list");
const adminForm = document.getElementById("admin-form");
const adminMessage = document.getElementById("admin-message");

function getToken() {
  return sessionStorage.getItem("admin_token");
}

function showLogin(message) {
  sessionStorage.removeItem("admin_token");
  sessionStorage.removeItem("admin_username");
  dashboardView.hidden = true;
  loginView.hidden = false;
  loginError.textContent = message || "";
}

function showDashboard() {
  loginView.hidden = true;
  dashboardView.hidden = false;
  welcome.textContent = "Logged in as " + sessionStorage.getItem("admin_username");
  loadProducts();
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers["Authorization"] = "Bearer " + token;

  const response = await fetch(API_URL + path, { ...options, headers });

  let data = null;
  try {
    data = await response.json();
  } catch (e) {}

  if (response.status === 401 && path !== "/admin/login") {
    showLogin("Your session expired. Please log in again.");
    throw new Error("unauthorized");
  }
  return { ok: response.ok, status: response.status, data };
}

function errorText(result) {
  const detail = result.data && result.data.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail[0] && detail[0].msg) return detail[0].msg;
  return "Something went wrong. Please try again.";
}

// Login
loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const button = loginForm.querySelector("button");
  button.disabled = true;

  try {
    const result = await api("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("login-username").value,
        password: document.getElementById("login-password").value,
      }),
    });
    if (result.ok) {
      sessionStorage.setItem("admin_token", result.data.token);
      sessionStorage.setItem("admin_username", result.data.username);
      loginForm.reset();
      showDashboard();
    } else {
      loginError.textContent = errorText(result);
    }
  } catch (e) {
    loginError.textContent = "Can't reach the server. Please try again.";
  }
  button.disabled = false;
});

logoutBtn.addEventListener("click", () => showLogin(""));

// Product list
async function loadProducts() {
  productList.textContent = "Loading...";
  try {
    const result = await api("/products");
    if (!result.ok) {
      productList.textContent = "Could not load products.";
      return;
    }
    renderProducts(result.data);
  } catch (e) {
    productList.textContent = "Could not load products.";
  }
}

function renderProducts(products) {
  productList.textContent = "";
  if (!products.length) {
    productList.textContent = "No products yet.";
    return;
  }

  products.forEach((p) => {
    const row = document.createElement("div");
    row.className = "product-row";

    if (p.image_url && p.image_url.startsWith("https://")) {
      const img = document.createElement("img");
      img.src = p.image_url;
      img.alt = p.name;
      row.appendChild(img);
    }

    const info = document.createElement("div");
    info.className = "product-info";
    const title = document.createElement("strong");
    title.textContent = p.name;
    const price = document.createElement("span");
    price.textContent = "$" + Number(p.price).toFixed(2);
    const desc = document.createElement("p");
    desc.textContent = p.description || "";
    info.append(title, price, desc);
    row.appendChild(info);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "Delete";
    del.addEventListener("click", () => deleteProduct(p, del));
    row.appendChild(del);

    productList.appendChild(row);
  });
}

async function deleteProduct(product, button) {
  if (!confirm('Delete "' + product.name + '"?')) return;
  button.disabled = true;
  try {
    const result = await api("/products/" + product.id, { method: "DELETE" });
    if (!result.ok) {
      alert(errorText(result));
      button.disabled = false;
      return;
    }
    loadProducts();
  } catch (e) {
    button.disabled = false;
  }
}

// Add product
productForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  productMessage.className = "message";
  productMessage.textContent = "Saving...";
  const button = productForm.querySelector("button");
  button.disabled = true;

  const formData = new FormData();
  formData.append("name", document.getElementById("product-name").value);
  formData.append("description", document.getElementById("product-description").value);
  formData.append("price", document.getElementById("product-price").value);
  const file = document.getElementById("product-image").files[0];
  if (file) formData.append("image", file);

  try {
    const result = await api("/products", { method: "POST", body: formData });
    if (result.ok) {
      productForm.reset();
      productMessage.textContent = "Product added.";
      loadProducts();
    } else {
      productMessage.className = "message error";
      productMessage.textContent = errorText(result);
    }
  } catch (e) {
    productMessage.className = "message error";
    productMessage.textContent = "Could not save the product.";
  }
  button.disabled = false;
});

// Add another admin
adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  adminMessage.className = "message";
  adminMessage.textContent = "Saving...";
  const button = adminForm.querySelector("button");
  button.disabled = true;

  try {
    const result = await api("/admin/admins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("new-admin-username").value,
        password: document.getElementById("new-admin-password").value,
      }),
    });
    if (result.ok) {
      adminForm.reset();
      adminMessage.textContent = "Admin created.";
    } else {
      adminMessage.className = "message error";
      adminMessage.textContent = errorText(result);
    }
  } catch (e) {
    adminMessage.className = "message error";
    adminMessage.textContent = "Could not create the admin.";
  }
  button.disabled = false;
});

// Start
if (getToken()) {
  showDashboard();
} else {
  showLogin("");
}