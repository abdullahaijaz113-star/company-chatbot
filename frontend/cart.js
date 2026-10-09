// Shopping cart, demo checkout and order confirmation
const CART_KEY = "brewly_cart";
const MAX_QTY_PER_ITEM = 20;

const cartButton = document.getElementById("cart-button");
const cartCount = document.getElementById("cart-count");
const cartOverlay = document.getElementById("cart-overlay");
const cartDrawer = document.getElementById("cart-drawer");
const cartTitle = document.getElementById("cart-title");
const cartBody = document.getElementById("cart-body");
const cartClose = document.getElementById("cart-close");

function loadCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    const data = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(data)) return [];
    return data
      .filter((i) => i && Number.isInteger(i.id) && Number(i.quantity) > 0)
      .map((i) => ({
        id: i.id,
        name: String(i.name || ""),
        price: Number(i.price) || 0,
        image_url: typeof i.image_url === "string" ? i.image_url : null,
        quantity: Math.min(Math.floor(Number(i.quantity)), MAX_QTY_PER_ITEM),
      }));
  } catch (e) {
    return [];
  }
}

let cart = loadCart();

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch (e) {}
  updateCount();
}

function updateCount() {
  cartCount.textContent = String(cart.reduce((sum, i) => sum + i.quantity, 0));
}

function toCents(price) {
  return Math.round(Number(price) * 100);
}

function money(cents) {
  return "$" + (cents / 100).toFixed(2);
}

function cartTotalCents() {
  return cart.reduce((sum, i) => sum + toCents(i.price) * i.quantity, 0);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function orderErrorText(data) {
  const detail = data && data.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail[0] && detail[0].msg) return detail[0].msg;
  return "Something went wrong. Please try again.";
}

// Adding, changing, removing
function addToCart(product) {
  const existing = cart.find((i) => i.id === product.id);
  if (existing) {
    existing.quantity = Math.min(existing.quantity + 1, MAX_QTY_PER_ITEM);
  } else {
    cart.push({
      id: product.id,
      name: product.name,
      price: Number(product.price),
      image_url: product.image_url || null,
      quantity: 1,
    });
  }
  saveCart();
  openCart();
}

function changeQty(id, delta) {
  const item = cart.find((i) => i.id === id);
  if (!item) return;
  item.quantity = Math.max(1, Math.min(item.quantity + delta, MAX_QTY_PER_ITEM));
  saveCart();
  renderCart();
}

function removeItem(id) {
  cart = cart.filter((i) => i.id !== id);
  saveCart();
  renderCart();
}

// Opening and closing the drawer
function openCart() {
  cartOverlay.hidden = false;
  cartDrawer.hidden = false;
  renderCart();
  cartClose.focus();
}

function closeCart() {
  cartOverlay.hidden = true;
  cartDrawer.hidden = true;
  cartButton.focus();
}

// View 1: the cart
function renderCart() {
  cartTitle.textContent = "Your cart";
  cartBody.textContent = "";

  if (!cart.length) {
    cartBody.appendChild(el("p", "cart-empty", "Your cart is empty."));
    const keep = el("button", "cart-secondary", "Continue shopping");
    keep.type = "button";
    keep.addEventListener("click", closeCart);
    cartBody.appendChild(keep);
    return;
  }

  const list = el("div", "cart-items");
  cart.forEach((item) => {
    const row = el("div", "cart-row");

    if (item.image_url && item.image_url.startsWith("https://")) {
      const img = el("img", "cart-thumb");
      img.src = item.image_url;
      img.alt = "";
      row.appendChild(img);
    }

    const info = el("div", "cart-info");
    info.appendChild(el("strong", "", item.name));
    info.appendChild(el("span", "cart-unit", money(toCents(item.price)) + " each"));

    const controls = el("div", "cart-qty");
    const minus = el("button", "qty-btn", "−");
    minus.type = "button";
    minus.setAttribute("aria-label", "Decrease quantity of " + item.name);
    minus.disabled = item.quantity <= 1;
    minus.addEventListener("click", () => changeQty(item.id, -1));

    const qty = el("span", "qty-value", String(item.quantity));

    const plus = el("button", "qty-btn", "+");
    plus.type = "button";
    plus.setAttribute("aria-label", "Increase quantity of " + item.name);
    plus.disabled = item.quantity >= MAX_QTY_PER_ITEM;
    plus.addEventListener("click", () => changeQty(item.id, 1));

    const remove = el("button", "cart-remove", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => removeItem(item.id));

    controls.append(minus, qty, plus, remove);
    info.appendChild(controls);
    row.appendChild(info);
    row.appendChild(el("div", "cart-line", money(toCents(item.price) * item.quantity)));
    list.appendChild(row);
  });
  cartBody.appendChild(list);

  const total = el("div", "cart-total");
  total.append(el("span", "", "Total"), el("strong", "", money(cartTotalCents())));
  cartBody.appendChild(total);
  cartBody.appendChild(el("p", "cart-note", "Prices are confirmed when you place your order."));

  const checkout = el("button", "cart-primary", "Checkout");
  checkout.type = "button";
  checkout.addEventListener("click", renderCheckout);
  const keep = el("button", "cart-secondary", "Continue shopping");
  keep.type = "button";
  keep.addEventListener("click", closeCart);
  cartBody.append(checkout, keep);
}

