import os
import time
from datetime import datetime, timedelta, timezone

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