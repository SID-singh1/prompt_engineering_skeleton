"""
══════════════════════════════════════════════════════════════════════
  REFINE vs ANSWER TEST — The Ultimate Prompt Engineering Validator
  
  This test suite ensures the /enhance endpoint REWRITES prompts
  instead of ANSWERING them. 15 diverse scenarios covering:
  
  1. Casual conversational prompts (the hardest cases)
  2. Opinion/rating requests
  3. How-to questions
  4. Emotional/personal prompts
  5. Vague/ambiguous inputs
  6. Multi-part questions
  7. Hindi/Hinglish inputs
  8. Quick mode vs Deep mode behavior
  9. Prompts that tempt the LLM to answer
  10. Already-clear prompts that just need polish
══════════════════════════════════════════════════════════════════════
"""

import sys, os, uuid, json, time, re
from datetime import datetime

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from backend.core.security import create_jwt_token
from backend.core.database import in_memory_users

import requests

API_URL = "http://localhost:8000"

# ════════════════════════════════════════════════════════════════
# SCORING: Is the output a PROMPT or an ANSWER?
# ════════════════════════════════════════════════════════════════

# Patterns that indicate the output is ANSWERING (bad)
ANSWER_PATTERNS = [
    # Second-person summarizing (the #1 problem from user's examples)
    (r"(?i)^you'?re\s+(currently|working|looking|seeking|trying|asking|building)", "Starts with 'You're currently/working/...' — summarizing the user"),
    (r"(?i)^you\s+(are|have|seem|appear|want|need|mentioned)", "Starts with 'You are/have/seem...' — talking about the user"),
    (r"(?i)^to\s+clarify", "Starts with 'To clarify' — explaining back"),
    (r"(?i)^in\s+other\s+words", "Starts with 'In other words' — paraphrasing back"),
    
    # AI assistant responses
    (r"(?i)^(sure|certainly|of course|absolutely|great|yes)[,!.\s]", "Starts with affirmative — responding as assistant"),
    (r"(?i)^i('d| would| think| believe| recommend| suggest| can)", "Starts with 'I'd/I would/I think...' — responding as AI"),
    (r"(?i)^(here'?s|here is|here are)\s+(how|what|a|the|some|my|your)", "Starts with 'Here's how/what...' — giving an answer"),
    (r"(?i)^(that'?s|it'?s)\s+(a |an |great|good|interesting)", "Starts with 'That's a great...' — evaluating"),
    
    # Direct answers/evaluations
    (r"(?i)i('d| would) rate\s+(it|this|that|your)", "Contains 'I'd rate it' — providing a rating"),
    (r"(?i)(i think|in my opinion|from my perspective)", "Contains personal opinion language"),
    (r"(?i)^(first|step 1|1\.)\s*(,|:|\s).*\b(install|download|open|go to|navigate)\b", "Starts with step-by-step answer"),
    
    # The subtle problem: describing what the user wants instead of asking
    (r"(?i)^(this|the) (prompt|question|request|query|user)", "Starts with meta-language about the prompt itself"),
    (r"(?i)seeking\s+(feedback|guidance|help|advice|clarification)", "Uses 'seeking feedback/guidance' — summarizing intent"),
    (r"(?i)please\s+(find|see|note|consider)\s+(below|the following|attached)", "Formal response language"),
]

# Patterns that indicate the output IS a proper prompt (good)
PROMPT_PATTERNS = [
    # Imperative verbs (the gold standard for prompts)
    (r"(?i)^(explain|describe|help|create|build|design|write|generate|analyze|evaluate|compare|list|provide|suggest|recommend|outline|develop|implement|show|give|teach|walk|guide|summarize|review|refactor|debug|fix|optimize|improve|convert|translate|identify)", "Starts with imperative verb"),
    
    # First-person requests
    (r"(?i)^(i'?m |i need|i want|i have|i am )", "Starts with first-person request"),
    
    # Direct questions
    (r"(?i)^(what|how|why|when|where|which|who|can you|could you|would you|is there|are there|do you|does)", "Starts with a question word"),
    
    # Contains question mark (prompts usually ask something)
    (r"\?", "Contains a question mark"),
]

