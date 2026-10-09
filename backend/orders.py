import re
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from shop import SUPABASE_URL, current_admin, db_headers

router = APIRouter()

MAX_QTY = 20
MAX_ORDERS_PER_HOUR = 5
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
REVENUE_STATUSES = {"paid", "shipped", "delivered"}
ALL_STATUSES = ("ordered", "paid", "shipped", "delivered", "cancelled")
NEXT_STATUS = {
    "ordered": {"paid", "cancelled"},
    "paid": {"shipped", "cancelled"},
    "shipped": {"delivered"},
    "delivered": set(),
    "cancelled": set(),
}
ORDER_COLUMNS = (
    "id,order_number,customer_name,email,phone,address,city,notes,total,"
    "status,payment_method,paid_at,created_at,"
    "order_items(product_name,unit_price,quantity,image_url)"
)


class OrderItemIn(BaseModel):
    product_id: int
    quantity: int = Field(ge=1, le=MAX_QTY)


class OrderIn(BaseModel):
    customer_name: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=5, max_length=120)
    phone: str = Field(min_length=5, max_length=30)
    address: str = Field(min_length=5, max_length=300)
    city: str = Field(min_length=2, max_length=80)
    notes: str = Field("", max_length=500)
    items: list[OrderItemIn] = Field(min_length=1, max_length=20)

    @field_validator("email")
    @classmethod
    def check_email(cls, value: str) -> str:
        value = value.strip().lower()
        if not EMAIL_PATTERN.match(value):
            raise ValueError("Please enter a valid email address.")
        return value


class PayRequest(BaseModel):
    token: str = Field(min_length=10, max_length=100)


class StatusUpdate(BaseModel):
    status: Literal["paid", "shipped", "delivered", "cancelled"]


@router.post("/orders", status_code=201)
def create_order(body: OrderIn):
    # Simple spam limit: a few orders per email per hour
    since = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    recent = httpx.get(
        SUPABASE_URL + "/rest/v1/orders",
        headers=db_headers(),
        params={"email": f"eq.{body.email}", "created_at": f"gte.{since}", "select": "id"},
        timeout=15,
    )
    if recent.status_code == 200 and len(recent.json()) >= MAX_ORDERS_PER_HOUR:
        raise HTTPException(status_code=429, detail="Too many orders from this email. Please try again later.")

    # Merge repeated products
    quantities = {}
    for item in body.items:
        quantities[item.product_id] = quantities.get(item.product_id, 0) + item.quantity
    if any(q > MAX_QTY for q in quantities.values()):
        raise HTTPException(status_code=400, detail=f"You can order at most {MAX_QTY} of each item.")

    # Prices always come from the database, never from the browser
    ids = ",".join(str(i) for i in sorted(quantities))
    found = httpx.get(
        SUPABASE_URL + "/rest/v1/products",
        headers=db_headers(),
        params={"id": f"in.({ids})", "select": "id,name,price,image_url"},
        timeout=15,
    )
    if found.status_code != 200:
        raise HTTPException(status_code=503, detail="Could not check the products. Please try again.")
    products = {p["id"]: p for p in found.json()}
    if len(products) != len(quantities):
        raise HTTPException(status_code=400, detail="One or more products are no longer available.")

    total = Decimal("0")
    lines = []
    for product_id, qty in quantities.items():
        product = products[product_id]
        unit = Decimal(str(product["price"]))
        total += unit * qty
        lines.append({
            "product_id": product_id,
            "product_name": product["name"],
            "unit_price": float(unit),
            "quantity": qty,
            "image_url": product.get("image_url"),
        })
    total = total.quantize(Decimal("0.01"))

    public_token = secrets.token_urlsafe(24)
    order = None
    order_number = ""
    for _ in range(3):
        order_number = "BR-" + secrets.token_hex(4).upper()
        response = httpx.post(
            SUPABASE_URL + "/rest/v1/orders",
            headers=db_headers({"Content-Type": "application/json", "Prefer": "return=representation"}),
            json={
                "order_number": order_number,
                "public_token": public_token,
                "customer_name": body.customer_name.strip(),
                "email": body.email,
                "phone": body.phone.strip(),
                "address": body.address.strip(),
                "city": body.city.strip(),
                "notes": body.notes.strip() or None,
                "total": float(total),
                "status": "ordered",
            },
            timeout=15,
        )
        if response.status_code == 201:
            order = response.json()[0]
            break
        if response.status_code != 409:
            break
    if order is None:
        raise HTTPException(status_code=502, detail="Could not place the order. Please try again.")

    items_response = httpx.post(
        SUPABASE_URL + "/rest/v1/order_items",
        headers=db_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        json=[{**line, "order_id": order["id"]} for line in lines],
        timeout=15,
    )
    if items_response.status_code != 201:
        httpx.delete(
            SUPABASE_URL + "/rest/v1/orders",
            headers=db_headers(),
            params={"id": f"eq.{order['id']}"},
            timeout=15,
        )
        raise HTTPException(status_code=502, detail="Could not place the order. Please try again.")

    return {
        "order_number": order_number,
        "public_token": public_token,
        "total": float(total),
        "status": "ordered",
        "items": [
            {"name": l["product_name"], "quantity": l["quantity"], "unit_price": l["unit_price"]}
            for l in lines
        ],
    }


