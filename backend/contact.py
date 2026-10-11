import re
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from shop import SUPABASE_URL, current_admin, db_headers

router = APIRouter()

MAX_MESSAGES_PER_HOUR = 5
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MESSAGE_COLUMNS = "id,name,email,phone,topic,message,handled,created_at"


class ContactIn(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=5, max_length=120)
    phone: str = Field("", max_length=30)
    topic: str = Field(min_length=2, max_length=100)
    message: str = Field(min_length=5, max_length=2000)
    website: str = Field("", max_length=200)  # hidden field that only bots fill in

    @field_validator("email")
    @classmethod
    def check_email(cls, value: str) -> str:
        value = value.strip().lower()
        if not EMAIL_PATTERN.match(value):
            raise ValueError("Please enter a valid email address.")
        return value


class HandledUpdate(BaseModel):
    handled: bool


@router.post("/contact", status_code=201)
def send_message(body: ContactIn):
    # Bots fill in the hidden field. Pretend it worked and save nothing.
    if body.website.strip():
        return {"received": True}

    since = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    recent = httpx.get(
        SUPABASE_URL + "/rest/v1/messages",
        headers=db_headers(),
        params={"email": f"eq.{body.email}", "created_at": f"gte.{since}", "select": "id"},
        timeout=15,
    )
    if recent.status_code == 200 and len(recent.json()) >= MAX_MESSAGES_PER_HOUR:
        raise HTTPException(status_code=429, detail="Too many messages from this email. Please try again later.")

    response = httpx.post(
        SUPABASE_URL + "/rest/v1/messages",
        headers=db_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        json={
            "name": body.name.strip(),
            "email": body.email,
            "phone": body.phone.strip() or None,
            "topic": body.topic.strip(),
            "message": body.message.strip(),
        },
        timeout=15,
    )
    if response.status_code != 201:
        raise HTTPException(status_code=502, detail="Could not send your message. Please try again.")
    return {"received": True}


@router.get("/admin/messages")
def list_messages(admin: dict = Depends(current_admin)):
    response = httpx.get(
        SUPABASE_URL + "/rest/v1/messages",
        headers=db_headers(),
        params={"select": MESSAGE_COLUMNS, "order": "created_at.desc", "limit": "200"},
        timeout=15,
    )
    if response.status_code != 200:
        raise HTTPException(status_code=503, detail="Could not load messages.")
    return response.json()


@router.patch("/admin/messages/{message_id}")
def set_handled(message_id: int, body: HandledUpdate, admin: dict = Depends(current_admin)):
    response = httpx.patch(
        SUPABASE_URL + "/rest/v1/messages",
        headers=db_headers({"Content-Type": "application/json", "Prefer": "return=representation"}),
        params={"id": f"eq.{message_id}"},
        json={"handled": body.handled},
        timeout=15,
    )
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Could not update the message.")
    if not response.json():
        raise HTTPException(status_code=404, detail="Message not found.")
    return {"id": message_id, "handled": body.handled}


@router.delete("/admin/messages/{message_id}")
def delete_message(message_id: int, admin: dict = Depends(current_admin)):
    response = httpx.delete(
        SUPABASE_URL + "/rest/v1/messages",
        headers=db_headers(),
        params={"id": f"eq.{message_id}"},
        timeout=15,
    )
    if response.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail="Could not delete the message.")
    return {"deleted": message_id}