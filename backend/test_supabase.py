import os
import httpx
from dotenv import load_dotenv

load_dotenv()

url = os.environ["SUPABASE_URL"].rstrip("/")
key = os.environ["SUPABASE_SERVICE_KEY"]

response = httpx.get(
    url + "/rest/v1/products?select=*",
    headers={"apikey": key},
    timeout=15,
)
print(response.status_code)
print(response.text)