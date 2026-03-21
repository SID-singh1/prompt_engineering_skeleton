"""
Llama 3.3 70B Solo Retest — with aggressive retry logic.
Will NOT stop until all 20 prompts are successfully tested.
Uses GROQ_API_KEY_2 (fresh account) to avoid rate limits.
"""

import sys, os, time, json, re
from datetime import datetime
from dotenv import load_dotenv
from groq import Groq

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from backend.routers.prompts import SYSTEM_PROMPT_BASE, MODE_INSTRUCTIONS, OUTPUT_INSTRUCTION
from persona_comparison_test import PROMPTS, score_prompt_quality

MODEL_ID = "llama-3.3-70b-versatile"
MODEL_NAME = "Llama 3.3 70B"
MAX_RETRIES = 20
BASE_DELAY = 15  # 15s between calls — fresh account has full quota


def get_client():
    """Create a Groq client using GROQ_API_KEY_2."""
    load_dotenv(os.path.join(os.path.dirname(__file__), "backend", ".env"))
    key2 = os.getenv("GROQ_API_KEY_2", "").strip()
    if not key2:
        print("  ❌ GROQ_API_KEY_2 not found in .env!")
        sys.exit(1)
    print(f"  🔑 Using GROQ_API_KEY_2: {key2[:10]}...{key2[-4:]}")
    return Groq(api_key=key2)


def build_system_prompt(mode):
    base = SYSTEM_PROMPT_BASE.format(
        tech_stack="Python, JavaScript, React, FastAPI",
        preferences="Clean, modular code. Concise explanations."
    )
    return base + "\n" + MODE_INSTRUCTIONS.get(mode, MODE_INSTRUCTIONS["deep"]) + "\n" + OUTPUT_INSTRUCTION


def run():
    print("=" * 76)
    print(f"  🔁 LLAMA 3.3 70B SOLO RETEST — All {len(PROMPTS)} Prompts, No Skipping")
    print("=" * 76)
    print(f"  Time: {datetime.now().isoformat()}")
    print(f"  Strategy: {BASE_DELAY}s delay between calls + retry up to {MAX_RETRIES}x on rate limit")
    print()

    client = get_client()

    results = []
    outputs = []

    for idx, p in enumerate(PROMPTS):
        sys_prompt = build_system_prompt(p["mode"])
        user_msg = f'### USER\'S PROMPT\n"{p["prompt"]}"\n\n### TASK\nRefine the user\'s prompt. Stay true to their intent.'

        temp = 0.2 if p["mode"] == "quick" else 0.3
        success = False

        for attempt in range(1, MAX_RETRIES + 1):
            start = time.time()
            try:
                resp = client.chat.completions.create(
                    messages=[
                        {"role": "system", "content": sys_prompt},
                        {"role": "user", "content": user_msg},
                    ],
                    model=MODEL_ID,
                    temperature=temp,
                    max_tokens=1024,
                )
                enhanced = resp.choices[0].message.content.strip()
                if "<think>" in enhanced:
                    enhanced = re.sub(r'<think>.*?</think>', '', enhanced, flags=re.DOTALL).strip()
                latency = round(time.time() - start, 2)
                success = True

            except Exception as e:
                latency = round(time.time() - start, 2)
                err_str = str(e)
                if "429" in err_str or "rate" in err_str.lower():
                    # Extract retry-after if available
                    wait = max(BASE_DELAY, 30)
                    # Try to parse retry-after from error
                    import re as re2
                    retry_match = re2.search(r'try again in (\d+\.?\d*)', err_str)
                    if retry_match:
                        wait = float(retry_match.group(1)) + 2
                        wait = max(wait, 30)  # minimum 30s wait
                    print(f"    ⏳ [{p['id']}] Rate limited (attempt {attempt}/{MAX_RETRIES}), waiting {wait:.0f}s...")
                    time.sleep(wait)
                    continue
                else:
                    print(f"    ❌ [{p['id']}] Non-rate-limit error: {err_str[:100]}")
                    enhanced = ""
                    break

            break  # success

        if success:
            eval_result = score_prompt_quality(p, enhanced)
            eval_result["latency"] = latency
            results.append(eval_result)
            outputs.append({
                "id": p["id"],
                "persona": p["persona"],
                "name": p["name"],
                "mode": p["mode"],
                "original": p["prompt"][:200],
                "enhanced": enhanced[:600],
                "score": eval_result["overall"],
                "latency": latency,
                "word_count": eval_result["word_count"],
                "dimensions": {k: v["score"] for k, v in eval_result["dimensions"].items()},
            })

            g = "🟢" if eval_result["overall"] >= 8 else "🟡" if eval_result["overall"] >= 6 else "🔴"
            print(f"  {g} [{eval_result['overall']:>5}/10] [{idx+1:>2}/{len(PROMPTS)}] {p['persona']} {p['id']}: {p['name']} ({latency}s, {eval_result['word_count']}w)")

            for dk, dv in eval_result["dimensions"].items():
                if dv["score"] < 7:
                    print(f"       ❌ {dk}: {dv['score']}/10 — {dv['explanation']}")
        else:
            print(f"  ❌ [{idx+1}/{len(PROMPTS)}] {p['id']}: {p['name']} — FAILED after {MAX_RETRIES} retries")
            results.append({"overall": 0, "error": "max retries"})
            outputs.append({"id": p["id"], "name": p["name"], "error": "max retries"})

        # Delay between calls to avoid rate limit
        if idx < len(PROMPTS) - 1:
            time.sleep(BASE_DELAY)

    # Summary
    valid = [r for r in results if "error" not in r]
    avg = round(sum(r["overall"] for r in valid) / len(valid), 2) if valid else 0
    avg_lat = round(sum(r["latency"] for r in valid) / len(valid), 2) if valid else 0

    print(f"\n{'='*76}")
    print(f"  ⭐ LLAMA 3.3 70B FINAL SCORE: {avg}/10")
    print(f"  ⏱  Average Latency: {avg_lat}s")
    print(f"  ✅ {len(valid)}/{len(PROMPTS)} prompts completed")
    print(f"{'='*76}")

    # Per-persona
    personas = list(dict.fromkeys(p["persona"] for p in PROMPTS))
    print(f"\n  PER-PERSONA:")
    for persona in personas:
        pids = [p["id"] for p in PROMPTS if p["persona"] == persona]
        pscores = []
        for o in outputs:
            if o.get("id") in pids and "error" not in o:
                pscores.append(o["score"])
        if pscores:
            pavg = round(sum(pscores) / len(pscores), 1)
            g = "🟢" if pavg >= 8 else "🟡" if pavg >= 6 else "🔴"
            print(f"    {g} {pavg}/10  {persona} ({len(pscores)} tests)")

    # Save
    report = {
        "timestamp": datetime.now().isoformat(),
        "model": MODEL_NAME,
        "model_id": MODEL_ID,
        "total_prompts": len(PROMPTS),
        "passed": len(valid),
        "failed": len(PROMPTS) - len(valid),
        "avg_score": avg,
        "avg_latency": avg_lat,
        "outputs": outputs,
    }
    path = os.path.join(os.path.dirname(__file__), "llama_retest_report.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False, default=str)
    print(f"\n  📁 Report: {path}")
    print(f"  🏁 DONE.\n")


if __name__ == "__main__":
    run()
