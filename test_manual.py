import requests
import sys
import time

BASE = "http://localhost:8000"

def log(test_name, passed, details=""):
    status = "PASS" if passed else "FAIL"
    print(f"{status} | {test_name}: {details}")

print("--- SIMULATING USER JOURNEY ---")
# 1. Auth
r = requests.post(f"{BASE}/auth/request-otp", json={"email": "ok@gmail.com"})
r = requests.post(f"{BASE}/auth/verify-otp", json={"email": "ok@gmail.com", "code": "000000"})
data = r.json()
TOKEN = data.get("token")
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
log("Login with OTP", bool(TOKEN))

# 2. Save prompt
r = requests.post(f"{BASE}/saved-prompts", headers=HEADERS, json={
    "title": "My Persona",
    "content": "I am a senior frontend engineer. I want all code in TypeScript and styled with Tailwind CSS.",
    "tags": ["persona", "frontend"]
})
data = r.json()
saved_id = data.get("id")
log("Save prompt", bool(saved_id), f"ID: {saved_id}")

# 3. Enhance - Quick
r = requests.post(f"{BASE}/enhance", headers=HEADERS, json={"prompt": "create a button component", "mode": "quick"})
log("Enhance (Quick)", r.status_code == 200, f"Enhanced: {r.json().get('enhanced', '')[:50]}...")

# 4. Enhance - Deep
r = requests.post(f"{BASE}/enhance", headers=HEADERS, json={"prompt": "create a button component", "mode": "deep"})
log("Enhance (Deep)", r.status_code == 200, f"Enhanced: {r.json().get('enhanced', '')[:50]}...")

# 5. Enhance - Creative
r = requests.post(f"{BASE}/enhance", headers=HEADERS, json={"prompt": "create a button component", "mode": "creative"})
log("Enhance (Creative)", r.status_code == 200, f"Enhanced: {r.json().get('enhanced', '')[:50]}...")

# 6. Enhance with saved prompt
r = requests.post(f"{BASE}/enhance", headers=HEADERS, json={
    "prompt": "create a button component",
    "mode": "deep",
    "selected_prompt_ids": [saved_id]
})
log("Enhance with Saved Prompt", r.status_code == 200, f"Enhanced: {r.json().get('enhanced', '')[:50]}...")

# 7. Delete saved prompt
r = requests.delete(f"{BASE}/saved-prompts/{saved_id}", headers=HEADERS)
log("Delete saved prompt", r.status_code == 200)

print("--- JOURNEY COMPLETE ---")
