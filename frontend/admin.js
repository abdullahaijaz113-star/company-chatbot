const API_URL = "/api";

const STATUS_LABELS = {
  ordered: "Ordered",
  paid: "Paid",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
const STATUS_COLORS = {
  ordered: "#e0a458",
  paid: "#4b8bbe",
  shipped: "#8a5a3b",
  delivered: "#2e6b3a",
  cancelled: "#b3261e",
};
const NEXT_ACTIONS = {
  ordered: [["paid", "Mark as paid"], ["cancelled", "Cancel order"]],
  paid: [["shipped", "Mark as shipped"], ["cancelled", "Cancel order"]],
  shipped: [["delivered", "Mark as delivered"]],
  delivered: [],
  cancelled: [],
};
const REVENUE_STATUSES = ["paid", "shipped", "delivered"];
const VIEWS = ["home", "products", "orders", "messages", "customers", "settings"];

const $ = (id) => document.getElementById(id);

let stats = null;
let orders = [];
let orderFilter = "all";
let chartMetric = "revenue";
const openOrders = new Set();

// Small helpers
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, text) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function money(value) {
  return "$" + Number(value).toFixed(2);
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function monthLabel(key) {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleString("en", { month: "short" });
}

function chip(status) {
  return el("span", "chip " + status, STATUS_LABELS[status] || status);
}

// Login, session and API calls
let adminName = ""; // display name only. The login itself is an HttpOnly cookie.

function showLogin(message) {
  adminName = "";
  $("login-form").hidden = false;
  $("mfa-form").hidden = true;
  $("backup-panel").hidden = true;
  $("mfa-error").textContent = "";
  stats = null;
  orders = [];
  $("app").hidden = true;
  $("login-view").hidden = false;
  $("login-error").textContent = message || "";
}

function showApp() {
  $("login-view").hidden = true;
  $("app").hidden = false;
  $("welcome").textContent = "Logged in as " + adminName;
  showView("home");
    loadMessages();
}

async function api(path, options = {}) {
    const response = await fetch(API_URL + path, { ...options, credentials: "include" });

  let data = null;
  try {
    data = await response.json();
  } catch (e) {}

  if (response.status === 401 && path !== "/admin/login" && path !== "/admin/me") {
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

function isUnauthorized(error) {
  return error && error.message === "unauthorized";
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  $("login-error").textContent = "";
  button.disabled = true;

  try {
    const result = await api("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: $("login-username").value,
        password: $("login-password").value,
      }),
    });
    if (result.ok && result.data.mfa_required) {
      form.reset();
      startAdminMfa();
    } else if (result.ok) {
      adminName = result.data.username;
      form.reset();
      showApp();
    } else {
      $("login-error").textContent = errorText(result);
    }
  } catch (e) {
    $("login-error").textContent = "Can't reach the server. Please try again.";
  }
  button.disabled = false;
});

$("logout-button").addEventListener("click", async () => {
  try {
    const result = await api("/admin/logout", { method: "POST" });
    if (!result.ok) throw new Error("logout failed");
  } catch (e) {
    if (!isUnauthorized(e)) {
      alert("Could not log out. Please try again.");
      return;
    }
  }
  showLogin("");
});

// Two-step verification (admin)
function startAdminMfa() {
  $("login-form").hidden = true;
  $("mfa-form").hidden = false;
  $("backup-panel").hidden = true;
  $("mfa-info").textContent = "Sending your code...";
  $("mfa-code").focus();
  sendAdminCode();
}

async function sendAdminCode() {
  $("mfa-error").textContent = "";
  try {
    const result = await api("/account/2fa/send-otp", { method: "POST" });
    if (result.ok) {
      $("mfa-info").textContent =
        "We emailed a 6-digit code to " + result.data.to + ". Enter it below, or use a backup code.";
    } else {
      $("mfa-info").textContent = "";
      $("mfa-error").textContent = errorText(result);
    }
  } catch (e) {
    if (!isUnauthorized(e)) $("mfa-error").textContent = "Can't reach the server. Please try again.";
  }
}

function showBackupCodes(codes) {
  $("mfa-form").hidden = true;
  $("backup-list").textContent = codes.join("\n");
  $("backup-panel").hidden = false;
}

$("mfa-resend").addEventListener("click", sendAdminCode);

$("backup-done").addEventListener("click", () => {
  $("backup-list").textContent = "";
  showApp();
});

