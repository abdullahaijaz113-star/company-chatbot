import os
import re
import time

import bcrypt
import httpx
import jwt
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, field_validator

from shop import SUPABASE_URL, db_headers

load_dotenv()

CUSTOMER_JWT_SECRET = os.environ["CUSTOMER_JWT_SECRET"]
TOKEN_DAYS = 14
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DUMMY_HASH = bcrypt.hashpw(b"not-a-real-password", bcrypt.gensalt())

router = APIRouter()
bearer = HTTPBearer()


def make_token(customer_id: int) -> str:
    return jwt.encode(
        {
            "sub": str(customer_id),
            "role": "customer",
            "exp": int(time.time()) + TOKEN_DAYS * 86400,
        },
        CUSTOMER_JWT_SECRET,
        algorithm="HS256",
    )


def current_customer(creds: HTTPAuthorizationCredentials = Depends(bearer)):
    try:
        data = jwt.decode(creds.credentials, CUSTOMER_JWT_SECRET, algorithms=["HS256"])
        if data.get("role") != "customer":
            raise jwt.InvalidTokenError()
        return {"id": int(data["sub"])}
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="Please log in again.")


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
def signup(body: SignupIn):
    password_bytes = body.password.encode("utf-8")
    if len(password_bytes) > 72:
        raise HTTPException(status_code=400, detail="Password is too long.")
    password_hash = bcrypt.hashpw(password_bytes, bcrypt.gensalt()).decode("utf-8")

    response = httpx.post(
        SUPABASE_URL + "/rest/v1/customers",
        headers=db_headers({"Content-Type": "application/json", "Prefer": "return=representation"}),
        json={"name": body.name.strip(), "email": body.email, "password_hash": password_hash},
        timeout=15,
    )
    if response.status_code == 409:
        raise HTTPException(status_code=409, detail="An account with that email already exists. Try logging in.")
    if response.status_code != 201:
        raise HTTPException(status_code=502, detail="Could not create your account. Please try again.")

    customer = response.json()[0]
    return {"token": make_token(customer["id"]), "name": customer["name"]}


@router.post("/account/login")
def customer_login(body: LoginIn):
    email = body.email.strip().lower()
    response = httpx.get(
        SUPABASE_URL + "/rest/v1/customers",
        headers=db_headers(),
        params={"email": f"eq.{email}", "select": "id,name,password_hash"},
        timeout=15,
    )
    if response.status_code != 200:
        raise HTTPException(status_code=503, detail="Service unavailable. Please try again.")

    rows = response.json()
    customer = rows[0] if rows else None
    stored = customer["password_hash"].encode("utf-8") if customer else DUMMY_HASH
    password_bytes = body.password.encode("utf-8")

    password_ok = len(password_bytes) <= 72 and bcrypt.checkpw(password_bytes, stored)
    if not customer or not password_ok:
        raise HTTPException(status_code=401, detail="Wrong email or password.")

    return {"token": make_token(customer["id"]), "name": customer["name"]}


@router.get("/account/me")
def account_me(customer: dict = Depends(current_customer)):
    response = httpx.get(
        SUPABASE_URL + "/rest/v1/customers",
        headers=db_headers(),
        params={"id": f"eq.{customer['id']}", "select": "id,name,email,created_at"},
        timeout=15,
    )
    rows = response.json() if response.status_code == 200 else []
    if not rows:
        raise HTTPException(status_code=401, detail="Please log in again.")
    return rows[0]