// Customer accounts: sign up, log in, session
const ACCOUNT_TOKEN_KEY = "brewly_customer_token";
const ACCOUNT_NAME_KEY = "brewly_customer_name";

const accountButton = document.getElementById("account-button");

function acEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function getCustomerToken() {
  try {
    return localStorage.getItem(ACCOUNT_TOKEN_KEY);
  } catch (e) {
    return null;
  }
}

function saveCustomerSession(token, name) {
  try {
    localStorage.setItem(ACCOUNT_TOKEN_KEY, token);
    localStorage.setItem(ACCOUNT_NAME_KEY, name);
  } catch (e) {}
}

function clearCustomerSession() {
  try {
    localStorage.removeItem(ACCOUNT_TOKEN_KEY);
    localStorage.removeItem(ACCOUNT_NAME_KEY);
  } catch (e) {}
}

function isLoggedIn() {
  return Boolean(getCustomerToken());
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
  const headers = { ...(options.headers || {}) };
  const token = getCustomerToken();
  if (token) headers["Authorization"] = "Bearer " + token;

  const response = await fetch(API_URL + path, { ...options, headers });

  let data = null;
  try {
    data = await response.json();
  } catch (e) {}

  const isAuthForm = path === "/account/login" || path === "/account/signup";
  if (response.status === 401 && token && !isAuthForm) {
    clearCustomerSession();
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

function openAccount() {
  accountOverlay.hidden = false;
  accountModal.hidden = false;
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
      if (result.ok) {
        saveCustomerSession(result.data.token, result.data.name);
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
async function renderAccountHome() {
  accountTitle.textContent = "My account";
  accountBody.textContent = "";
  const loading = acEl("p", "cart-note", "Loading...");
  accountBody.appendChild(loading);

  let result;
  try {
    result = await accountApi("/account/me");
  } catch (e) {
    loading.textContent = "Can't reach the server right now. Please try again.";
    return;
  }

  if (!result.ok) {
    if (!isLoggedIn()) {
      renderAuth("login", "Your session expired. Please log in again.");
    } else {
      loading.textContent = accountErrorText(result);
    }
    return;
  }

  accountBody.textContent = "";
  accountBody.appendChild(acEl("p", "account-hello", "Hi, " + result.data.name + "!"));
  accountBody.appendChild(acEl("p", "account-email", result.data.email));

  const logout = acEl("button", "cart-secondary", "Log out");
  logout.type = "button";
  logout.addEventListener("click", () => {
    clearCustomerSession();
    updateAccountButton();
    announceAuthChange();
    closeAccount();
  });
  accountBody.appendChild(logout);
}

// Events
accountButton.addEventListener("click", openAccount);
accountClose.addEventListener("click", closeAccount);
accountOverlay.addEventListener("click", closeAccount);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !accountModal.hidden) closeAccount();
});

updateAccountButton();