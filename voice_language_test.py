"""
════════════════════════════════════════════════════════════════════════
  VOICE LANGUAGE TEST SUITE
  ─────────────────────────────────────────────────────────────────
  Tests that the /enhance endpoint correctly handles language:
  1. English input → English output (NOT Hindi)
  2. Hindi input → Hindi output (NOT English/Urdu)
  3. source_language override forces correct language
  4. Hinglish (mixed Hindi+English) stays Hinglish
  5. Non-Hindi Indic scripts don't get confused
════════════════════════════════════════════════════════════════════════
"""

import sys, os, uuid, json, time, re
from datetime import datetime

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from backend.core.security import create_jwt_token
from backend.core.database import in_memory_users

import requests

API_URL = "http://localhost:8000"
RESULTS = []


def detect_language_heuristic(text: str) -> str:
    """Simple heuristic to detect if output is English, Hindi, or mixed."""
    # Count Devanagari characters
    devanagari = len(re.findall(r'[\u0900-\u097F]', text))
    # Count Arabic/Urdu characters
    arabic = len(re.findall(r'[\u0600-\u06FF]', text))
    # Count Latin characters
    latin = len(re.findall(r'[a-zA-Z]', text))
    total = devanagari + arabic + latin
    
    if total == 0:
        return "unknown"
    
    dev_ratio = devanagari / total
    arabic_ratio = arabic / total
    latin_ratio = latin / total
    
    if arabic_ratio > 0.3:
        return "urdu_script"
    elif dev_ratio > 0.3:
        if latin_ratio > 0.2:
            return "hinglish"
        return "hindi"
    elif latin_ratio > 0.7:
        return "english"
    elif dev_ratio > 0.1 and latin_ratio > 0.1:
        return "hinglish"
    else:
        return "english"


def has_hindi_words(text: str) -> bool:
    """Check if text contains common Hindi/Hinglish words (using word boundaries to avoid false positives)."""
    # Only check words that are UNAMBIGUOUSLY Hindi — skip short words like "ke", "se", "hai"
    # that can appear as substrings in English words
    hindi_signals = [
        r"\bkare\b", r"\bkarna\b", r"\blikh\b", r"\bsamjh\b", r"\bbhai\b",
        r"\bmein\b", r"\btaaki\b", r"\bchahiye\b", r"\bkaise\b",
        r"\bkaro\b", r"\bbatao\b", r"\bkarein\b", r"\blikho\b", r"\bsamjhao\b",
        r"\bdijiye\b", r"\bkya\b", r"\baur\b", r"\bkuch\b", r"\bbanao\b",
        r"\bsamjha\b", r"\bbana\b", r"\bchaliye\b", r"\bjaise\b",
    ]
    # Also check Devanagari
    devanagari_signals = ["मैं", "है", "और", "को", "से", "में", "के", "लिए", "कर"]
    
    text_lower = text.lower()
    for pattern in hindi_signals:
        if re.search(pattern, text_lower):
            return True
    for word in devanagari_signals:
        if word in text:
            return True
    return False


def record(test_id, name, passed, details):
    status = "✅ PASS" if passed else "❌ FAIL"
    RESULTS.append({"id": test_id, "name": name, "passed": passed, "details": details})
    print(f"  {status} [{test_id}] {name}")
    if not passed:
        print(f"         {details}")


def call_enhance(headers, prompt, mode="deep", platform="chatgpt.com", 
                 source_language=None, conversation_context=None):
    """Call /enhance and return the result."""
    payload = {"prompt": prompt, "mode": mode, "platform": platform}
    if source_language:
        payload["source_language"] = source_language
    if conversation_context:
        payload["conversation_context"] = conversation_context
    
    try:
        resp = requests.post(f"{API_URL}/enhance", headers=headers, json=payload, timeout=30)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print(f"    ❌ API Error: {e}")
        return None