// Demo card checks (the card details are never sent anywhere)
function luhnOk(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function checkDemoCard(number, expiry, cvc) {
  const digits = number.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits) || !luhnOk(digits)) {
    return "Please enter a valid card number. For this demo, use 4242 4242 4242 4242.";
  }
  const match = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(expiry.trim());
  if (!match) return "Enter the expiry date as MM/YY.";
  const expiryIndex = (2000 + Number(match[2])) * 12 + (Number(match[1]) - 1);
  const now = new Date();
  if (expiryIndex < now.getFullYear() * 12 + now.getMonth()) return "That card has expired.";
  if (!/^\d{3,4}$/.test(cvc.trim())) return "Enter the 3 or 4 digit security code.";
  return "";
}

function field(labelText, id, attrs, tag) {
  const label = el("label", "", labelText);
  const input = document.createElement(tag || "input");
  input.id = id;
  Object.entries(attrs || {}).forEach(([key, value]) => input.setAttribute(key, value));
  label.appendChild(input);
  return { label, input };
}

// View 2: checkout (delivery details and the demo card form)
function renderCheckout() {
  if (!cart.length) {
    renderCart();
    return;
  }
  cartTitle.textContent = "Checkout";
  cartBody.textContent = "";

  const itemCount = cart.reduce((sum, i) => sum + i.quantity, 0);
  const summary = el("div", "cart-total");
  summary.append(
    el("span", "", itemCount + (itemCount === 1 ? " item" : " items")),
    el("strong", "", money(cartTotalCents()))
  );
  cartBody.appendChild(summary);

  const form = document.createElement("form");
  form.className = "checkout-form";

  const nameField = field("Full name", "co-name", { type: "text", required: "", minlength: "2", maxlength: "100", autocomplete: "name" });
  const emailField = field("Email", "co-email", { type: "email", required: "", maxlength: "120", autocomplete: "email" });
  const phoneField = field("Phone", "co-phone", { type: "tel", required: "", minlength: "5", maxlength: "30", autocomplete: "tel" });
  const addressField = field("Delivery address", "co-address", { type: "text", required: "", minlength: "5", maxlength: "300", autocomplete: "street-address" });
  const cityField = field("City", "co-city", { type: "text", required: "", minlength: "2", maxlength: "80", autocomplete: "address-level2" });
  const notesField = field("Notes (optional)", "co-notes", { rows: "2", maxlength: "500" }, "textarea");

  form.appendChild(el("h3", "", "Delivery details"));
  form.append(nameField.label, emailField.label, phoneField.label, addressField.label, cityField.label, notesField.label);

  form.appendChild(el("h3", "", "Payment"));
  form.appendChild(
    el(
      "p",
      "demo-banner",
      "DEMO payment: no real money is taken and your card details are never sent anywhere. Use 4242 4242 4242 4242, any future date, and any 3 digits."
    )
  );

  const cardField = field("Card number", "co-card", { type: "text", inputmode: "numeric", autocomplete: "off", maxlength: "23", placeholder: "4242 4242 4242 4242", required: "" });
  const expiryField = field("Expiry", "co-expiry", { type: "text", inputmode: "numeric", autocomplete: "off", maxlength: "5", placeholder: "MM/YY", required: "" });
  const cvcField = field("Security code", "co-cvc", { type: "text", inputmode: "numeric", autocomplete: "off", maxlength: "4", placeholder: "123", required: "" });

  form.appendChild(cardField.label);
  const cardRow = el("div", "card-row");
  cardRow.append(expiryField.label, cvcField.label);
  form.appendChild(cardRow);

  const message = el("p", "cart-error");
  message.setAttribute("role", "alert");
  form.appendChild(message);

  const payLabel = "Pay " + money(cartTotalCents()) + " (demo)";
  const submit = el("button", "cart-primary", payLabel);
  submit.type = "submit";
  form.appendChild(submit);

  const back = el("button", "cart-secondary", "Back to cart");
  back.type = "button";
  back.addEventListener("click", renderCart);
  form.appendChild(back);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";

    const problem = checkDemoCard(cardField.input.value, expiryField.input.value, cvcField.input.value);
    if (problem) {
      message.textContent = problem;
      return;
    }

    submit.disabled = true;
    submit.textContent = "Placing your order...";

    const order = {
      customer_name: nameField.input.value.trim(),
      email: emailField.input.value.trim(),
      phone: phoneField.input.value.trim(),
      address: addressField.input.value.trim(),
      city: cityField.input.value.trim(),
      notes: notesField.input.value.trim(),
      items: cart.map((i) => ({ product_id: i.id, quantity: i.quantity })),
    };

    let placed;
    try {
      const response = await fetch(API_URL + "/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(order),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        message.textContent = orderErrorText(data);
        submit.disabled = false;
        submit.textContent = payLabel;
        return;
      }
      placed = data;
    } catch (e) {
      message.textContent = "Can't reach the shop right now. Please try again.";
      submit.disabled = false;
      submit.textContent = payLabel;
      return;
    }

    // The order exists now, so the cart is finished
    cart = [];
    saveCart();

    let paid = false;
    try {
      const payResponse = await fetch(
        API_URL + "/orders/" + encodeURIComponent(placed.order_number) + "/pay",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: placed.public_token }),
        }
      );
      paid = payResponse.ok;
    } catch (e) {}

    renderConfirmation(placed, paid);
  });

  cartBody.appendChild(form);
}