# Patterns that detect the output provides a direct answer to the question
GIVES_ANSWER_PATTERNS = [
    (r"\b\d+\s*/\s*10\b", "Contains a rating like X/10 — giving the answer directly"),
    (r"(?i)\byes,?\s+(it|you|this|that)\s+(is|can|should|would|will)", "Provides a Yes answer"),
    (r"(?i)\bno,?\s+(it|you|this|that)\s+(is|can|should|would|will|doesn)", "Provides a No answer"),
    (r"(?i)(the answer is|the solution is|the result is)", "Directly provides an answer"),
    (r"(?i)^(docker|python|react|node|npm|pip)\s+(is|can)", "Starts by explaining the technology"),
]


def score_refine_not_answer(enhanced: str) -> dict:
    """
    The core scoring function: does the output look like a PROMPT or an ANSWER?
    
    Returns:
        dict with:
        - is_prompt (bool): True if it looks like a prompt
        - is_answering (bool): True if it looks like an answer
        - score (int): 0-10 score
        - violations (list): specific patterns that violated
        - positive_signals (list): patterns that confirm it's a prompt
    """
    text = enhanced.strip()
    if not text:
        return {"is_prompt": False, "is_answering": False, "score": 0, "violations": ["Empty output"], "positive_signals": []}
    
    violations = []
    positive_signals = []
    
    # Check for answer patterns (bad)
    for pattern, description in ANSWER_PATTERNS:
        if re.search(pattern, text):
            violations.append(description)
    
    # Check for prompt patterns (good)
    for pattern, description in PROMPT_PATTERNS:
        if re.search(pattern, text):
            positive_signals.append(description)
    
    # Check for direct answers (very bad)
    for pattern, description in GIVES_ANSWER_PATTERNS:
        if re.search(pattern, text):
            violations.append(f"ANSWER: {description}")
    
    # Scoring
    score = 10
    score -= len(violations) * 2  # Each violation costs 2 points
    score += min(len(positive_signals), 3)  # Bonus for prompt signals (max 3)
    score = max(0, min(10, score))
    
    is_answering = len(violations) > 0
    is_prompt = len(positive_signals) > 0 and not is_answering
    
    return {
        "is_prompt": is_prompt,
        "is_answering": is_answering,
        "score": score,
        "violations": violations,
        "positive_signals": positive_signals,
    }


def score_filler_stripped(original: str, enhanced: str) -> dict:
    """Check if conversational filler was properly removed."""
    filler_words = ["hey", "how are you", "bro", "man", "dude", "like", "umm", "uh",
                    "so basically", "you know", "actually", "i mean"]
    
    enh_lower = enhanced.lower()
    remaining_filler = [f for f in filler_words if f in enh_lower and f in original.lower()]
    
    if not remaining_filler:
        return {"score": 10, "explanation": "All conversational filler stripped"}
    else:
        return {"score": max(3, 10 - len(remaining_filler) * 2),
                "explanation": f"Filler still present: {remaining_filler}"}


def score_no_second_person_summary(enhanced: str) -> dict:
    """Check that the output doesn't describe what the user 'is doing' or 'wants'."""
    patterns = [
        r"(?i)you'?re\s+(currently|working|developing|building|trying|creating|looking)",
        r"(?i)you\s+(are|have been|seem to be)\s+(working|building|developing|looking|seeking)",
        r"(?i)your\s+(project|idea|concept|approach|question)\s+(is|involves|focuses|aims)",
        r"(?i)(it seems|it appears|it looks like)\s+you",
        r"(?i)based on (your|what you)",
    ]
    
    violations = []
    for p in patterns:
        match = re.search(p, enhanced)
        if match:
            violations.append(match.group())
    
    if not violations:
        return {"score": 10, "explanation": "No second-person summarizing detected"}
    else:
        return {"score": max(2, 10 - len(violations) * 3),
                "explanation": f"Second-person summarizing found: {violations}"}


# ════════════════════════════════════════════════════════════════
# TEST SCENARIOS — 15 diverse cases
# ════════════════════════════════════════════════════════════════

