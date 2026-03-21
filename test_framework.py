import argparse
import sys
import uuid
import requests
import json
import os
import time

# We will import the security module to generate a fresh JWT
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from backend.core.security import create_jwt_token
from backend.core.database import in_memory_users

API_URL = "http://localhost:8000"

def run_tests():
    # 1. Create a random user
    random_id = str(uuid.uuid4())
    random_email = f"temp_tester_{random_id[:8]}@gmail.com"
    print(f"--- STARTING DEEP TESTING ---")
    print(f"Created Random User: {random_email} (ID: {random_id})")
    
    # 2. Generate a valid JWT token directly (to bypass OTP email)
    token = create_jwt_token(random_id, random_email)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

    # Manually register the user in memory so the backend has a profile
    in_memory_users[random_id] = {
        "user_id": random_id,
        "email": random_email,
        "tech_stack": ["Python", "JavaScript", "React"],
        "preferences": "Concise and direct"
    }

    scenarios = [
        {
            "name": "Scenario 1: Extremely Vague Prompt (Deep Mode)",
            "payload": {
                "prompt": "fix it",
                "mode": "deep",
                "platform": "unknown"
            }
        },
        {
            "name": "Scenario 2: Vague Prompt WITH Conversation Context (Quick Mode)",
            "payload": {
                "prompt": "fix it",
                "mode": "quick",
                "platform": "chatgpt.com",
                "conversation_context": [
                    "[user]: My React component is re-rendering infinitely.",
                    "[assistant]: This usually happens due to missing dependency arrays in useEffect. Can you show your code?",
                    "[user]: useEffect(() => { setCounter(counter + 1); });"
                ]
            }
        },
        {
            "name": "Scenario 3: Technical Setup (Deep Mode + Target Platform)",
            "payload": {
                "prompt": "write a python script to scrape a website",
                "mode": "deep",
                "platform": "claude.ai"
            }
        },
        {
            "name": "Scenario 4: Creative Exploration (Creative Mode)",
            "payload": {
                "prompt": "explain quantum physics",
                "mode": "creative",
                "platform": "grok.com"
            }
        }
    ]

    results = []

    for idx, scene in enumerate(scenarios):
        print(f"\n[{idx+1}/{len(scenarios)}] {scene['name']}")
        print(f"  System Input: {json.dumps(scene['payload'], indent=2)}")
        
        start = time.time()
        try:
            resp = requests.post(f"{API_URL}/enhance", headers=headers, json=scene["payload"])
            resp.raise_for_status()
            data = resp.json()
            latency = time.time() - start
            
            print(f"  => LLM Latency: {latency:.2f}s")
            print(f"  => Enhanced Prompt:\n     {data.get('enhanced')}")
            print(f"  => Context Used: {data.get('context_used')}")
            
            scene["result"] = data
            scene["latency"] = latency
            results.append(scene)
        except Exception as e:
            print(f"  => Exception: {e}")
            if hasattr(e, 'response') and e.response:
                print(e.response.text)

    # Output detailed report
    report_path = "test_report.json"
    with open(report_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\n✅ Testing complete. Results saved to {report_path}")

if __name__ == '__main__':
    run_tests()