// View 3: confirmation
function renderConfirmation(order, paid) {
  cartTitle.textContent = paid ? "Thank you!" : "Order placed";
  cartBody.textContent = "";

  cartBody.appendChild(
    el(
      "p",
      "",
      paid
        ? "Your demo payment was accepted and your order is confirmed."
        : "Your order was placed, but the payment did not go through. Please contact us and quote your order number."
    )
  );

  const number = el("div", "cart-receipt");
  number.append(el("span", "", "Order number"), el("strong", "", order.order_number));
  cartBody.appendChild(number);

  order.items.forEach((item) => {
    const line = el("div", "receipt-line");
    line.append(
      el("span", "", item.quantity + " × " + item.name),
      el("span", "", money(toCents(item.unit_price) * item.quantity))
    );
    cartBody.appendChild(line);
  });

  const total = el("div", "receipt-line");
  total.append(el("strong", "", "Total"), el("strong", "", money(toCents(order.total))));
  cartBody.appendChild(total);

  const status = el("div", "receipt-line");
  status.append(el("span", "", "Status"), el("span", "", paid ? "Paid" : "Awaiting payment"));
  cartBody.appendChild(status);

  cartBody.appendChild(
    el("p", "cart-note", "Keep your order number. This demo does not send emails.")
  );

  const done = el("button", "cart-primary", "Close");
  done.type = "button";
  done.addEventListener("click", closeCart);
  cartBody.appendChild(done);
}

// Events
cartButton.addEventListener("click", openCart);
cartClose.addEventListener("click", closeCart);
cartOverlay.addEventListener("click", closeCart);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !cartDrawer.hidden) closeCart();
});

updateCount();