@router.post("/orders/{order_number}/pay")
def pay_order(order_number: str, body: PayRequest):
    # Demo payment. A real provider would confirm the payment on the server.
    lookup = httpx.get(
        SUPABASE_URL + "/rest/v1/orders",
        headers=db_headers(),
        params={"order_number": f"eq.{order_number}", "select": "id,public_token,status"},
        timeout=15,
    )
    rows = lookup.json() if lookup.status_code == 200 else []
    if not rows or not secrets.compare_digest(
        rows[0]["public_token"].encode("utf-8"), body.token.encode("utf-8")
    ):
        raise HTTPException(status_code=404, detail="Order not found.")
    if rows[0]["status"] != "ordered":
        raise HTTPException(status_code=409, detail="This order can't be paid.")

    updated = httpx.patch(
        SUPABASE_URL + "/rest/v1/orders",
        headers=db_headers({"Content-Type": "application/json", "Prefer": "return=representation"}),
        params={"id": f"eq.{rows[0]['id']}", "status": "eq.ordered"},
        json={
            "status": "paid",
            "payment_method": "demo_card",
            "paid_at": datetime.now(timezone.utc).isoformat(),
        },
        timeout=15,
    )
    if updated.status_code != 200 or not updated.json():
        raise HTTPException(status_code=409, detail="This order can't be paid.")
    return {"order_number": order_number, "status": "paid"}


@router.get("/admin/orders")
def admin_orders(status: str | None = None, admin: dict = Depends(current_admin)):
    params = {"select": ORDER_COLUMNS, "order": "created_at.desc", "limit": "200"}
    if status:
        if status not in ALL_STATUSES:
            raise HTTPException(status_code=400, detail="Unknown status.")
        params["status"] = f"eq.{status}"
    response = httpx.get(
        SUPABASE_URL + "/rest/v1/orders", headers=db_headers(), params=params, timeout=15
    )
    if response.status_code != 200:
        raise HTTPException(status_code=503, detail="Could not load orders.")
    return response.json()


@router.patch("/admin/orders/{order_id}/status")
def update_status(order_id: int, body: StatusUpdate, admin: dict = Depends(current_admin)):
    lookup = httpx.get(
        SUPABASE_URL + "/rest/v1/orders",
        headers=db_headers(),
        params={"id": f"eq.{order_id}", "select": "status"},
        timeout=15,
    )
    rows = lookup.json() if lookup.status_code == 200 else []
    if not rows:
        raise HTTPException(status_code=404, detail="Order not found.")

    current = rows[0]["status"]
    if body.status not in NEXT_STATUS.get(current, set()):
        raise HTTPException(status_code=400, detail=f"An order can't change from {current} to {body.status}.")

    changes = {"status": body.status}
    if body.status == "paid":
        changes["paid_at"] = datetime.now(timezone.utc).isoformat()
        changes["payment_method"] = "manual"

    updated = httpx.patch(
        SUPABASE_URL + "/rest/v1/orders",
        headers=db_headers({"Content-Type": "application/json", "Prefer": "return=representation"}),
        params={"id": f"eq.{order_id}", "status": f"eq.{current}"},
        json=changes,
        timeout=15,
    )
    if updated.status_code != 200 or not updated.json():
        raise HTTPException(status_code=409, detail="The order changed. Please refresh and try again.")
    return {"id": order_id, "status": body.status}


@router.get("/admin/stats")
def admin_stats(admin: dict = Depends(current_admin)):
    response = httpx.get(
        SUPABASE_URL + "/rest/v1/orders",
        headers=db_headers(),
        params={
            "select": "order_number,customer_name,email,total,status,created_at,"
                      "order_items(product_name,quantity,image_url)",
            "order": "created_at.desc",
            "limit": "1000",
        },
        timeout=20,
    )
    if response.status_code != 200:
        raise HTTPException(status_code=503, detail="Could not load statistics.")
    orders = response.json()
    counted = [o for o in orders if o["status"] != "cancelled"]

    status_counts = {s: 0 for s in ALL_STATUSES}
    for o in orders:
        status_counts[o["status"]] += 1

    revenue = sum(
        (Decimal(str(o["total"])) for o in orders if o["status"] in REVENUE_STATUSES),
        Decimal("0"),
    )

    # Last 12 months, oldest first
    now = datetime.now(timezone.utc)
    year, month = now.year, now.month
    keys = []
    for _ in range(12):
        keys.append(f"{year:04d}-{month:02d}")
        month -= 1
        if month == 0:
            month = 12
            year -= 1
    keys.reverse()
    monthly = {k: {"month": k, "orders": 0, "revenue": 0.0} for k in keys}
    for o in counted:
        key = o["created_at"][:7]
        if key in monthly:
            monthly[key]["orders"] += 1
            if o["status"] in REVENUE_STATUSES:
                monthly[key]["revenue"] += float(o["total"])

    sold = {}
    for o in counted:
        for item in o["order_items"]:
            entry = sold.setdefault(
                item["product_name"],
                {"name": item["product_name"], "quantity": 0, "image_url": item.get("image_url")},
            )
            entry["quantity"] += item["quantity"]
    bestsellers = sorted(sold.values(), key=lambda e: e["quantity"], reverse=True)[:5]

    recent = [
        {
            "order_number": o["order_number"],
            "customer_name": o["customer_name"],
            "total": float(o["total"]),
            "status": o["status"],
            "created_at": o["created_at"],
            "item_count": sum(i["quantity"] for i in o["order_items"]),
        }
        for o in orders[:8]
    ]

    return {
        "total_orders": len(counted),
        "revenue": float(revenue),
        "awaiting_payment": status_counts["ordered"],
        "to_ship": status_counts["paid"],
        "customers": len({o["email"] for o in counted}),
        "status_counts": status_counts,
        "monthly": list(monthly.values()),
        "bestsellers": bestsellers,
        "recent": recent,
    }