$("mfa-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  $("mfa-error").textContent = "";
  button.disabled = true;

  try {
    const result = await api("/account/2fa/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: $("mfa-code").value }),
    });
    if (result.ok) {
      adminName = result.data.username;
      $("mfa-form").reset();
      if (result.data.backup_codes) showBackupCodes(result.data.backup_codes);
      else showApp();
    } else {
      $("mfa-error").textContent = errorText(result);
    }
  } catch (e) {
    if (!isUnauthorized(e)) $("mfa-error").textContent = "Can't reach the server. Please try again.";
  }
  button.disabled = false;
});

// Navigation
function showView(name) {
  setAdminMenu(false);
  VIEWS.forEach((v) => {
    $("view-" + v).hidden = v !== name;
  });
  document.querySelectorAll("#side-nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === name);
  });
  if (name === "home") loadHome();
  else if (name === "products") loadProducts();
  else if (name === "orders" || name === "customers") loadOrders();
  else if (name === "messages") loadMessages();
}

document.querySelectorAll("#side-nav button").forEach((b) => {
  b.addEventListener("click", () => showView(b.dataset.view));
});

// Home
async function loadHome() {
  $("stat-grid").textContent = "Loading...";
  try {
    const result = await api("/admin/stats");
    if (!result.ok) {
      $("stat-grid").textContent = errorText(result);
      return;
    }
    stats = result.data;
    renderStats();
    renderChart();
    renderDonut();
    renderBestsellers();
    renderRecent();
  } catch (e) {
    if (!isUnauthorized(e)) $("stat-grid").textContent = "Could not load statistics.";
  }
}

function renderStats() {
  const grid = $("stat-grid");
  grid.textContent = "";
  const items = [
    ["Revenue", money(stats.revenue), "Paid, shipped and delivered"],
    ["Orders", String(stats.total_orders), "Not counting cancelled"],
    ["Awaiting payment", String(stats.awaiting_payment), "Status: ordered"],
    ["To ship", String(stats.to_ship), "Paid, not yet shipped"],
    ["Customers", String(stats.customers), "Unique emails"],
  ];
  items.forEach(([label, value, sub]) => {
    const card = el("div", "card stat");
    card.append(el("span", "stat-label", label), el("strong", "stat-value", value), el("span", "muted", sub));
    grid.appendChild(card);
  });
}

function renderChart() {
  const box = $("chart-box");
  box.textContent = "";
  if (!stats) return;

  const data = stats.monthly;
  const values = data.map((m) => (chartMetric === "revenue" ? m.revenue : m.orders));
  const maxValue = Math.max(...values, 1);
  const W = 640, H = 250, left = 48, right = 8, top = 12, bottom = 30;
  const innerW = W - left - right;
  const innerH = H - top - bottom;

  const root = svg("svg", {
    viewBox: "0 0 " + W + " " + H,
    class: "chart-svg",
    role: "img",
    "aria-label": "Sales by month",
  });

  [0, 0.5, 1].forEach((fraction) => {
    const y = top + innerH - innerH * fraction;
    root.appendChild(svg("line", { x1: left, x2: W - right, y1: y, y2: y, class: "grid-line" }));
    const amount = Math.round(maxValue * fraction);
    root.appendChild(
      svg("text", { x: left - 6, y: y + 4, "text-anchor": "end", class: "axis-text" },
        chartMetric === "revenue" ? "$" + amount : String(amount))
    );
  });

  const slot = innerW / data.length;
  const barWidth = Math.min(slot * 0.6, 34);
  data.forEach((m, i) => {
    const value = values[i];
    const height = (value / maxValue) * innerH;
    const x = left + slot * i + (slot - barWidth) / 2;
    const y = top + innerH - height;
    const bar = svg("rect", { x, y, width: barWidth, height: Math.max(height, 0), rx: 4, class: "bar" });
    const label = chartMetric === "revenue" ? money(value) : value + (value === 1 ? " order" : " orders");
    bar.appendChild(svg("title", {}, monthLabel(m.month) + ": " + label));
    root.appendChild(bar);
    root.appendChild(
      svg("text", { x: x + barWidth / 2, y: H - 10, "text-anchor": "middle", class: "axis-text" }, monthLabel(m.month))
    );
  });

  box.appendChild(root);
  if (values.every((v) => v === 0)) box.appendChild(el("p", "muted", "No sales yet."));
}

