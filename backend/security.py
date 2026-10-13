import hashlib
import hmac
import os
import secrets
import smtplib
import time
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import httpx
import jwt
from dotenv import load_dotenv
from fastapi import HTTPException, Request, Response

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

ALLOWED_ORIGINS = {"https://brewly-coffee-site.vercel.app"}
CUSTOMER_COOKIE = "brewly_customer"
ADMIN_COOKIE = "brewly_admin"
MFA_COOKIE = "brewly_mfa"

JWT_SECRET = os.environ["JWT_SECRET"]
ADMIN_2FA_REQUIRED = os.environ.get("ADMIN_2FA_REQUIRED", "true").strip().lower() != "false"
OTP_MINUTES = 5
OTP_MAX_TRIES = 5          # guesses allowed per emailed code
OTP_RESEND_SECONDS = 60
OTP_MAX_SENDS = 5          # codes per account per 15 minutes
BACKUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

MAX_ATTEMPTS = 5       # failed attempts allowed per window (per IP) and before an account locks
WINDOW_MINUTES = 15
LOCKOUT_MINUTES = 15
IP_LIMITS_ENABLED = os.environ.get("IP_LIMITS_ENABLED", "true").strip().lower() != "false"


def _headers(extra=None):
    headers = {"apikey": SUPABASE_KEY}
    if extra:
        headers.update(extra)
    return headers


def _now():
    return datetime.now(timezone.utc)


def _iso(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------- Cookies ----------
def set_cookie(response: Response, name: str, token: str, max_age: int):
    response.set_cookie(
        key=name,
        value=token,
        max_age=max_age,
        path="/",
        httponly=True,
        secure=True,
        samesite="strict",
    )


def clear_cookie(response: Response, name: str):
    set_cookie(response, name, "", 0)


# ---------- Tokens ----------
def make_jwt(secret: str, claims: dict, seconds: int) -> str:
    return jwt.encode({**claims, "exp": int(time.time()) + seconds}, secret, algorithm="HS256")


def read_jwt(secret: str, token, role: str) -> dict:
    if not token:
        raise HTTPException(status_code=401, detail="Please log in again.")
    try:
        data = jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Please log in again.")
    if data.get("role") != role:
        raise HTTPException(status_code=401, detail="Please log in again.")
    return data


# ---------- Request checks ----------
def check_origin(request: Request):
    """Extra CSRF guard: refuse state-changing requests that come from another website."""
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        origin = request.headers.get("origin")
        own = f"{request.url.scheme}://{request.headers.get('host', '')}"
        if origin and origin not in ALLOWED_ORIGINS and origin != own:
            raise HTTPException(status_code=403, detail="Request blocked.")


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "unknown")[:64]


# ---------- Audit log and rate limits ----------
def log_attempt(kind: str, identifier: str, ip: str, success: bool, reason: str = ""):
    print(f"AUDIT kind={kind} success={success} ip={ip} id={identifier[:60]} reason={reason}")
    try:
        httpx.post(
            SUPABASE_URL + "/rest/v1/login_attempts",
            headers=_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
            json={
                "kind": kind,
                "identifier": identifier[:120],
                "ip": ip,
                "success": success,
                "reason": reason,
            },
            timeout=10,
        )
    except httpx.HTTPError:
        print("Could not write the audit log")


def enforce_ip_limit(kind: str, ip: str, failures_only: bool = True):
    """Block an IP after MAX_ATTEMPTS attempts in WINDOW_MINUTES."""
    if not IP_LIMITS_ENABLED or not ip:
        return
    since = _iso(_now() - timedelta(minutes=WINDOW_MINUTES))
    params = {
        "kind": f"eq.{kind}",
        "ip": f"eq.{ip}",
        "created_at": f"gte.{since}",
        "select": "id",
        "limit": str(MAX_ATTEMPTS),
    }
    if failures_only:
        params["success"] = "eq.false"
    try:
        response = httpx.get(
            SUPABASE_URL + "/rest/v1/login_attempts", headers=_headers(), params=params, timeout=10
        )
    except httpx.HTTPError:
        return
    if response.status_code == 200 and len(response.json()) >= MAX_ATTEMPTS:
        raise HTTPException(
            status_code=429,
            detail=f"Too many attempts. Please try again in {WINDOW_MINUTES} minutes.",
        )


