import os
import time
import uuid

import bcrypt
import httpx
import jwt
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
JWT_SECRET = os.environ["JWT_SECRET"]

BUCKET = "product-images"
TOKEN_HOURS = 8
MAX_IMAGE_BYTES = 2 * 1024 * 1024
IMAGE_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
DUMMY_HASH = bcrypt.hashpw(b"not-a-real-password", bcrypt.gensalt())

router = APIRouter()
bearer = HTTPBearer()


def db_headers(extra=None):
    headers = {"apikey": SUPABASE_KEY}
    if extra:
        headers.update(extra)
    return headers


def current_admin(creds: HTTPAuthorizationCredentials = Depends(bearer)):
    try:
        data = jwt.decode(creds.credentials, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Please log in again.")
    return {"id": int(data["sub"]), "username": data["username"]}


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1, max_length=72)


class NewAdmin(BaseModel):
    username: str = Field(min_length=3, max_length=50)
    password: str = Field(min_length=8, max_length=72)


@router.post("/admin/login")
def login(body: LoginRequest):
    username = body.username.strip().lower()
    response = httpx.get(
        SUPABASE_URL + "/rest/v1/admins",
        headers=db_headers(),
        params={"username": f"eq.{username}", "select": "id,username,password_hash"},
        timeout=15,
    )
    if response.status_code != 200:
        raise HTTPException(status_code=503, detail="Service unavailable. Please try again.")

    rows = response.json()
    admin = rows[0] if rows else None
    stored = admin["password_hash"].encode("utf-8") if admin else DUMMY_HASH
    password_bytes = body.password.encode("utf-8")

    password_ok = len(password_bytes) <= 72 and bcrypt.checkpw(password_bytes, stored)
    if not admin or not password_ok:
        raise HTTPException(status_code=401, detail="Wrong username or password.")

    token = jwt.encode(
        {
            "sub": str(admin["id"]),
            "username": admin["username"],
            "exp": int(time.time()) + TOKEN_HOURS * 3600,
        },
        JWT_SECRET,
        algorithm="HS256",
    )
    return {"token": token, "username": admin["username"]}


@router.post("/admin/admins", status_code=201)
def add_admin(body: NewAdmin, admin: dict = Depends(current_admin)):
    username = body.username.strip().lower()
    password_bytes = body.password.encode("utf-8")
    if len(password_bytes) > 72:
        raise HTTPException(status_code=400, detail="Password is too long.")

    password_hash = bcrypt.hashpw(password_bytes, bcrypt.gensalt()).decode("utf-8")
    response = httpx.post(
        SUPABASE_URL + "/rest/v1/admins",
        headers=db_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        json={"username": username, "password_hash": password_hash},
        timeout=15,
    )
    if response.status_code == 409:
        raise HTTPException(status_code=409, detail="That username already exists.")
    if response.status_code != 201:
        raise HTTPException(status_code=502, detail="Could not create the admin.")
    return {"created": username}


@router.get("/products")
def list_products():
    response = httpx.get(
        SUPABASE_URL + "/rest/v1/products",
        headers=db_headers(),
        params={
            "select": "id,name,description,price,image_url",
            "order": "created_at.desc",
        },
        timeout=15,
    )
    if response.status_code != 200:
        raise HTTPException(status_code=503, detail="Could not load products.")
    return response.json()


@router.post("/products", status_code=201)
async def create_product(
    name: str = Form(..., min_length=1, max_length=100),
    description: str = Form("", max_length=1000),
    price: float = Form(..., ge=0, le=100000),
    image: UploadFile | None = File(None),
    admin: dict = Depends(current_admin),
):
    image_url = None

    if image is not None and image.filename:
        extension = IMAGE_TYPES.get(image.content_type)
        if not extension:
            raise HTTPException(status_code=400, detail="Image must be JPG, PNG, or WebP.")
        data = await image.read()
        if len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail="Image must be 2 MB or smaller.")

        filename = f"{uuid.uuid4().hex}.{extension}"
        upload = httpx.post(
            f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{filename}",
            headers=db_headers({"Content-Type": image.content_type}),
            content=data,
            timeout=30,
        )
        if upload.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail="Image upload failed.")
        image_url = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{filename}"

    response = httpx.post(
        SUPABASE_URL + "/rest/v1/products",
        headers=db_headers({"Content-Type": "application/json", "Prefer": "return=representation"}),
        json={
            "name": name.strip(),
            "description": description.strip(),
            "price": price,
            "image_url": image_url,
            "created_by": admin["id"],
        },
        timeout=15,
    )
    if response.status_code != 201:
        raise HTTPException(status_code=502, detail="Could not save the product.")
    return response.json()[0]


@router.delete("/products/{product_id}")
def delete_product(product_id: int, admin: dict = Depends(current_admin)):
    lookup = httpx.get(
        SUPABASE_URL + "/rest/v1/products",
        headers=db_headers(),
        params={"id": f"eq.{product_id}", "select": "image_url"},
        timeout=15,
    )
    rows = lookup.json() if lookup.status_code == 200 else []
    if not rows:
        raise HTTPException(status_code=404, detail="Product not found.")

    removed = httpx.delete(
        SUPABASE_URL + "/rest/v1/products",
        headers=db_headers(),
        params={"id": f"eq.{product_id}"},
        timeout=15,
    )
    if removed.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail="Could not delete the product.")

    image_url = rows[0].get("image_url")
    if image_url:
        filename = image_url.rsplit("/", 1)[-1]
        try:
            httpx.delete(
                f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{filename}",
                headers=db_headers(),
                timeout=15,
            )
        except httpx.HTTPError:
            pass

    return {"deleted": product_id}