document.querySelectorAll("#chart-toggle button").forEach((b) => {
  b.addEventListener("click", () => {
    chartMetric = b.dataset.metric;
    document.querySelectorAll("#chart-toggle button").forEach((x) => {
      x.classList.toggle("active", x === b);
    });
    renderChart();
  });
});

function renderDonut() {
  const box = $("donut-box");
  box.textContent = "";
  if (!stats) return;

  const counts = stats.status_counts;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) {
    box.appendChild(el("p", "muted", "No orders yet."));
    return;
  }

  const root = svg("svg", { viewBox: "0 0 42 42", class: "donut-svg", role: "img", "aria-label": "Orders by status" });
  root.appendChild(svg("circle", { cx: 21, cy: 21, r: 15.915, fill: "none", stroke: "#efe4d8", "stroke-width": 5 }));

  let cumulative = 0;
  Object.keys(STATUS_LABELS).forEach((status) => {
    const count = counts[status] || 0;
    if (!count) return;
    const pct = (count / total) * 100;
    root.appendChild(
      svg("circle", {
        cx: 21, cy: 21, r: 15.915, fill: "none",
        stroke: STATUS_COLORS[status],
        "stroke-width": 5,
        "stroke-dasharray": pct + " " + (100 - pct),
        "stroke-dashoffset": String(125 - cumulative),
      })
    );
    cumulative += pct;
  });
  root.appendChild(svg("text", { x: 21, y: 23.5, "text-anchor": "middle", class: "donut-total" }, String(total)));
  box.appendChild(root);

  const legend = el("ul", "legend");
  Object.keys(STATUS_LABELS).forEach((status) => {
    const li = el("li");
    const dot = el("span", "dot");
    dot.style.background = STATUS_COLORS[status];
    li.append(dot, el("span", "", STATUS_LABELS[status]), el("span", "count", String(counts[status] || 0)));
    legend.appendChild(li);
  });
  box.appendChild(legend);
}

function renderBestsellers() {
  const box = $("best-box");
  box.textContent = "";
  if (!stats || !stats.bestsellers.length) {
    box.appendChild(el("p", "muted", "No sales yet."));
    return;
  }
  stats.bestsellers.forEach((item) => {
    const row = el("div", "row");
    if (item.image_url && item.image_url.startsWith("https://")) {
      const img = el("img");
      img.src = item.image_url;
      img.alt = "";
      row.appendChild(img);
    }
    const main = el("div", "row-main");
    main.append(el("strong", "", item.name), el("span", "muted", item.quantity + " sold"));
    row.appendChild(main);
    box.appendChild(row);
  });
}

function renderRecent() {
  const box = $("recent-box");
  box.textContent = "";
  if (!stats || !stats.recent.length) {
    box.appendChild(el("p", "muted", "No orders yet."));
    return;
  }
  stats.recent.forEach((o) => {
    const row = el("div", "row");
    const main = el("div", "row-main");
    const items = o.item_count + (o.item_count === 1 ? " item" : " items");
    main.append(
      el("strong", "", o.order_number),
      el("span", "muted", o.customer_name + " · " + items + " · " + fmtDate(o.created_at))
    );
    row.append(main, el("strong", "", money(o.total)), chip(o.status));
    box.appendChild(row);
  });
  const more = el("button", "btn btn-ghost", "View all orders");
  more.type = "button";
  more.style.color = "#4b2e1e";
  more.style.borderColor = "#4b2e1e";
  more.style.marginTop = "12px";
  more.addEventListener("click", () => showView("orders"));
  box.appendChild(more);
}

// Orders
async function loadOrders() {
  $("orders-box").textContent = "Loading...";
  try {
    const result = await api("/admin/orders");
    if (!result.ok) {
      $("orders-box").textContent = errorText(result);
      return;
    }
    orders = result.data;
    renderOrders();
    renderCustomers();
  } catch (e) {
    if (!isUnauthorized(e)) $("orders-box").textContent = "Could not load orders.";
  }
}

