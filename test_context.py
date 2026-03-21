import requests

BASE = "http://localhost:8000"

print("--- TESTING CONTEXT REJECTION ---")
# 1. Auth loop
r = requests.post(f"{BASE}/auth/request-otp", json={"email": "ok@gmail.com"})
r = requests.post(f"{BASE}/auth/verify-otp", json={"email": "ok@gmail.com", "code": "000000"})
data = r.json()
TOKEN = data.get("token")
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

# 2. Save unrelated prompts
r1 = requests.post(f"{BASE}/saved-prompts", headers=HEADERS, json={
    "title": "Cricket Pro",
    "content": "I am pro in cricket. I know all the rules and players.",
    "tags": ["cricket"]
})
r2 = requests.post(f"{BASE}/saved-prompts", headers=HEADERS, json={
    "title": "OOPs Beginner",
    "content": "I am a beginner in OOPS. Explain things simply.",
    "tags": ["coding"]
})

p1_id = r1.json().get("id")
p2_id = r2.json().get("id")

# 3. Enhance with the conflict
prompt_text = "say brett lee is bowling to me, i am right handed, he bowls an off stump yorker. now to different field combination, what are different possible shots i could play"

print(f"Sending prompt + selected contexts: [Cricket Pro, OOPs Beginner]")
r = requests.post(f"{BASE}/enhance", headers=HEADERS, json={
    "prompt": prompt_text,
    "mode": "deep",
    "selected_prompt_ids": [p1_id, p2_id]
})

print(f"Status: {r.status_code}")
if r.status_code == 200:
    res = r.json()
    print(f"\nENHANCED OUTPUT:\n{res.get('enhanced')}")
    
    if "OOP" in res.get("enhanced").upper():
        print("\n❌ FAIL: The LLM still mentioned OOPs.")
    else:
        print("\n✅ SUCCESS: The LLM correctly ignored the OOPs context and focused on cricket.")

# cleanup
requests.delete(f"{BASE}/saved-prompts/{p1_id}", headers=HEADERS)
requests.delete(f"{BASE}/saved-prompts/{p2_id}", headers=HEADERS)
