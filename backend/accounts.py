import os
import re

import bcrypt
import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

from security import (
    CUSTOMER_COOKIE,
    check_locked,
    check_origin,
    clear_cookie,
    client_ip,
    enforce_ip_limit,
    log_attempt,
    make_jwt,
    read_jwt,
    record_failure,
    record_success,
    set_cookie,
    start_mfa,
)
from shop import SUPABASE_URL, db_headers

CUSTOMER_JWT_SECRET = os.environ["CUSTOMER_JWT_SECRET"]
TOKEN_DAYS = 7
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DUMMY_HASH = bcrypt.hashpw(b"not-a-real-password", bcrypt.gensalt())

router = APIRouter()


def current_customer(request: Request):
    """Dependency for routes that need a logged-in customer (cookie based)."""
    check_origin(request)
    data = read_jwt(CUSTOMER_JWT_SECRET, request.cookies.get(CUSTOMER_COOKIE), "customer")
    try:
        return {"id": int(data["sub"])}
    except (KeyError, ValueError):
        raise HTTPException(status_code=401, detail="Please log in again.")


def start_session(response: Response, customer_id: int):
    token = make_jwt(
        CUSTOMER_JWT_SECRET,
        {"sub": str(customer_id), "role": "customer"},
        TOKEN_DAYS * 86400,
    )
    set_cookie(response, CUSTOMER_COOKIE, token, TOKEN_DAYS * 86400)


class SignupIn(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=5, max_length=120)
    password: str = Field(min_length=8, max_length=72)

    @field_validator("email")
    @classmethod
    def check_email(cls, value: str) -> str:
        value = value.strip().lower()
        if not EMAIL_PATTERN.match(value):
            raise ValueError("Please enter a valid email address.")
        return value


class LoginIn(BaseModel):
    email: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=72)


@router.post("/account/signup", status_code=201)
def signup(body: SignupIn, request: Request, response: Response):
    check_origin(request)
    ip = client_ip(request)
    enforce_ip_limit("signup", ip, failures_only=False)

    password_bytes = body.password.encode("utf-8")
    if len(password_bytes) > 72:
        raise HTTPException(status_code=400, detail="Password is too long.")
    password_hash = bcrypt.hashpw(password_bytes, bcrypt.gensalt()).decode("utf-8")

    created = httpx.post(
        SUPABASE_URL + "/rest/v1/customers",
        headers=db_headers({"Content-Type": "application/json", "Prefer": "return=representation"}),
        json={"name": body.name.strip(), "email": body.email, "password_hash": password_hash},
        timeout=15,
    )
    if created.status_code == 409:
        log_attempt("signup", body.email, ip, False, "duplicate_email")
        raise HTTPException(status_code=409, detail="An account with that email already exists. Try logging in.")
    if created.status_code != 201:
        log_attempt("signup", body.email, ip, False, "database_error")
        raise HTTPException(status_code=502, detail="Could not create your account. Please try again.")

    customer = created.json()[0]
    log_attempt("signup", body.email, ip, True)
    start_session(response, customer["id"])
    return {"name": customer["name"]}


@router.post("/account/login")
def customer_login(body: LoginIn, request: Request, response: Response):
    check_origin(request)
    ip = client_ip(request)
    email = body.email.strip().lower()
    enforce_ip_limit("customer_login", ip)

    lookup = httpx.get(
        SUPABASE_URL + "/rest/v1/customers",
        headers=db_headers(),
        params={
            "email": f"eq.{email}",
            "select": "id,name,password_hash,twofa_enabled,failed_attempts,locked_until",
        },
        timeout=15,
    )
    if lookup.status_code != 200:
        raise HTTPException(status_code=503, detail="Service unavailable. Please try again.")

    rows = lookup.json()
    customer = rows[0] if rows else None
    if customer:
        check_locked(customer, "customer_login", email, ip)

    stored = customer["password_hash"].encode("utf-8") if customer else DUMMY_HASH
    password_bytes = body.password.encode("utf-8")
    password_ok = len(password_bytes) <= 72 and bcrypt.checkpw(password_bytes, stored)

    if not customer or not password_ok:
        if customer:
            record_failure("customers", customer)
        log_attempt("customer_login", email, ip, False, "bad_password" if customer else "unknown_email")
        raise HTTPException(status_code=401, detail="Wrong email or password.")

    if customer.get("twofa_enabled"):
        # Password is right, but the session only starts after the emailed code is verified
        log_attempt("customer_login", email, ip, True, "password_ok")
        start_mfa(response, "customer", customer["id"])
        return {"mfa_required": True}

    record_success("customers", customer)
    log_attempt("customer_login", email, ip, True)
    start_session(response, customer["id"])
    return {"name": customer["name"]}


@router.get("/account/session")
def account_session(request: Request, response: Response):
    """Always answers 200, so the site can ask 'am I logged in?' without console errors."""
    try:
        data = read_jwt(CUSTOMER_JWT_SECRET, request.cookies.get(CUSTOMER_COOKIE), "customer")
        customer_id = int(data["sub"])
    except (HTTPException, KeyError, ValueError):
        return {"authenticated": False}

    lookup = httpx.get(
        SUPABASE_URL + "/rest/v1/customers",
        headers=db_headers(),
        params={"id": f"eq.{customer_id}", "select": "name,email,twofa_enabled"},
        timeout=15,
    )
    rows = lookup.json() if lookup.status_code == 200 else []
    if not rows:
        clear_cookie(response, CUSTOMER_COOKIE)
        return {"authenticated": False}
    return {
        "authenticated": True,
        "name": rows[0]["name"],
        "email": rows[0]["email"],
        "twofa_enabled": bool(rows[0]["twofa_enabled"]),
    }


@router.post("/account/logout")
def account_logout(request: Request, response: Response):
    check_origin(request)
    clear_cookie(response, CUSTOMER_COOKIE)
    return {"ok": True}