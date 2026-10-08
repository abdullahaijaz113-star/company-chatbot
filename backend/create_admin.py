import getpass
import os

import bcrypt
import httpx
from dotenv import load_dotenv

load_dotenv()

url = os.environ["SUPABASE_URL"].rstrip("/")
key = os.environ["SUPABASE_SERVICE_KEY"]

username = input("Admin username: ").strip().lower()
password = getpass.getpass("Admin password (min 8 characters): ")
confirm = getpass.getpass("Repeat password: ")

if len(username) < 3:
    raise SystemExit("Username must be at least 3 characters.")
if len(password) < 8:
    raise SystemExit("Password must be at least 8 characters.")
if len(password.encode("utf-8")) > 72:
    raise SystemExit("Password must be 72 bytes or fewer.")
if password != confirm:
    raise SystemExit("Passwords do not match.")

password_hash = bcrypt.hashpw(
    password.encode("utf-8"), bcrypt.gensalt()
).decode("utf-8")

response = httpx.post(
    url + "/rest/v1/admins",
    headers={
        "apikey": key,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    },
    json={"username": username, "password_hash": password_hash},
    timeout=15,
)

if response.status_code == 201:
    print("Admin created:", username)
elif response.status_code == 409:
    print("That username already exists.")
else:
    print("Failed:", response.status_code, response.text)