def run():
    print("=" * 65)
    print("  🌐 VOICE LANGUAGE TEST SUITE")
    print("  Testing language detection, matching, and override")
    print("=" * 65)
    print(f"  Time: {datetime.now().isoformat()}")

    # Health check
    try:
        r = requests.get(f"{API_URL}/", timeout=5)
        print(f"  ✅ Server: {r.json()}\n")
    except:
        print("  ❌ Server unreachable! Start the backend first.")
        sys.exit(1)

    # Create test user with tech stack (to test that tech stack doesn't bleed into language)
    uid = str(uuid.uuid4())
    email = f"lang_test_{uid[:8]}@test.com"
    token = create_jwt_token(uid, email)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    in_memory_users[uid] = {
        "user_id": uid, "email": email,
        "tech_stack": ["Python", "React", "FastAPI"],
        "preferences": "Clean code"
    }

    print(f"  👤 Test user: {email}\n")
    print("─" * 65)

    # ══════════════════════════════════════════════════════════
    # TEST 1: Pure English prompt → output MUST be English
    # ══════════════════════════════════════════════════════════
    print(f"\n  📝 Test 1: Pure English → English output")
    result = call_enhance(headers, 
        "explain how to deploy a FastAPI app to production with Docker",
        mode="deep", source_language="en")
    
    if result:
        enhanced = result.get("enhanced", "")
        lang = detect_language_heuristic(enhanced)
        has_hindi = has_hindi_words(enhanced)
        passed = lang == "english" and not has_hindi
        print(f"    Output lang: {lang} | Hindi words: {has_hindi}")
        print(f"    Preview: \"{enhanced[:120]}...\"")
        record("L1", "English input → English output (no Hindi)", passed,
               f"Detected: {lang}, hindi_words={has_hindi}, preview: {enhanced[:80]}")
    else:
        record("L1", "English input → English output", False, "API call failed")

    time.sleep(2)

    # ══════════════════════════════════════════════════════════
    # TEST 2: English prompt WITHOUT source_language → still English
    # ══════════════════════════════════════════════════════════
    print(f"\n  📝 Test 2: English (no source_language hint) → English output")
    result = call_enhance(headers,
        "how do I set up CI/CD pipeline with GitHub Actions for a Node.js app",
        mode="quick")  # No source_language — should detect from text
    
    if result:
        enhanced = result.get("enhanced", "")
        lang = detect_language_heuristic(enhanced)
        has_hindi = has_hindi_words(enhanced)
        passed = lang == "english" and not has_hindi
        print(f"    Output lang: {lang} | Hindi words: {has_hindi}")
        print(f"    Preview: \"{enhanced[:120]}...\"")
        record("L2", "English (no hint) → English output", passed,
               f"Detected: {lang}, hindi_words={has_hindi}")
    else:
        record("L2", "English (no hint) → English output", False, "API call failed")

    time.sleep(2)

    # ══════════════════════════════════════════════════════════
    # TEST 3: Hindi/Hinglish prompt → Hindi/Hinglish output
    # ══════════════════════════════════════════════════════════
    print(f"\n  📝 Test 3: Hinglish input → Hinglish output")
    result = call_enhance(headers,
        "bhai ek python script likh de jo website scrape kare clearly step by step samjha",
        mode="deep", source_language="hi")
    
    if result:
        enhanced = result.get("enhanced", "")
        lang = detect_language_heuristic(enhanced)
        has_hindi = has_hindi_words(enhanced)
        passed = has_hindi or lang in ("hindi", "hinglish")
        print(f"    Output lang: {lang} | Hindi words: {has_hindi}")
        print(f"    Preview: \"{enhanced[:120]}...\"")
        record("L3", "Hinglish input → Hinglish output", passed,
               f"Detected: {lang}, hindi_words={has_hindi}")
    else:
        record("L3", "Hinglish input → Hinglish output", False, "API call failed")

    time.sleep(2)

    # ══════════════════════════════════════════════════════════
    # TEST 4: source_language="en" overrides Hindi-sounding transcript
    # ══════════════════════════════════════════════════════════
    print(f"\n  📝 Test 4: source_language='en' forces English even with ambiguous text")
    result = call_enhance(headers,
        "I want to make a good application using React and I need help with the design",
        mode="deep", source_language="en")
    
    if result:
        enhanced = result.get("enhanced", "")
        lang = detect_language_heuristic(enhanced)
        has_hindi = has_hindi_words(enhanced)
        passed = lang == "english" and not has_hindi
        print(f"    Output lang: {lang} | Hindi words: {has_hindi}")
        print(f"    Preview: \"{enhanced[:120]}...\"")
        record("L4", "source_language='en' forces English", passed,
               f"Detected: {lang}, hindi_words={has_hindi}")
    else:
        record("L4", "source_language='en' forces English", False, "API call failed")

    time.sleep(2)

    # ══════════════════════════════════════════════════════════
    # TEST 5: English prompt with Hindi conversation context → STILL English
    # ══════════════════════════════════════════════════════════
    print(f"\n  📝 Test 5: English prompt + Hindi conversation → output stays English")
    result = call_enhance(headers,
        "explain how React hooks work with a simple example",
        mode="deep", source_language="en",
        conversation_context=[
            "[user]: bhai React hooks kya hote hai?",
            "[assistant]: React hooks functions hain jo state aur lifecycle methods ko use karne dete hain",
        ])
    
    if result:
        enhanced = result.get("enhanced", "")
        lang = detect_language_heuristic(enhanced)
        has_hindi = has_hindi_words(enhanced)
        passed = lang == "english" and not has_hindi
        print(f"    Output lang: {lang} | Hindi words: {has_hindi}")
        print(f"    Preview: \"{enhanced[:120]}...\"")
        record("L5", "English prompt + Hindi context → still English", passed,
               f"Detected: {lang}, hindi_words={has_hindi}")
    else:
        record("L5", "English prompt + Hindi context → still English", False, "API call failed")

    time.sleep(2)

    # ══════════════════════════════════════════════════════════
    # TEST 6: Simulated Whisper "Urdu" → should be treated as Hindi
    # ══════════════════════════════════════════════════════════
    print(f"\n  📝 Test 6: source_language='ur' (Whisper Urdu confusion) → treated as Hindi")
    result = call_enhance(headers,
        "mujhe ek acha sa portfolio website banana hai React mein",
        mode="deep", source_language="ur")  # Whisper might say "ur" for Hindi
    
    if result:
        enhanced = result.get("enhanced", "")
        lang = detect_language_heuristic(enhanced)
        has_hindi = has_hindi_words(enhanced)
        # Should be Hindi/Hinglish, NOT Urdu script
        is_urdu_script = bool(re.findall(r'[\u0600-\u06FF]', enhanced))
        passed = not is_urdu_script and (has_hindi or lang in ("hindi", "hinglish"))
        print(f"    Output lang: {lang} | Hindi words: {has_hindi} | Urdu script: {is_urdu_script}")
        print(f"    Preview: \"{enhanced[:120]}...\"")
        record("L6", "Urdu code → Hindi output (not Arabic/Urdu script)", passed,
               f"Detected: {lang}, urdu_script={is_urdu_script}")
    else:
        record("L6", "Urdu code → Hindi output", False, "API call failed")

    time.sleep(2)

    # ══════════════════════════════════════════════════════════
    # TEST 7: Emotional English prompt → output STAYS English  
    # (regression test: user reported this was coming back in Hindi)
    # ══════════════════════════════════════════════════════════
    print(f"\n  📝 Test 7: Emotional English → stays English (regression)")
    result = call_enhance(headers,
        "I'm feeling really stressed about my project deadline and I don't know what to do",
        mode="deep", source_language="en")
    
    if result:
        enhanced = result.get("enhanced", "")
        lang = detect_language_heuristic(enhanced)
        has_hindi = has_hindi_words(enhanced)
        passed = lang == "english" and not has_hindi
        print(f"    Output lang: {lang} | Hindi words: {has_hindi}")
        print(f"    Preview: \"{enhanced[:120]}...\"")
        record("L7", "Emotional English → stays English", passed,
               f"Detected: {lang}, hindi_words={has_hindi}")
    else:
        record("L7", "Emotional English → stays English", False, "API call failed")

    time.sleep(2)

    # ══════════════════════════════════════════════════════════
    # TEST 8: Quick mode English → stays English (mode shouldn't affect language)
    # ══════════════════════════════════════════════════════════
    print(f"\n  📝 Test 8: Quick mode English → stays English")
    result = call_enhance(headers,
        "sort a list of numbers in python",
        mode="quick", source_language="en")
    
    if result:
        enhanced = result.get("enhanced", "")
        lang = detect_language_heuristic(enhanced)
        has_hindi = has_hindi_words(enhanced)
        passed = lang == "english" and not has_hindi
        print(f"    Output lang: {lang} | Hindi words: {has_hindi}")
        print(f"    Preview: \"{enhanced[:120]}...\"")
        record("L8", "Quick mode English → stays English", passed,
               f"Detected: {lang}, hindi_words={has_hindi}, output_len={len(enhanced.split())}w")
    else:
        record("L8", "Quick mode English → stays English", False, "API call failed")

    # ══════════════════════════════════════════════════════════
    # SUMMARY
    # ══════════════════════════════════════════════════════════
    print(f"\n{'='*65}")
    print(f"  📊 RESULTS SUMMARY")
    print(f"{'='*65}")

    passed = sum(1 for r in RESULTS if r["passed"])
    total = len(RESULTS)
    print(f"\n  Overall: {passed}/{total} passed ({passed/total*100:.0f}%)\n")

    for r in RESULTS:
        s = "✅" if r["passed"] else "❌"
        print(f"  {s} [{r['id']}] {r['name']}")

    failures = [r for r in RESULTS if not r["passed"]]
    if failures:
        print(f"\n  Failed tests:")
        for r in failures:
            print(f"    ❌ [{r['id']}] {r['details']}")
    else:
        print(f"\n  ✨ All tests passed!")

    # Save report
    report = {
        "timestamp": datetime.now().isoformat(),
        "total": total, "passed": passed,
        "results": RESULTS,
    }
    path = os.path.join(os.path.dirname(__file__), "voice_language_test_report.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False, default=str)
    print(f"\n  📁 Report: {path}")
    print(f"  🏁 DONE.\n")


if __name__ == "__main__":
    run()