function renderOrders() {
  const filters = $("order-filters");
  filters.textContent = "";
  ["all", ...Object.keys(STATUS_LABELS)].forEach((key) => {
    const count = key === "all" ? orders.length : orders.filter((o) => o.status === key).length;
    const label = (key === "all" ? "All" : STATUS_LABELS[key]) + " (" + count + ")";
    const button = el("button", "filter" + (orderFilter === key ? " active" : ""), label);
    button.type = "button";
    button.addEventListener("click", () => {
      orderFilter = key;
      renderOrders();
    });
    filters.appendChild(button);
  });

  const box = $("orders-box");
  box.textContent = "";
  const shown = orders.filter((o) => orderFilter === "all" || o.status === orderFilter);
  if (!shown.length) {
    box.appendChild(el("p", "muted", "No orders here yet."));
    return;
  }
  shown.forEach((o) => box.appendChild(orderCard(o)));
}

function orderCard(o) {
  const details = el("details", "order");
  details.open = openOrders.has(o.id);
  details.addEventListener("toggle", () => {
    if (details.open) openOrders.add(o.id);
    else openOrders.delete(o.id);
  });

  const summary = document.createElement("summary");
  const main = el("div", "row-main");
  main.append(el("strong", "", o.order_number), el("span", "muted", o.customer_name + " · " + fmtDate(o.created_at)));
  summary.append(main, el("strong", "", money(o.total)), chip(o.status));
  details.appendChild(summary);

  const body = el("div", "order-body");

  const contact = el("div", "order-contact");
  const lines = [
    ["Email", o.email],
    ["Phone", o.phone],
    ["Address", o.address + ", " + o.city],
  ];
  if (o.notes) lines.push(["Notes", o.notes]);
  lines.forEach(([label, value]) => {
    const p = el("p");
    p.append(el("strong", "", label + ": "), document.createTextNode(value));
    contact.appendChild(p);
  });
  body.appendChild(contact);

  o.order_items.forEach((item) => {
    const line = el("div", "item-line");
    line.append(
      el("span", "", item.quantity + " × " + item.product_name),
      el("span", "", money(item.unit_price * item.quantity))
    );
    body.appendChild(line);
  });

  const actions = el("div", "order-actions");
  const next = NEXT_ACTIONS[o.status] || [];
  next.forEach(([status, label]) => {
    const button = el("button", "btn" + (status === "cancelled" ? " btn-danger" : ""), label);
    button.type = "button";
    button.addEventListener("click", () => changeStatus(o, status, actions));
    actions.appendChild(button);
  });
  if (!next.length) {
    actions.appendChild(el("span", "muted", o.status === "delivered" ? "Order complete." : "Order cancelled."));
  }
  body.appendChild(actions);

  details.appendChild(body);
  return details;
}

async function changeStatus(order, status, actions) {
  if (status === "cancelled" && !confirm("Cancel order " + order.order_number + "?")) return;
  actions.querySelectorAll("button").forEach((b) => {
    b.disabled = true;
  });

  try {
    const result = await api("/admin/orders/" + order.id + "/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!result.ok) alert(errorText(result));
  } catch (e) {
    if (isUnauthorized(e)) return;
    alert("Could not update the order.");
  }
  loadOrders();
}

// Customers (built from the orders)
function renderCustomers() {
  const box = $("customers-box");
  box.textContent = "";

  const people = new Map();
  orders.forEach((o) => {
    if (o.status === "cancelled") return;
    const key = o.email.toLowerCase();
    let person = people.get(key);
    if (!person) {
      person = { name: o.customer_name, email: o.email, phone: o.phone, orders: 0, spent: 0, last: o.created_at };
      people.set(key, person);
    }
    person.orders += 1;
    if (REVENUE_STATUSES.includes(o.status)) person.spent += Number(o.total);
    if (o.created_at > person.last) person.last = o.created_at;
  });

  const list = [...people.values()].sort((a, b) => b.spent - a.spent);
  if (!list.length) {
    box.appendChild(el("p", "muted", "No customers yet."));
    return;
  }

  const wrap = el("div", "table-wrap");
  const table = el("table", "table");
  const head = document.createElement("tr");
  ["Customer", "Email", "Phone", "Orders", "Spent", "Last order"].forEach((h) => {
    head.appendChild(el("th", "", h));
  });
  table.appendChild(head);
  list.forEach((p) => {
    const row = document.createElement("tr");
    [p.name, p.email, p.phone, String(p.orders), money(p.spent), fmtDate(p.last)].forEach((value) => {
      row.appendChild(el("td", "", value));
    });
    table.appendChild(row);
  });
  wrap.appendChild(table);
  box.appendChild(wrap);
}

// Products
async function loadProducts() {
  const list = $("product-list");
  list.textContent = "Loading...";
  try {
    const result = await api("/products");
    if (!result.ok) {
      list.textContent = "Could not load products.";
      return;
    }
    renderProducts(result.data);
  } catch (e) {
    if (!isUnauthorized(e)) list.textContent = "Could not load products.";
  }
}

function renderProducts(products) {
  const list = $("product-list");
  list.textContent = "";
  if (!products.length) {
    list.textContent = "No products yet.";
    return;
  }

  const sorted = [...products].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === "product" ? -1 : 1
  );
  sorted.forEach((p) => list.appendChild(productRow(p)));
}