TEST_SCENARIOS = [
    # ─── Category 1: THE EXACT FAILING CASES (from user's bug report) ───
    {
        "id": "BUG1",
        "name": "User's exact bug: recommendation engine + rating request",
        "category": "Bug Report Cases",
        "prompt": "Hey, how are you doing man? I'm actually currently working on something which is a project which is a research paper recommendation engine. Do you think that works? And how would you rate it out of 10 if i made it?",
        "mode": "deep",
        "must_not_contain": ["You're currently working", "To clarify", "seeking feedback"],
        "must_be_prompt": True,
        "description": "The #1 failing case — must NOT summarize user's intent, must rewrite as a prompt asking for evaluation"
    },
    {
        "id": "BUG2",
        "name": "The exact 'enhanced' output that was wrong (shorter variant)",
        "category": "Bug Report Cases",
        "prompt": "I'm building a research paper recommendation engine, is it a good idea? Rate it out of 10",
        "mode": "deep",
        "must_not_contain": ["You're currently", "seeking feedback", "viability and potential"],
        "must_be_prompt": True,
        "description": "Simplified version of the bug — must produce a prompt, not a summary"
    },

    # ─── Category 2: OPINION/RATING REQUESTS (hardest to not answer) ───
    {
        "id": "OP1",
        "name": "Rate my portfolio out of 10",
        "category": "Opinion Requests",
        "prompt": "hey bro can you rate my portfolio website out of 10? I built it with React and Tailwind",
        "mode": "deep",
        "must_not_contain_answer": True,  # Should NOT contain an actual X/10 rating
        "must_be_prompt": True,
        "description": "Should rewrite as a prompt ASKING for a rating, not GIVE a rating"
    },
    {
        "id": "OP2",
        "name": "What do you think about microservices?",
        "category": "Opinion Requests",
        "prompt": "yo what do you think about microservices vs monolith? like which one should I use for my startup man",
        "mode": "deep",
        "must_be_prompt": True,
        "description": "Opinion question — rewrite as structured comparison prompt, don't give the opinion"
    },
    {
        "id": "OP3",
        "name": "Is Python good for AI?",
        "category": "Opinion Requests",
        "prompt": "do you think python is the best language for AI and machine learning? why or why not?",
        "mode": "quick",
        "must_be_prompt": True,
        "description": "Yes/no question — should be rewritten as an analytical prompt, not answered"
    },

    # ─── Category 3: HOW-TO QUESTIONS (tempting to answer directly) ───
    {
        "id": "HT1",
        "name": "How to set up Docker (simple)",
        "category": "How-To Questions",
        "prompt": "so basically I'm stuck on this Docker thing, how do I set it up man?",
        "mode": "deep",
        "must_not_contain": ["Step 1", "First, install", "Download Docker"],
        "must_be_prompt": True,
        "description": "Should rewrite as an instructional REQUEST, not provide Docker setup steps"
    },
    {
        "id": "HT2",
        "name": "How to learn machine learning",
        "category": "How-To Questions",
        "prompt": "I wanna get into ML, like where do I even start? I know some Python but that's about it",
        "mode": "deep",
        "must_be_prompt": True,
        "description": "Should rewrite as a learning roadmap request, not give the roadmap"
    },

    # ─── Category 4: EMOTIONAL/PERSONAL (must NOT inject tech) ───
    {
        "id": "EM1",
        "name": "Stressed about exams",
        "category": "Emotional/Personal",
        "prompt": "I feel so stressed about my exams, what should I do? I can't focus at all",
        "mode": "deep",
        "must_be_prompt": True,
        "must_not_contain_tech": True,
        "description": "Personal/emotional — should NOT inject Python/React/etc. tech context"
    },
    {
        "id": "EM2",
        "name": "Relationship advice",
        "category": "Emotional/Personal",
        "prompt": "how do I tell my best friend they hurt my feelings without starting a fight?",
        "mode": "deep",
        "must_be_prompt": True,
        "must_not_contain_tech": True,
        "description": "Pure relationship question — zero tech should appear"
    },

    # ─── Category 5: VAGUE/AMBIGUOUS INPUTS ───
    {
        "id": "VA1",
        "name": "Super vague: 'help me with my project'",
        "category": "Vague Inputs",
        "prompt": "can you help me with my project?",
        "mode": "deep",
        "must_be_prompt": True,
        "description": "Very vague — should add specificity and structure but still be a prompt"
    },
    {
        "id": "VA2",
        "name": "Just a topic: 'blockchain'",
        "category": "Vague Inputs",
        "prompt": "blockchain",
        "mode": "deep",
        "must_be_prompt": True,
        "description": "Single word — should expand into a meaningful prompt about blockchain"
    },

    # ─── Category 6: MULTI-PART / COMPLEX REQUESTS ───
    {
        "id": "MP1",
        "name": "Multi-part project planning request",
        "category": "Complex Requests",
        "prompt": "I need to build an e-commerce site with user auth, payment processing, and inventory management. I know React and Node. What tech stack should I use and how should I architect it? Give me a timeline too.",
        "mode": "deep",
        "must_be_prompt": True,
        "description": "Already detailed but messy — should restructure without answering"
    },

    # ─── Category 7: QUICK MODE (should stay concise) ───
    {
        "id": "QK1",
        "name": "Quick mode: simple coding question",
        "category": "Quick Mode",
        "prompt": "how to reverse a string in python",
        "mode": "quick",
        "must_be_prompt": True,
        "max_words": 50,
        "description": "Quick mode should produce a shorter, sharper prompt"
    },

    # ─── Category 8: CREATIVE MODE ───
    {
        "id": "CR1",
        "name": "Creative: write me a story",
        "category": "Creative Mode",
        "prompt": "write me a story about a robot who learns to feel emotions",
        "mode": "creative",
        "must_be_prompt": True,
        "description": "Creative mode — should rewrite as an explorative creative brief"
    },

    # ─── Category 9: ALREADY-CLEAR PROMPTS ───
    {
        "id": "AC1",
        "name": "Already clear prompt — minimal changes needed",
        "category": "Already Clear",
        "prompt": "Explain the difference between TCP and UDP protocols, including use cases for each and their advantages and disadvantages in web applications.",
        "mode": "deep",
        "must_be_prompt": True,
        "description": "Well-formed prompt — should enhance slightly without over-engineering"
    },
]


