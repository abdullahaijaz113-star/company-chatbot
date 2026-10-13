// Customer accounts: sign up and log in.
// The session is an HttpOnly cookie set by the server, so JavaScript never sees or stores a token.
const accountButton = document.getElementById("account-button");

// Display info only (never a credential). Rebuilt from the server on every page load.
let currentCustomer = null;

// Remove tokens saved by the earlier version of this file
try {
  localStorage.removeItem("brewly_customer_token");
  localStorage.removeItem("brewly_customer_name");
} catch (e) {}

function acEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isLoggedIn() {
  return currentCustomer !== null;
}

// Other scripts (orders, favorites) can listen for this
function announceAuthChange() {
  document.dispatchEvent(new CustomEvent("brewly:auth-changed"));
}

function updateAccountButton() {
  const on = isLoggedIn();
  accountButton.classList.toggle("signed-in", on);
  accountButton.setAttribute("aria-label", on ? "My account" : "Log in or sign up");
}

async function accountApi(path, options = {}) {
  const response = await fetch(SESSION_API + path, { ...options, credentials: "include" });

  let data = null;
  try {
    data = await response.json();
  } catch (e) {}

  const isAuthForm = path === "/account/login" || path === "/account/signup";
  if (response.status === 401 && currentCustomer && !isAuthForm) {
    currentCustomer = null;
    updateAccountButton();
    announceAuthChange();
  }
  return { ok: response.ok, status: response.status, data };
}

function accountErrorText(result) {
  const detail = result.data && result.data.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail[0] && detail[0].msg) return detail[0].msg;
  return "Something went wrong. Please try again.";
}

// Ask the server whether the cookie is a valid session
async function loadSession() {
  try {
    const result = await accountApi("/account/session");
    currentCustomer =
      result.ok && result.data && result.data.authenticated
        ? { name: result.data.name, email: result.data.email, twofa_enabled: result.data.twofa_enabled }
        : null;
  } catch (e) {
    currentCustomer = null;
  }
  updateAccountButton();
  announceAuthChange();
}

// The popup (built once)
const accountOverlay = acEl("div", "account-overlay");
const accountModal = acEl("div", "account-modal");
const accountHeader = acEl("header", "account-header");
const accountTitle = acEl("h2", "", "Account");
const accountClose = acEl("button", "", "✕");
const accountBody = acEl("div", "account-body");

accountOverlay.hidden = true;
accountModal.hidden = true;
accountTitle.id = "account-title";
accountClose.type = "button";
accountClose.setAttribute("aria-label", "Close account");
accountModal.setAttribute("role", "dialog");
accountModal.setAttribute("aria-modal", "true");
accountModal.setAttribute("aria-labelledby", "account-title");
accountHeader.append(accountTitle, accountClose);
accountModal.append(accountHeader, accountBody);
document.body.append(accountOverlay, accountModal);

const sessionReady = loadSession();

async function openAccount() {
  accountOverlay.hidden = false;
  accountModal.hidden = false;
  accountBody.textContent = "";
  accountBody.appendChild(acEl("p", "cart-note", "Loading..."));
  await sessionReady;
  if (isLoggedIn()) renderAccountHome();
  else renderAuth("login");
}

function closeAccount() {
  accountOverlay.hidden = true;
  accountModal.hidden = true;
  accountButton.focus();
}

function acField(labelText, id, attrs) {
  const label = acEl("label", "", labelText);
  const input = document.createElement("input");
  input.id = id;
  Object.entries(attrs).forEach(([key, value]) => input.setAttribute(key, value));
  label.appendChild(input);
  return { label, input };
}

// View: log in or sign up
function renderAuth(mode, notice) {
  const signup = mode === "signup";
  accountTitle.textContent = signup ? "Create your account" : "Log in";
  accountBody.textContent = "";

  const form = document.createElement("form");
  form.className = "checkout-form";

  const nameField = signup
    ? acField("Full name", "ac-name", { type: "text", required: "", minlength: "2", maxlength: "100", autocomplete: "name" })
    : null;
  const emailField = acField("Email", "ac-email", { type: "email", required: "", maxlength: "120", autocomplete: "email" });
  const passwordField = acField(
    "Password",
    "ac-password",
    signup
      ? { type: "password", required: "", minlength: "8", maxlength: "72", autocomplete: "new-password" }
      : { type: "password", required: "", maxlength: "72", autocomplete: "current-password" }
  );

  if (nameField) form.appendChild(nameField.label);
  form.append(emailField.label, passwordField.label);
  if (signup) form.appendChild(acEl("p", "cart-note", "Use at least 8 characters."));

  const message = acEl("p", "cart-error", notice || "");
  message.setAttribute("role", "alert");

  const submit = acEl("button", "cart-primary", signup ? "Create account" : "Log in");
  submit.type = "submit";

  const switchBtn = acEl("button", "cart-secondary", signup ? "I already have an account" : "New here? Create an account");
  switchBtn.type = "button";
  switchBtn.addEventListener("click", () => renderAuth(signup ? "login" : "signup"));

  form.append(message, submit, switchBtn);

  if (!signup) {
    const forgot = acEl("button", "account-link", "Forgot your password?");
    forgot.type = "button";
    forgot.addEventListener("click", () => renderForgot());
    form.appendChild(forgot);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    const label = submit.textContent;
    submit.disabled = true;
    submit.textContent = "Please wait...";

    const payload = {
      email: emailField.input.value.trim(),
      password: passwordField.input.value,
    };
    if (signup) payload.name = nameField.input.value.trim();

    try {
      const result = await accountApi(signup ? "/account/signup" : "/account/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (result.ok && result.data.mfa_required) {
        renderCodeEntry("login");
        return;
      }
      if (result.ok) {
        currentCustomer = { name: result.data.name, email: payload.email.toLowerCase(), twofa_enabled: false };
        updateAccountButton();
        announceAuthChange();
        renderAccountHome();
        return;
      }
      message.textContent = accountErrorText(result);
    } catch (e) {
      message.textContent = "Can't reach the server right now. Please try again.";
    }
    submit.disabled = false;
    submit.textContent = label;
  });

  accountBody.appendChild(form);
  (nameField || emailField).input.focus();
}

// View: logged-in home
function renderAccountHome() {
  accountTitle.textContent = "My account";
  accountBody.textContent = "";
  accountBody.appendChild(acEl("p", "account-hello", "Hi, " + currentCustomer.name + "!"));
  accountBody.appendChild(acEl("p", "account-email", currentCustomer.email));

  const message = acEl("p", "cart-error");
  message.setAttribute("role", "alert");

  const logout = acEl("button", "cart-secondary", "Log out");
  logout.type = "button";
  logout.addEventListener("click", async () => {
    logout.disabled = true;
    message.textContent = "";
    try {
      const result = await accountApi("/account/logout", { method: "POST" });
      if (!result.ok) throw new Error("logout failed");
    } catch (e) {
      logout.disabled = false;
      message.textContent = "Could not log out. Please try again.";
      return;
    }
    currentCustomer = null;
    clearCart(); // new person, new cart: clears memory, storage and the badge
    updateAccountButton();
    announceAuthChange();
    closeAccount();
  });

  accountBody.appendChild(twoFactorSection());
  accountBody.append(logout, message);
}

// Events
accountButton.addEventListener("click", openAccount);
accountClose.addEventListener("click", closeAccount);
accountOverlay.addEventListener("click", closeAccount);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !accountModal.hidden) closeAccount();
});

updateAccountButton();