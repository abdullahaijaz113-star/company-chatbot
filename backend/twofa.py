import os

import bcrypt
import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from accounts import current_customer, start_session
from security import (
    ADMIN_COOKIE,
    MFA_COOKIE,
    check_locked,
    check_origin,
    check_otp,
    clear_cookie,
    client_ip,
    create_otp,
    enforce_ip_limit,
    generate_backup_codes,
    has_backup_codes,
    log_attempt,
    make_jwt,
    mask_email,
    normalize_code,
    read_jwt,
    record_failure,
    record_success,
    send_email,
    set_cookie,
    use_backup_code,
)
from shop import JWT_SECRET, SUPABASE_URL, TOKEN_HOURS, db_headers

router = APIRouter()

TABLES = {"customer": "customers", "admin": "admins"}
SUBJECT_COLUMNS = {
    "customer": "id,name,email,twofa_enabled,failed_attempts,locked_until",
    "admin": "id,username,email,failed_attempts,locked_until",
}


def mfa_subject(request: Request):
    """Who is in the middle of a login? Read from the short-lived MFA cookie, or None."""
    token = request.cookies.get(MFA_COOKIE)
    if not token:
        return None
    try:
        data = read_jwt(JWT_SECRET, token, "mfa")
        subject_type = data["st"]
        subject_id = int(data["sub"])
    except (HTTPException, KeyError, ValueError):
        return None
    if subject_type not in TABLES:
        return None
    return subject_type, subject_id


def load_subject(subject_type: str, subject_id: int) -> dict:
    response = httpx.get(
        SUPABASE_URL + "/rest/v1/" + TABLES[subject_type],
        headers=db_headers(),
        params={"id": f"eq.{subject_id}", "select": SUBJECT_COLUMNS[subject_type]},
        timeout=15,
    )
    rows = response.json() if response.status_code == 200 else []
    if not rows:
        raise HTTPException(status_code=401, detail="Please log in again.")
    return rows[0]


def email_for(subject_type: str, row: dict):
    if subject_type == "admin":
        return row.get("email") or os.environ.get("ADMIN_NOTIFY_EMAIL")
    return row["email"]


def identifier_for(subject_type: str, row: dict) -> str:
    return row["username"] if subject_type == "admin" else row["email"]


def looks_like_otp(code: str) -> bool:
    return len(code) == 6 and code.isdigit()


class VerifyIn(BaseModel):
    code: str = Field(min_length=6, max_length=24)


class ForgotIn(BaseModel):
    email: str = Field(min_length=3, max_length=120)


class ResetIn(BaseModel):
    email: str = Field(min_length=3, max_length=120)
    code: str = Field(min_length=6, max_length=12)
    new_password: str = Field(min_length=8, max_length=72)


@router.post("/account/2fa/send-otp")
def send_otp(request: Request):
    check_origin(request)
    ip = client_ip(request)

    mfa = mfa_subject(request)
    if mfa:
        subject_type, subject_id = mfa
        purpose = "login"
    else:
        subject_type = "customer"
        subject_id = current_customer(request)["id"]  # 401 if not logged in
        purpose = "enable_2fa"

    enforce_ip_limit("otp_send", ip, failures_only=False)
    row = load_subject(subject_type, subject_id)
    if purpose == "enable_2fa" and row.get("twofa_enabled"):
        raise HTTPException(status_code=400, detail="Two-step verification is already on.")

    to_addr = email_for(subject_type, row)
    code = create_otp(subject_type, subject_id, purpose)
    log_attempt("otp_send", identifier_for(subject_type, row), ip, True, purpose)

    sent = send_email(
        to_addr,
        "Your Brewly verification code",
        f"Your Brewly verification code is {code}.\n\n"
        f"It expires in 5 minutes and works once. If you didn't ask for it, "
        f"someone may know your password, so please change it.",
    )
    if not sent:
        raise HTTPException(status_code=502, detail="Could not send the code email. Please try again.")
    return {"sent": True, "to": mask_email(to_addr)}