function productRow(p) {
  const row = el("div", "product-row");

  if (p.image_url && p.image_url.startsWith("https://")) {
    const img = el("img");
    img.src = p.image_url;
    img.alt = p.name;
    row.appendChild(img);
  }

  const info = el("div", "product-info");
  info.append(
    el("strong", "", p.name),
    el("span", "", money(p.price)),
    el("span", "kind-tag", p.kind === "service" ? "Service" : "Product"),
    el("p", "", p.description || "")
  );
  row.appendChild(info);

  const actions = el("div", "row-actions");
  const edit = el("button", "btn btn-outline", "Edit");
  edit.type = "button";
  edit.addEventListener("click", () => row.replaceWith(editRow(p)));
  const del = el("button", "btn btn-danger", "Delete");
  del.type = "button";
  del.addEventListener("click", () => deleteProduct(p, del));
  actions.append(edit, del);
  row.appendChild(actions);

  return row;
}

function editRow(p) {
  const row = el("div", "product-row");
  const form = el("form", "edit-form");

  const nameLabel = el("label", "", "Name");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.maxLength = 100;
  nameInput.required = true;
  nameInput.value = p.name;
  nameLabel.appendChild(nameInput);

  const descLabel = el("label", "", "Description");
  const descInput = document.createElement("textarea");
  descInput.rows = 3;
  descInput.maxLength = 1000;
  descInput.value = p.description || "";
  descLabel.appendChild(descInput);

  const priceLabel = el("label", "", "Price (USD)");
  const priceInput = document.createElement("input");
  priceInput.type = "number";
  priceInput.min = "0";
  priceInput.step = "0.01";
  priceInput.required = true;
  priceInput.value = Number(p.price).toFixed(2);
  priceLabel.appendChild(priceInput);

  const message = el("p", "message");
  const actions = el("div", "row-actions");
  const save = el("button", "btn", "Save");
  save.type = "submit";
  const cancel = el("button", "btn btn-outline", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => loadProducts());
  actions.append(save, cancel);

  form.append(nameLabel, descLabel, priceLabel, message, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.className = "message";
    message.textContent = "Saving...";
    save.disabled = true;
    try {
      const result = await api("/products/" + p.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nameInput.value,
          description: descInput.value,
          price: Number(priceInput.value),
        }),
      });
      if (result.ok) {
        loadProducts();
        return;
      }
      message.className = "message error";
      message.textContent = errorText(result);
    } catch (e) {
      if (isUnauthorized(e)) return;
      message.className = "message error";
      message.textContent = "Could not save the changes.";
    }
    save.disabled = false;
  });

  row.appendChild(form);
  return row;
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

$("product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = $("product-message");
  const button = form.querySelector("button");
  message.className = "message";
  message.textContent = "Saving...";
  button.disabled = true;

  const formData = new FormData();
  formData.append("name", $("product-name").value);
  formData.append("description", $("product-description").value);
  formData.append("price", $("product-price").value);
  formData.append("kind", $("product-kind").value);
  const file = $("product-image").files[0];
  if (file) formData.append("image", file);

  try {
    const result = await api("/products", { method: "POST", body: formData });
    if (result.ok) {
      form.reset();
      message.textContent = "Product added.";
      loadProducts();
    } else {
      message.className = "message error";
      message.textContent = errorText(result);
    }
  } catch (e) {
    message.className = "message error";
    message.textContent = "Could not save the product.";
  }
  button.disabled = false;
});

// Settings: add another admin
$("admin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = $("admin-message");
  const button = form.querySelector("button");
  message.className = "message";
  message.textContent = "Saving...";
  button.disabled = true;

  try {
    const result = await api("/admin/admins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: $("new-admin-username").value,
        password: $("new-admin-password").value,
      }),
    });
    if (result.ok) {
      form.reset();
      message.textContent = "Admin created.";
    } else {
      message.className = "message error";
      message.textContent = errorText(result);
    }
  } catch (e) {
    message.className = "message error";
    message.textContent = "Could not create the admin.";
  }
  button.disabled = false;
});