# ---------- Account lockout ----------
def check_locked(row: dict, kind: str, identifier: str, ip: str):
    locked_until = row.get("locked_until")
    if not locked_until:
        return
    try:
        until = datetime.fromisoformat(locked_until.replace("Z", "+00:00"))
    except ValueError:
        return
    remaining = (until - _now()).total_seconds()
    if remaining > 0:
        log_attempt(kind, identifier, ip, False, "locked")
        minutes = int(remaining // 60) + 1
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed attempts. Try again in {minutes} minute(s).",
        )


def record_failure(table: str, row: dict):
    attempts = int(row.get("failed_attempts") or 0) + 1
    changes = {"failed_attempts": attempts}
    if attempts >= MAX_ATTEMPTS:
        changes = {
            "failed_attempts": 0,
            "locked_until": _iso(_now() + timedelta(minutes=LOCKOUT_MINUTES)),
        }
    try:
        httpx.patch(
            SUPABASE_URL + f"/rest/v1/{table}",
            headers=_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
            params={"id": f"eq.{row['id']}"},
            json=changes,
            timeout=10,
        )
    except httpx.HTTPError:
        print("Could not update the failed-attempt counter")


def record_success(table: str, row: dict):
    if not row.get("failed_attempts") and not row.get("locked_until"):
        return
    try:
        httpx.patch(
            SUPABASE_URL + f"/rest/v1/{table}",
            headers=_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
            params={"id": f"eq.{row['id']}"},
            json={"failed_attempts": 0, "locked_until": None},
            timeout=10,
        )
    except httpx.HTTPError:
        print("Could not reset the failed-attempt counter")

        # ---------- Two-factor authentication ----------
def _parse(timestamp):
    try:
        return datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def start_mfa(response: Response, subject_type: str, subject_id: int):
    """Password was right: hand out a short-lived cookie that can only be used to enter a code."""
    token = make_jwt(JWT_SECRET, {"sub": str(subject_id), "st": subject_type, "role": "mfa"}, 600)
    set_cookie(response, MFA_COOKIE, token, 600)


def normalize_code(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch.isalnum())


def hash_code(code: str) -> str:
    key = hashlib.sha256(("otp:" + JWT_SECRET).encode("utf-8")).digest()
    return hmac.new(key, code.encode("utf-8"), hashlib.sha256).hexdigest()


def mask_email(address: str) -> str:
    name, _, domain = (address or "").partition("@")
    return (name[:1] + "***@" + domain) if domain else "your email"


def send_email(to_addr, subject: str, text: str) -> bool:
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_APP_PASSWORD")
    if not user or not password or not to_addr:
        print("Email skipped: SMTP settings or recipient missing.")
        return False
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = user
    msg["To"] = to_addr
    msg.set_content(text)
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=8) as server:
            server.login(user, password.replace(" ", ""))
            server.send_message(msg)
        return True
    except Exception as error:
        print("Email failed:", error)
        return False


def create_otp(subject_type: str, subject_id: int, purpose: str) -> str:
    base = {
        "subject_type": f"eq.{subject_type}",
        "subject_id": f"eq.{subject_id}",
        "purpose": f"eq.{purpose}",
    }
    since = _iso(_now() - timedelta(minutes=WINDOW_MINUTES))
    recent = httpx.get(
        SUPABASE_URL + "/rest/v1/otp_codes",
        headers=_headers(),
        params={**base, "created_at": f"gte.{since}", "select": "created_at",
                "order": "created_at.desc", "limit": str(OTP_MAX_SENDS)},
        timeout=10,
    )
    rows = recent.json() if recent.status_code == 200 else []
    if len(rows) >= OTP_MAX_SENDS:
        raise HTTPException(status_code=429, detail="Too many codes requested. Please try again later.")
    if rows:
        last = _parse(rows[0]["created_at"])
        if last and (_now() - last).total_seconds() < OTP_RESEND_SECONDS:
            raise HTTPException(status_code=429, detail="Please wait a minute before asking for another code.")

    # Only the newest code works
    httpx.patch(
        SUPABASE_URL + "/rest/v1/otp_codes",
        headers=_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        params={**base, "used": "eq.false"},
        json={"used": True},
        timeout=10,
    )

    code = f"{secrets.randbelow(10**6):06d}"
    created = httpx.post(
        SUPABASE_URL + "/rest/v1/otp_codes",
        headers=_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        json={
            "subject_type": subject_type,
            "subject_id": subject_id,
            "purpose": purpose,
            "code_hash": hash_code(code),
            "expires_at": _iso(_now() + timedelta(minutes=OTP_MINUTES)),
        },
        timeout=10,
    )
    if created.status_code != 201:
        raise HTTPException(status_code=502, detail="Could not create a code. Please try again.")
    return code


