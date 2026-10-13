// Two-step verification and password reset screens. Uses helpers from account.js.

// Section shown on the "My account" screen
function twoFactorSection() {
  const box = acEl("div", "account-section");
  if (currentCustomer.twofa_enabled) {
    box.appendChild(acEl("p", "", "Two-step verification is on. We email you a code when you log in."));
    return box;
  }
  box.appendChild(acEl("p", "", "Add an email code to your login for extra protection."));
  const turnOn = acEl("button", "cart-secondary", "Turn on two-step verification");
  turnOn.type = "button";
  turnOn.addEventListener("click", () => renderCodeEntry("enable"));
  box.appendChild(turnOn);
  return box;
}

// purpose: "login" (finish logging in) or "enable" (turn 2FA on)
function renderCodeEntry(purpose) {
  const enabling = purpose === "enable";
  accountTitle.textContent = enabling ? "Turn on two-step verification" : "Enter your code";
  accountBody.textContent = "";

  const info = acEl("p", "cart-note", "Sending your code...");
  const form = document.createElement("form");
  form.className = "checkout-form";

  const codeField = acField(
    enabling ? "6-digit code" : "6-digit code or backup code",
    "ac-code",
    { type: "text", required: "", maxlength: "24", autocomplete: "one-time-code", inputmode: enabling ? "numeric" : "text" }
  );
  const message = acEl("p", "cart-error");
  message.setAttribute("role", "alert");

  const submit = acEl("button", "cart-primary", enabling ? "Turn on" : "Verify");
  submit.type = "submit";
  const resend = acEl("button", "cart-secondary", "Send a new code");
  resend.type = "button";
  const back = acEl("button", "account-link", "Back");
  back.type = "button";
  back.addEventListener("click", () => (enabling ? renderAccountHome() : renderAuth("login")));

  async function sendCode() {
    message.textContent = "";
    resend.disabled = true;
    try {
      const result = await accountApi("/account/2fa/send-otp", { method: "POST" });
      if (result.ok) {
        info.textContent = "We emailed a 6-digit code to " + result.data.to + ". It expires in 5 minutes.";
      } else {
        info.textContent = "";
        message.textContent = accountErrorText(result);
      }
    } catch (e) {
      info.textContent = "";
      message.textContent = "Can't reach the server right now. Please try again.";
    }
    resend.disabled = false;
  }

  resend.addEventListener("click", sendCode);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    submit.disabled = true;
    try {
      const result = await accountApi("/account/2fa/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: codeField.input.value }),
      });
      if (result.ok && enabling) {
        currentCustomer.twofa_enabled = true;
        renderBackupCodes(result.data.backup_codes);
        return;
      }
      if (result.ok) {
        await loadSession();
        if (isLoggedIn()) renderAccountHome();
        else renderAuth("login");
        return;
      }
      message.textContent = accountErrorText(result);
    } catch (e) {
      message.textContent = "Can't reach the server right now. Please try again.";
    }
    submit.disabled = false;
  });

  form.append(codeField.label, message, submit, resend);
  accountBody.append(info, form, back);
  codeField.input.focus();
  sendCode();
}

function renderBackupCodes(codes) {
  accountTitle.textContent = "Save your backup codes";
  accountBody.textContent = "";
  accountBody.appendChild(
    acEl("p", "cart-note", "If you can't get an email code, use one of these instead. Each works once. They won't be shown again, so save them somewhere safe.")
  );
  accountBody.appendChild(acEl("div", "backup-codes", codes.join("\n")));

  const copy = acEl("button", "cart-secondary", "Copy codes");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      copy.textContent = "Copied";
    } catch (e) {
      copy.textContent = "Select the codes above and copy them";
    }
  });

  const done = acEl("button", "cart-primary", "I've saved them");
  done.type = "button";
  done.addEventListener("click", () => renderAccountHome());
  accountBody.append(copy, done);
}

// Password reset, step 1: ask for a code
function renderForgot() {
  accountTitle.textContent = "Reset your password";
  accountBody.textContent = "";

  const form = document.createElement("form");
  form.className = "checkout-form";
  const emailField = acField("Email", "ac-forgot-email", { type: "email", required: "", maxlength: "120", autocomplete: "email" });
  const message = acEl("p", "cart-error");
  message.setAttribute("role", "alert");
  const submit = acEl("button", "cart-primary", "Send reset code");
  submit.type = "submit";
  const back = acEl("button", "cart-secondary", "Back to log in");
  back.type = "button";
  back.addEventListener("click", () => renderAuth("login"));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    submit.disabled = true;
    const email = emailField.input.value.trim();
    try {
      const result = await accountApi("/account/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (result.ok) {
        renderReset(email);
        return;
      }
      message.textContent = accountErrorText(result);
    } catch (e) {
      message.textContent = "Can't reach the server right now. Please try again.";
    }
    submit.disabled = false;
  });

  form.append(emailField.label, message, submit, back);
  accountBody.appendChild(form);
  emailField.input.focus();
}

// Password reset, step 2: code and new password
function renderReset(email) {
  accountTitle.textContent = "Choose a new password";
  accountBody.textContent = "";
  accountBody.appendChild(
    acEl("p", "cart-note", "If that email has an account, we sent a 6-digit code. It expires in 5 minutes.")
  );

  const form = document.createElement("form");
  form.className = "checkout-form";
  const codeField = acField("6-digit code", "ac-reset-code", { type: "text", required: "", maxlength: "12", inputmode: "numeric", autocomplete: "one-time-code" });
  const passwordField = acField("New password", "ac-reset-password", { type: "password", required: "", minlength: "8", maxlength: "72", autocomplete: "new-password" });
  const message = acEl("p", "cart-error");
  message.setAttribute("role", "alert");
  const submit = acEl("button", "cart-primary", "Update password");
  submit.type = "submit";
  const back = acEl("button", "cart-secondary", "Back to log in");
  back.type = "button";
  back.addEventListener("click", () => renderAuth("login"));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    submit.disabled = true;
    try {
      const result = await accountApi("/account/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          code: codeField.input.value,
          new_password: passwordField.input.value,
        }),
      });
      if (result.ok) {
        accountTitle.textContent = "Password updated";
        accountBody.textContent = "";
        accountBody.appendChild(acEl("p", "account-ok", "Your password has been updated."));
        const login = acEl("button", "cart-primary", "Log in");
        login.type = "button";
        login.addEventListener("click", () => renderAuth("login"));
        accountBody.appendChild(login);
        return;
      }
      message.textContent = accountErrorText(result);
    } catch (e) {
      message.textContent = "Can't reach the server right now. Please try again.";
    }
    submit.disabled = false;
  });

  form.append(codeField.label, passwordField.label, message, submit, back);
  accountBody.appendChild(form);
  codeField.input.focus();
}