// Hamburger menu (phones)
const adminMenuToggle = $("admin-menu-toggle");
const adminMenu = $("admin-menu");

function setAdminMenu(open) {
  adminMenu.classList.toggle("open", open);
  adminMenuToggle.setAttribute("aria-expanded", String(open));
  adminMenuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}

adminMenuToggle.addEventListener("click", () => {
  setAdminMenu(!adminMenu.classList.contains("open"));
});

// Messages from the contact form
let messages = [];
const openMessages = new Set();

async function loadMessages() {
  const box = $("messages-box");
  box.textContent = "Loading...";
  try {
    const result = await api("/admin/messages");
    if (!result.ok) {
      box.textContent = errorText(result);
      return;
    }
    messages = result.data;
    renderMessages();
  } catch (e) {
    if (!isUnauthorized(e)) box.textContent = "Could not load messages.";
  }
}

function renderMessages() {
  const unread = messages.filter((m) => !m.handled).length;
  $("messages-nav").textContent = unread ? "Messages (" + unread + ")" : "Messages";

  const box = $("messages-box");
  box.textContent = "";
  if (!messages.length) {
    box.appendChild(el("p", "muted", "No messages yet."));
    return;
  }
  messages.forEach((m) => box.appendChild(messageCard(m)));
}

function messageCard(m) {
  const details = el("details", "order");
  details.open = openMessages.has(m.id);
  details.addEventListener("toggle", () => {
    if (details.open) openMessages.add(m.id);
    else openMessages.delete(m.id);
  });

  const summary = document.createElement("summary");
  const main = el("div", "row-main");
  main.append(el("strong", "", m.name), el("span", "muted", m.topic + " · " + fmtDate(m.created_at)));
  summary.append(main, el("span", "chip " + (m.handled ? "delivered" : "ordered"), m.handled ? "Handled" : "New"));
  details.appendChild(summary);

  const body = el("div", "order-body");
  const contact = el("div", "order-contact");
  const lines = [["Email", m.email]];
  if (m.phone) lines.push(["Phone", m.phone]);
  lines.push(["Topic", m.topic]);
  lines.forEach(([label, value]) => {
    const p = el("p");
    p.append(el("strong", "", label + ": "), document.createTextNode(value));
    contact.appendChild(p);
  });
  body.appendChild(contact);
  body.appendChild(el("p", "message-text", m.message));

  const actions = el("div", "order-actions");
  const toggle = el("button", "btn", m.handled ? "Mark as new" : "Mark as handled");
  toggle.type = "button";
  toggle.addEventListener("click", () => setHandled(m, !m.handled, actions));
  const del = el("button", "btn btn-danger", "Delete");
  del.type = "button";
  del.addEventListener("click", () => deleteMessage(m, actions));
  actions.append(toggle, del);
  body.appendChild(actions);

  details.appendChild(body);
  return details;
}

async function setHandled(message, handled, actions) {
  actions.querySelectorAll("button").forEach((b) => {
    b.disabled = true;
  });
  try {
    const result = await api("/admin/messages/" + message.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handled }),
    });
    if (!result.ok) alert(errorText(result));
  } catch (e) {
    if (isUnauthorized(e)) return;
    alert("Could not update the message.");
  }
  loadMessages();
}

async function deleteMessage(message, actions) {
  if (!confirm("Delete the message from " + message.name + "?")) return;
  actions.querySelectorAll("button").forEach((b) => {
    b.disabled = true;
  });
  try {
    const result = await api("/admin/messages/" + message.id, { method: "DELETE" });
    if (!result.ok) alert(errorText(result));
  } catch (e) {
    if (isUnauthorized(e)) return;
    alert("Could not delete the message.");
  }
  loadMessages();
}

// Start: ask the server whether the cookie is a valid admin session
try {
  sessionStorage.removeItem("admin_token");
  sessionStorage.removeItem("admin_username");
} catch (e) {}

(async function () {
  try {
    const result = await api("/admin/me");
    if (result.ok) {
      adminName = result.data.username;
      showApp();
      return;
    }
  } catch (e) {}
  showLogin("");
})();