@router.post("/account/2fa/verify-otp")
def verify_otp(body: VerifyIn, request: Request, response: Response):
    check_origin(request)
    ip = client_ip(request)
    code = normalize_code(body.code)

    mfa = mfa_subject(request)
    if mfa:
        # Finishing a login
        subject_type, subject_id = mfa
        enforce_ip_limit("otp_verify", ip)
        row = load_subject(subject_type, subject_id)
        ident = identifier_for(subject_type, row)
        check_locked(row, "otp_verify", ident, ip)

        if looks_like_otp(code):
            ok = check_otp(subject_type, subject_id, "login", code)
        else:
            ok = use_backup_code(subject_type, subject_id, code)
        if not ok:
            record_failure(TABLES[subject_type], row)
            log_attempt("otp_verify", ident, ip, False, "bad_code")
            raise HTTPException(status_code=400, detail="That code is wrong or has expired.")

        record_success(TABLES[subject_type], row)
        log_attempt("otp_verify", ident, ip, True)

        if subject_type == "admin":
            # An admin's first successful login also creates their backup codes
            codes = None if has_backup_codes("admin", row["id"]) else generate_backup_codes("admin", row["id"])
            token = make_jwt(
                JWT_SECRET,
                {"sub": str(row["id"]), "username": row["username"], "role": "admin"},
                TOKEN_HOURS * 3600,
            )
            clear_cookie(response, MFA_COOKIE)
            set_cookie(response, ADMIN_COOKIE, token, TOKEN_HOURS * 3600)
            result = {"role": "admin", "username": row["username"]}
            if codes:
                result["backup_codes"] = codes
            return result

        clear_cookie(response, MFA_COOKIE)
        start_session(response, row["id"])
        return {"role": "customer", "name": row["name"]}

    # Turning 2FA on for a logged-in customer
    customer = current_customer(request)  # 401 if not logged in
    enforce_ip_limit("otp_verify", ip)
    row = load_subject("customer", customer["id"])
    if row.get("twofa_enabled"):
        raise HTTPException(status_code=400, detail="Two-step verification is already on.")
    if not looks_like_otp(code) or not check_otp("customer", row["id"], "enable_2fa", code):
        log_attempt("otp_verify", row["email"], ip, False, "bad_enable_code")
        raise HTTPException(status_code=400, detail="That code is wrong or has expired.")

    codes = generate_backup_codes("customer", row["id"])
    httpx.patch(
        SUPABASE_URL + "/rest/v1/customers",
        headers=db_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        params={"id": f"eq.{row['id']}"},
        json={"twofa_enabled": True},
        timeout=15,
    )
    log_attempt("otp_verify", row["email"], ip, True, "2fa_enabled")
    return {"enabled": True, "backup_codes": codes}


@router.post("/account/forgot-password")
def forgot_password(body: ForgotIn, request: Request):
    check_origin(request)
    ip = client_ip(request)
    email = body.email.strip().lower()
    enforce_ip_limit("forgot_password", ip, failures_only=False)
    log_attempt("forgot_password", email, ip, True)

    lookup = httpx.get(
        SUPABASE_URL + "/rest/v1/customers",
        headers=db_headers(),
        params={"email": f"eq.{email}", "select": "id,email"},
        timeout=15,
    )
    rows = lookup.json() if lookup.status_code == 200 else []
    if rows:
        try:
            code = create_otp("customer", rows[0]["id"], "reset_password")
            send_email(
                rows[0]["email"],
                "Reset your Brewly password",
                f"Your Brewly password reset code is {code}.\n\n"
                f"It expires in 5 minutes and works once. If you didn't ask for it, you can ignore this email.",
            )
        except HTTPException:
            pass  # too many codes already: answer the same way

    # Same answer whether or not the email has an account
    return {"sent": True}


@router.post("/account/reset-password")
def reset_password(body: ResetIn, request: Request):
    check_origin(request)
    ip = client_ip(request)
    email = body.email.strip().lower()
    enforce_ip_limit("reset_password", ip)

    password_bytes = body.new_password.encode("utf-8")
    if len(password_bytes) > 72:
        raise HTTPException(status_code=400, detail="Password is too long.")

    lookup = httpx.get(
        SUPABASE_URL + "/rest/v1/customers",
        headers=db_headers(),
        params={"email": f"eq.{email}", "select": "id,failed_attempts,locked_until"},
        timeout=15,
    )
    rows = lookup.json() if lookup.status_code == 200 else []
    customer = rows[0] if rows else None
    if customer:
        check_locked(customer, "reset_password", email, ip)

    code = normalize_code(body.code)
    ok = bool(customer) and looks_like_otp(code) and check_otp("customer", customer["id"], "reset_password", code)
    if not ok:
        if customer:
            record_failure("customers", customer)
        log_attempt("reset_password", email, ip, False, "bad_code")
        raise HTTPException(status_code=400, detail="That code is wrong or has expired.")

    password_hash = bcrypt.hashpw(password_bytes, bcrypt.gensalt()).decode("utf-8")
    updated = httpx.patch(
        SUPABASE_URL + "/rest/v1/customers",
        headers=db_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        params={"id": f"eq.{customer['id']}"},
        json={"password_hash": password_hash, "failed_attempts": 0, "locked_until": None},
        timeout=15,
    )
    if updated.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail="Could not update your password. Please try again.")
    log_attempt("reset_password", email, ip, True)
    return {"ok": True}