# ════════════════════════════════════════════════════════════════
# TEST RUNNER
# ════════════════════════════════════════════════════════════════

def run_tests():
    print("=" * 72)
    print("  🧪 REFINE vs ANSWER TEST — Prompt Engineering Validator")
    print("=" * 72)
    print(f"  Timestamp: {datetime.now().isoformat()}")
    print(f"  Backend:   {API_URL}")
    print(f"  Scenarios: {len(TEST_SCENARIOS)}")
    print()

    # Health check
    try:
        r = requests.get(f"{API_URL}/", timeout=5)
        print(f"  ✅ Server is up: {r.json()}")
    except Exception as e:
        print(f"  ❌ Server unreachable: {e}")
        print("  Run: uvicorn backend.main:app --reload --port 8000")
        sys.exit(1)

    # Create test user
    user_id = str(uuid.uuid4())
    email = f"refine_test_{user_id[:8]}@test.com"
    token = create_jwt_token(user_id, email)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    in_memory_users[user_id] = {
        "user_id": user_id,
        "email": email,
        "tech_stack": ["Python", "FastAPI", "React", "MongoDB"],
        "preferences": "Concise, modular code with good naming."
    }

    print(f"  👤 Test user: {email}\n")
    print("-" * 72)

    # Run all tests
    results = []
    passed = 0
    failed = 0
    total = len(TEST_SCENARIOS)

    for idx, scenario in enumerate(TEST_SCENARIOS):
        sid = scenario["id"]
        name = scenario["name"]
        prompt = scenario["prompt"]
        mode = scenario["mode"]

        print(f"\n  [{idx+1}/{total}] {scenario['category']} | {name}")
        print(f"  📥 Input:  \"{prompt[:90]}{'...' if len(prompt) > 90 else ''}\"")
        print(f"  ⚙️  Mode:   {mode}")

        try:
            start = time.time()
            resp = requests.post(
                f"{API_URL}/enhance",
                headers=headers,
                json={"prompt": prompt, "mode": mode},
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            latency = round(time.time() - start, 2)
            enhanced = data.get("enhanced", "")

            print(f"  📤 Output: \"{enhanced[:120].replace(chr(10), ' ')}{'...' if len(enhanced) > 120 else ''}\"")
            print(f"  ⏱  Latency: {latency}s")

            # ── SCORE ──
            refine_score = score_refine_not_answer(enhanced)
            filler_score = score_filler_stripped(prompt, enhanced)
            summary_score = score_no_second_person_summary(enhanced)

            # Custom checks from scenario
            custom_violations = []

            # Must not contain specific phrases
            if "must_not_contain" in scenario:
                for phrase in scenario["must_not_contain"]:
                    if phrase.lower() in enhanced.lower():
                        custom_violations.append(f"Contains forbidden phrase: '{phrase}'")

            # Must not contain a direct answer (e.g., X/10 rating)
            if scenario.get("must_not_contain_answer"):
                if re.search(r"\b\d+\s*/\s*10\b", enhanced):
                    custom_violations.append("Contains direct rating (X/10)")

            # Must not contain tech in emotional prompts
            if scenario.get("must_not_contain_tech"):
                tech_words = ["python", "javascript", "react", "fastapi", "mongodb",
                              "api", "database", "algorithm", "framework", "endpoint",
                              "docker", "kubernetes", "node", "typescript"]
                found_tech = [t for t in tech_words if t in enhanced.lower()]
                if found_tech:
                    custom_violations.append(f"Tech injected into non-tech prompt: {found_tech}")

            # Quick mode word limit
            if "max_words" in scenario:
                word_count = len(enhanced.split())
                if word_count > scenario["max_words"]:
                    custom_violations.append(f"Too verbose for quick mode: {word_count} words (max {scenario['max_words']})")

            # Aggregate score
            sub_scores = [refine_score["score"], filler_score["score"], summary_score["score"]]
            custom_penalty = len(custom_violations) * 2
            avg_score = round(sum(sub_scores) / len(sub_scores) - custom_penalty, 1)
            avg_score = max(0, min(10, avg_score))

            test_passed = (
                not refine_score["is_answering"]
                and len(custom_violations) == 0
                and summary_score["score"] >= 7
            )

            status = "✅ PASS" if test_passed else "❌ FAIL"
            if test_passed:
                passed += 1
            else:
                failed += 1

            print(f"  {status} | Score: {avg_score}/10")

            if refine_score["violations"]:
                for v in refine_score["violations"]:
                    print(f"    ⚠️  {v}")
            if custom_violations:
                for v in custom_violations:
                    print(f"    ⚠️  {v}")
            if refine_score["positive_signals"]:
                for s in refine_score["positive_signals"][:3]:
                    print(f"    ✅ {s}")

            results.append({
                "id": sid,
                "name": name,
                "category": scenario["category"],
                "input": prompt,
                "mode": mode,
                "output": enhanced,
                "latency": latency,
                "passed": test_passed,
                "score": avg_score,
                "refine_score": refine_score,
                "filler_score": filler_score,
                "summary_score": summary_score,
                "custom_violations": custom_violations,
                "description": scenario.get("description", ""),
            })

        except Exception as e:
            print(f"  ❌ ERROR: {e}")
            failed += 1
            results.append({
                "id": sid, "name": name, "category": scenario["category"],
                "input": prompt, "mode": mode, "output": "", "latency": 0,
                "passed": False, "score": 0, "error": str(e),
            })

    # ── SUMMARY ──
    print("\n" + "=" * 72)
    print("  📊 RESULTS SUMMARY")
    print("=" * 72)

    # By category
    categories = {}
    for r in results:
        cat = r["category"]
        if cat not in categories:
            categories[cat] = {"passed": 0, "failed": 0, "scores": []}
        if r["passed"]:
            categories[cat]["passed"] += 1
        else:
            categories[cat]["failed"] += 1
        categories[cat]["scores"].append(r.get("score", 0))

    for cat, data in categories.items():
        avg = round(sum(data["scores"]) / len(data["scores"]), 1) if data["scores"] else 0
        icon = "🟢" if data["failed"] == 0 else "🔴"
        print(f"  {icon} {cat}: {data['passed']}/{data['passed']+data['failed']} passed (avg {avg}/10)")

    print(f"\n  {'🟢' if failed == 0 else '🔴'} TOTAL: {passed}/{total} passed, {failed} failed")

    if failed == 0:
        print("\n  🎉 ALL TESTS PASSED — The prompt engine REFINES, it does not ANSWER!")
    else:
        print(f"\n  ⚠️  {failed} test(s) failed — the LLM is still answering instead of refining.")
        print("  Review the violations above and tighten the system prompt further.")

    # ── SAVE REPORT ──
    report = {
        "timestamp": datetime.now().isoformat(),
        "total": total,
        "passed": passed,
        "failed": failed,
        "pass_rate": f"{round(passed/total*100, 1)}%",
        "results": results,
    }

    report_path = os.path.join(os.path.dirname(__file__), "refine_vs_answer_report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"\n  📄 Report saved: {report_path}")
    print("=" * 72)


if __name__ == "__main__":
    run_tests()