def check_otp(subject_type: str, subject_id: int, purpose: str, code: str) -> bool:
    base = {
        "subject_type": f"eq.{subject_type}",
        "subject_id": f"eq.{subject_id}",
        "purpose": f"eq.{purpose}",
    }
    found = httpx.get(
        SUPABASE_URL + "/rest/v1/otp_codes",
        headers=_headers(),
        params={**base, "used": "eq.false", "select": "id,code_hash,attempts,expires_at",
                "order": "created_at.desc", "limit": "1"},
        timeout=10,
    )
    rows = found.json() if found.status_code == 200 else []
    if not rows:
        return False
    row = rows[0]
    expires = _parse(row["expires_at"])
    if not expires or expires <= _now() or row["attempts"] >= OTP_MAX_TRIES:
        return False

    # Count the guess before checking it
    httpx.patch(
        SUPABASE_URL + "/rest/v1/otp_codes",
        headers=_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        params={"id": f"eq.{row['id']}"},
        json={"attempts": row["attempts"] + 1},
        timeout=10,
    )
    if not hmac.compare_digest(row["code_hash"], hash_code(code)):
        return False

    # Single use: only one request can flip used from false to true
    used = httpx.patch(
        SUPABASE_URL + "/rest/v1/otp_codes",
        headers=_headers({"Content-Type": "application/json", "Prefer": "return=representation"}),
        params={"id": f"eq.{row['id']}", "used": "eq.false"},
        json={"used": True},
        timeout=10,
    )
    return used.status_code == 200 and len(used.json()) == 1


def has_backup_codes(subject_type: str, subject_id: int) -> bool:
    found = httpx.get(
        SUPABASE_URL + "/rest/v1/backup_codes",
        headers=_headers(),
        params={"subject_type": f"eq.{subject_type}", "subject_id": f"eq.{subject_id}",
                "select": "id", "limit": "1"},
        timeout=10,
    )
    return found.status_code == 200 and len(found.json()) > 0


def generate_backup_codes(subject_type: str, subject_id: int) -> list:
    """Replaces any old codes with 8 new single-use codes. Only the hashes are stored."""
    httpx.delete(
        SUPABASE_URL + "/rest/v1/backup_codes",
        headers=_headers(),
        params={"subject_type": f"eq.{subject_type}", "subject_id": f"eq.{subject_id}"},
        timeout=10,
    )
    codes = ["".join(secrets.choice(BACKUP_ALPHABET) for _ in range(10)) for _ in range(8)]
    created = httpx.post(
        SUPABASE_URL + "/rest/v1/backup_codes",
        headers=_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        json=[{"subject_type": subject_type, "subject_id": subject_id, "code_hash": hash_code(c)} for c in codes],
        timeout=10,
    )
    if created.status_code != 201:
        raise HTTPException(status_code=502, detail="Could not create backup codes. Please try again.")
    return [c[:5] + "-" + c[5:] for c in codes]


def use_backup_code(subject_type: str, subject_id: int, code: str) -> bool:
    if len(code) != 10:
        return False
    used = httpx.patch(
        SUPABASE_URL + "/rest/v1/backup_codes",
        headers=_headers({"Content-Type": "application/json", "Prefer": "return=representation"}),
        params={"subject_type": f"eq.{subject_type}", "subject_id": f"eq.{subject_id}",
                "code_hash": f"eq.{hash_code(code)}", "used": "eq.false"},
        json={"used": True},
        timeout=10,
    )
    return used.status_code == 200 and len(used.json()) == 1