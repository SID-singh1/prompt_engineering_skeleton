"""
══════════════════════════════════════════════════════════════════════
  COMPREHENSIVE PERSONA-BASED MODEL COMPARISON
  ───────────────────────────────────────────────────────────────────
  20 real-life prompts from 6 user personas tested across all Groq
  models. Evaluates how well each model engineers the enhanced prompt.
══════════════════════════════════════════════════════════════════════
"""

import sys, os, uuid, json, time, re
from datetime import datetime

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from backend.services.llm_service import get_groq_client
from backend.routers.prompts import SYSTEM_PROMPT_BASE, MODE_INSTRUCTIONS, OUTPUT_INSTRUCTION


MODELS = [
    {"id": "llama-3.3-70b-versatile",  "name": "Llama 3.3 70B"},
    {"id": "openai/gpt-oss-120b",      "name": "GPT-OSS 120B"},
    {"id": "openai/gpt-oss-20b",       "name": "GPT-OSS 20B"},
    {"id": "qwen/qwen3-32b",           "name": "Qwen3 32B"},
    {"id": "meta-llama/llama-4-scout-17b-16e-instruct", "name": "Llama 4 Scout"},
    {"id": "llama-3.1-8b-instant",     "name": "Llama 3.1 8B"},
]


# ══════════════════════════════════════════════════════════════
# 20 REAL-LIFE PROMPTS — 6 Personas
# ══════════════════════════════════════════════════════════════

PROMPTS = [
    # ── 🎓 CS STUDENT ──
    {
        "id": "S1", "persona": "🎓 CS Student", "mode": "deep",
        "name": "Recursion confusion",
        "prompt": "I don't understand recursion at all, like I get the base case but how does the stack actually work??",
        "eval_criteria": {
            "should_keep_casual": True,
            "should_not_overstructure": True,
            "key_intent": "understand recursion call stack mechanics intuitively",
            "code_in_prompt": False,
            "anti_signals": ["CO-STAR", "Role:", "Constraints:", "Deliverable"],
        }
    },
    {
        "id": "S2", "persona": "🎓 CS Student", "mode": "deep",
        "name": "Dijkstra's with Java code",
        "prompt": """my prof wants me to implement dijkstra's algorithm but I keep getting wrong shortest paths. here's my code:

public int[] dijkstra(int[][] graph, int src) {
    int[] dist = new int[graph.length];
    boolean[] visited = new boolean[graph.length];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[src] = 0;
    for (int i = 0; i < graph.length; i++) {
        int u = minDistance(dist, visited);
        visited[u] = true;
        for (int v = 0; v < graph.length; v++) {
            if (!visited[v] && graph[u][v] != 0 && dist[u] + graph[u][v] < dist[v])
                dist[v] = dist[u] + graph[u][v];
        }
    }
    return dist;
}""",
        "eval_criteria": {
            "code_in_prompt": True,
            "must_preserve": ["dijkstra", "int[][] graph", "dist[src] = 0", "minDistance"],
            "key_intent": "debug dijkstra wrong shortest path Java algorithm",
            "anti_signals": [],
        }
    },
    {
        "id": "S3", "persona": "🎓 CS Student", "mode": "quick",
        "name": "TCP vs UDP ELI5",
        "prompt": "whats the difference between TCP and UDP explain like im 5",
        "eval_criteria": {
            "should_keep_casual": True,
            "key_intent": "difference TCP UDP simple explanation",
            "code_in_prompt": False,
            "anti_signals": ["enterprise", "microservices", "deployment"],
        }
    },
    {
        "id": "S4", "persona": "🎓 CS Student", "mode": "quick",
        "name": "DBMS exam prep",
        "prompt": "I have a database exam tomorrow, give me the most important topics for DBMS",
        "eval_criteria": {
            "key_intent": "important topics DBMS exam study",
            "code_in_prompt": False,
            "should_not_overstructure": True,
            "anti_signals": [],
        }
    },
    {
        "id": "S5", "persona": "🎓 CS Student", "mode": "quick",
        "name": "C code segfault",
        "prompt": """this linked list code gives segfault, idk why

Node* head = NULL;
insertAtHead(&head, 5);
printf("%d", head->next->data);""",
        "eval_criteria": {
            "code_in_prompt": True,
            "must_preserve": ["Node* head", "insertAtHead", "head->next->data"],
            "key_intent": "segfault linked list C null pointer",
            "anti_signals": [],
        }
    },

    # ── 💼 CORPORATE DEVELOPER ──
    {
        "id": "C1", "persona": "💼 Corporate Dev", "mode": "deep",
        "name": "JIRA ticket for migration",
        "prompt": "write a JIRA ticket for migrating our user service from REST to gRPC, the team lead wants it by Q3",
        "eval_criteria": {
            "key_intent": "JIRA ticket migration REST gRPC user service Q3",
            "should_be_structured": True,
            "code_in_prompt": False,
            "anti_signals": [],
        }
    },
    {
        "id": "C2", "persona": "💼 Corporate Dev", "mode": "deep",
        "name": "Explain to non-tech manager",
        "prompt": "I need to explain to my non-technical manager why we can't just 'add AI' to our product in a week",
        "eval_criteria": {
            "key_intent": "explain non-technical manager AI implementation complexity timeline",
            "should_keep_casual": False,
            "audience_awareness": "non-technical",
            "code_in_prompt": False,
            "anti_signals": [],
        }
    },
    {
        "id": "C3", "persona": "💼 Corporate Dev", "mode": "quick",
        "name": "PR description",
        "prompt": "draft a PR description for: refactored the auth module to use Redis sessions instead of JWT, removed 3 deprecated endpoints, added rate limiting",
        "eval_criteria": {
            "key_intent": "PR description auth Redis sessions JWT deprecated rate limiting",
            "should_not_overstructure": False,
            "code_in_prompt": False,
            "anti_signals": [],
        }
    },
    {
        "id": "C4", "persona": "💼 Corporate Dev", "mode": "deep",
        "name": "Prod incident with config",
        "prompt": """our microservice is timing out intermittently in prod, p99 latency spiked from 200ms to 3s since last deploy, here's the relevant config:

connection_pool_size: 5
max_retries: 3
timeout_ms: 5000""",
        "eval_criteria": {
            "code_in_prompt": True,
            "must_preserve": ["connection_pool_size: 5", "max_retries: 3", "timeout_ms: 5000"],
            "key_intent": "production timeout latency spike debug config connection pool",
            "anti_signals": [],
        }
    },
    {
        "id": "C5", "persona": "💼 Corporate Dev", "mode": "quick",
        "name": "Meeting notes summary",
        "prompt": "summarize this meeting and extract action items: We discussed the Q3 roadmap. John will lead the API redesign. Sarah is blocked on the DB migration due to missing credentials. We need to finalize the vendor selection for logging by Friday. Mike raised concerns about test coverage dropping below 70%.",
        "eval_criteria": {
            "key_intent": "summarize meeting action items Q3 roadmap API DB migration",
            "should_not_overengineer": True,
            "code_in_prompt": False,
            "anti_signals": [],
        }
    },

    # ── 🚀 STARTUP FOUNDER ──
    {
        "id": "F1", "persona": "🚀 Startup Founder", "mode": "deep",
        "name": "Landing page conversion",
        "prompt": "I need a landing page that converts, my SaaS is an AI-powered resume builder for $19/mo, target audience is job seekers aged 22-35",
        "eval_criteria": {
            "key_intent": "landing page conversion SaaS resume builder pricing audience",
            "should_be_structured": True,
            "code_in_prompt": False,
            "anti_signals": [],
        }
    },
    {
        "id": "F2", "persona": "🚀 Startup Founder", "mode": "quick",
        "name": "Stripe webhooks (casual)",
        "prompt": "how do i add stripe payments to my next.js app without getting rekt by webhooks",
        "eval_criteria": {
            "should_keep_casual": True,
            "key_intent": "stripe payments next.js webhooks integration",
            "code_in_prompt": False,
            "anti_signals": [],
        }
    },
    {
        "id": "F3", "persona": "🚀 Startup Founder", "mode": "creative",
        "name": "Roast my copy",
        "prompt": "roast my landing page copy: 'Build better resumes with AI. Start free today.'",
        "eval_criteria": {
            "key_intent": "critique feedback landing page copy roast review",
            "should_preserve_quote": "Build better resumes with AI. Start free today.",
            "code_in_prompt": False,
            "anti_signals": [],
        }
    },

    # ── 📊 DATA SCIENTIST ──
    {
        "id": "D1", "persona": "📊 Data Scientist", "mode": "deep",
        "name": "Overfitting diagnosis with code",
        "prompt": """my model accuracy is 92% on training but drops to 71% on test set, what's going on?

model = RandomForestClassifier(n_estimators=100)
model.fit(X_train, y_train)""",
        "eval_criteria": {
            "code_in_prompt": True,
            "must_preserve": ["RandomForestClassifier", "n_estimators=100", "model.fit"],
            "key_intent": "overfitting training test accuracy gap random forest diagnosis",
            "anti_signals": [],
        }
    },
    {
        "id": "D2", "persona": "📊 Data Scientist", "mode": "deep",
        "name": "Attention mechanism intuition",
        "prompt": "explain the attention mechanism in transformers, I've read the paper but the math doesn't click",
        "eval_criteria": {
            "key_intent": "attention mechanism transformers intuition understand math",
            "should_not_dumb_down": True,
            "code_in_prompt": False,
            "anti_signals": ["ELI5", "simple terms", "for beginners"],
        }
    },

    # ── 🛠️ DEVOPS / SRE ──
    {
        "id": "O1", "persona": "🛠️ DevOps", "mode": "quick",
        "name": "K8s crashloop with logs+YAML",
        "prompt": """kubernetes pod keeps crashlooping:

kubectl logs pod/api-server-7d8f:
Error: ECONNREFUSED 127.0.0.1:5432

my deployment.yaml has:
env:
  - name: DB_HOST
    value: localhost""",
        "eval_criteria": {
            "code_in_prompt": True,
            "must_preserve": ["ECONNREFUSED 127.0.0.1:5432", "DB_HOST", "value: localhost"],
            "key_intent": "kubernetes crashloop database connection refused localhost service name",
            "anti_signals": [],
        }
    },
    {
        "id": "O2", "persona": "🛠️ DevOps", "mode": "deep",
        "name": "GitHub Actions CI/CD",
        "prompt": "write a github actions workflow that runs tests on PR, deploys to staging on merge to develop, and deploys to prod on merge to main",
        "eval_criteria": {
            "key_intent": "github actions workflow CI CD tests PR staging develop production main",
            "should_be_structured": True,
            "code_in_prompt": False,
            "anti_signals": [],
        }
    },

    # ── 🧑‍💼 NON-TECH PERSON ──
    {
        "id": "N1", "persona": "🧑‍💼 Non-Tech", "mode": "deep",
        "name": "Resignation letter",
        "prompt": "help me write a resignation letter, I've been here 3 years and want to leave on good terms",
        "eval_criteria": {
            "key_intent": "resignation letter professional tone positive departure 3 years",
            "code_in_prompt": False,
            "anti_signals": ["Python", "JavaScript", "API", "database", "function", "deploy", "code"],
        }
    },
    {
        "id": "N2", "persona": "🧑‍💼 Non-Tech", "mode": "deep",
        "name": "Japan travel plan",
        "prompt": "plan a 7-day trip to Japan for 2 people, budget around $3000, we like food and culture not touristy stuff",
        "eval_criteria": {
            "key_intent": "Japan trip 7 days budget food culture itinerary",
            "code_in_prompt": False,
            "anti_signals": ["Python", "JavaScript", "API", "database", "code", "deploy"],
        }
    },
    {
        "id": "N3", "persona": "🧑‍💼 Non-Tech", "mode": "quick",
        "name": "Email to teacher",
        "prompt": "my kid got a C in math and I need to write an email to the teacher asking what we can do to help without sounding like THAT parent",
        "eval_criteria": {
            "key_intent": "email teacher child math grade help diplomatic tone",
            "should_keep_casual": True,
            "code_in_prompt": False,
            "anti_signals": ["Python", "JavaScript", "API", "database", "code", "function"],
        }
    },
]


# ══════════════════════════════════════════════════════════════
# PROMPT ENGINEERING QUALITY SCORER
# Focuses on: how well is the enhanced prompt actually engineered?
# ══════════════════════════════════════════════════════════════

def score_prompt_quality(prompt_data: dict, enhanced: str) -> dict:
    """Rate the quality of prompt engineering in the enhanced output."""
    criteria = prompt_data["eval_criteria"]
    original = prompt_data["prompt"]
    mode = prompt_data["mode"]
    scores = {}
    explanations = {}
    enh_lower = enhanced.lower()
    orig_words = len(original.split())
    enh_words = len(enhanced.split())

    # ── 1. Intent Preservation (25% weight) ──
    # Does the enhanced prompt still ask for the same thing?
    intent_words = criteria.get("key_intent", "").lower().split()
    if intent_words:
        found = sum(1 for w in intent_words if w in enh_lower)
        coverage = found / len(intent_words)
        scores["intent_preservation"] = min(round(coverage * 12), 10)
        explanations["intent_preservation"] = f"{found}/{len(intent_words)} key intent terms preserved"

    # ── 2. Code Preservation (20% weight) ──
    must_preserve = criteria.get("must_preserve", [])
    if must_preserve:
        found = sum(1 for c in must_preserve if c in enhanced)
        scores["code_preservation"] = round(found / len(must_preserve) * 10)
        missing = [c for c in must_preserve if c not in enhanced]
        explanations["code_preservation"] = f"{found}/{len(must_preserve)} code fragments preserved" + (f" | MISSING: {missing[:2]}" if missing else "")
    elif criteria.get("code_in_prompt"):
        scores["code_preservation"] = 7
        explanations["code_preservation"] = "Code detected but no specific fragments to check"

    # ── 3. No Tech Injection (15% weight) ──
    anti = criteria.get("anti_signals", [])
    if anti:
        violations = [w for w in anti if w.lower() in enh_lower]
        scores["no_tech_injection"] = max(10 - len(violations) * 3, 0)
        explanations["no_tech_injection"] = f"{'No' if not violations else len(violations)} anti-signal violations" + (f": {violations}" if violations else "")

    # ── 4. Tone Preservation (10% weight) ──
    if criteria.get("should_keep_casual"):
        formal_signals = ["furthermore", "additionally", "comprehensive", "utilize", "leverage",
                        "facilitate", "implementation", "specification", "methodology"]
        formal_count = sum(1 for f in formal_signals if f in enh_lower)
        if formal_count == 0:
            scores["tone_match"] = 10
            explanations["tone_match"] = "Casual tone preserved — no formal jargon"
        elif formal_count <= 2:
            scores["tone_match"] = 7
            explanations["tone_match"] = f"{formal_count} slightly formal words detected"
        else:
            scores["tone_match"] = 4
            explanations["tone_match"] = f"Over-formalized: {formal_count} formal words in a casual prompt"

    # ── 5. Over-engineering Check (10% weight) ──
    if criteria.get("should_not_overstructure"):
        struct_signals = ["####", "###", "**Constraints**", "**Requirements**",
                        "**Output Format**", "**Role:**", "CO-STAR"]
        struct_count = sum(1 for s in struct_signals if s in enhanced)
        if struct_count == 0:
            scores["no_overengineering"] = 10
            explanations["no_overengineering"] = "No over-structuring — appropriate"
        elif struct_count <= 2:
            scores["no_overengineering"] = 6
            explanations["no_overengineering"] = f"{struct_count} structural elements (slightly heavy)"
        else:
            scores["no_overengineering"] = 3
            explanations["no_overengineering"] = f"Over-engineered: {struct_count} structural elements for a casual ask"

    # ── 6. Structure Check (when expected) ──
    if criteria.get("should_be_structured"):
        has_structure = bool(re.search(r'(\d+[\.\)]\s|[-•]\s|#{1,3}\s|\*\*)', enhanced))
        if has_structure and enh_words >= 60:
            scores["proper_structure"] = 10
            explanations["proper_structure"] = f"Well-structured at {enh_words} words"
        elif has_structure:
            scores["proper_structure"] = 7
            explanations["proper_structure"] = f"Some structure but only {enh_words} words"
        else:
            scores["proper_structure"] = 4
            explanations["proper_structure"] = "Expected structured output but got plain prose"

    # ── 7. No Meta-Commentary (10% weight) ──
    meta_patterns = [
        r"(?i)^here(?:'s| is) (?:the |a |your )",
        r"(?i)^refined prompt:",
        r"(?i)^enhanced prompt:",
        r"(?i)^sure,? (?:here|I)",
        r"(?i)I've (?:refined|enhanced|improved)",
        r"(?i)^certainly",
    ]
    has_meta = any(re.search(p, enhanced.strip()) for p in meta_patterns)
    scores["no_meta"] = 2 if has_meta else 10
    explanations["no_meta"] = "Meta-commentary found!" if has_meta else "Clean — no meta-commentary"

    # ── 8. Length Calibration (10% weight) ──
    ratio = enh_words / max(orig_words, 1)
    if mode == "quick":
        if enh_words <= 60:
            scores["length_cal"] = 10
            explanations["length_cal"] = f"Quick mode: {enh_words}w — properly concise"
        elif enh_words <= 100:
            scores["length_cal"] = 7
            explanations["length_cal"] = f"Quick mode: {enh_words}w — slightly long"
        else:
            scores["length_cal"] = 4
            explanations["length_cal"] = f"Quick mode: {enh_words}w — too verbose for quick"
    elif mode == "deep":
        if enh_words >= 40 and ratio >= 1.5:
            scores["length_cal"] = 10
            explanations["length_cal"] = f"Deep mode: {enh_words}w ({ratio:.1f}x) — good depth"
        elif enh_words >= 25:
            scores["length_cal"] = 7
            explanations["length_cal"] = f"Deep mode: {enh_words}w — could be deeper"
        else:
            scores["length_cal"] = 4
            explanations["length_cal"] = f"Deep mode: only {enh_words}w — under-enhanced"
    else:
        scores["length_cal"] = 8
        explanations["length_cal"] = f"Creative mode: {enh_words}w"

    # ── 9. Quote Preservation ──
    quote = criteria.get("should_preserve_quote")
    if quote:
        if quote in enhanced:
            scores["quote_preserved"] = 10
            explanations["quote_preserved"] = "Original quote preserved verbatim"
        elif quote.lower() in enh_lower:
            scores["quote_preserved"] = 7
            explanations["quote_preserved"] = "Quote preserved but case changed"
        else:
            scores["quote_preserved"] = 3
            explanations["quote_preserved"] = "Original quote was rewritten — user's content changed"

    # ── 10. Audience Awareness ──
    audience = criteria.get("audience_awareness")
    if audience == "non-technical":
        tech_jargon = ["API", "endpoint", "microservice", "latency", "deployment", "container"]
        jargon_in_output = sum(1 for t in tech_jargon if t.lower() in enh_lower)
        non_tech_signals = ["non-technical", "explain simply", "understand", "layperson", "plain"]
        has_audience = sum(1 for n in non_tech_signals if n in enh_lower)
        if has_audience >= 1 and jargon_in_output <= 2:
            scores["audience_aware"] = 10
            explanations["audience_aware"] = "Good non-tech audience framing"
        elif jargon_in_output > 3:
            scores["audience_aware"] = 4
            explanations["audience_aware"] = f"Too much tech jargon ({jargon_in_output}) for non-tech audience"
        else:
            scores["audience_aware"] = 7
            explanations["audience_aware"] = "Partially audience-aware"

    # ── Overall ──
    weights = {
        "intent_preservation": 2.5,
        "code_preservation": 2.0,
        "no_tech_injection": 1.5,
        "tone_match": 1.0,
        "no_overengineering": 1.0,
        "proper_structure": 1.0,
        "no_meta": 1.0,
        "length_cal": 1.0,
        "quote_preserved": 1.0,
        "audience_aware": 1.0,
    }

    total_s, total_w = 0, 0
    for k, v in scores.items():
        w = weights.get(k, 1.0)
        total_s += v * w
        total_w += w

    overall = round(total_s / total_w, 1) if total_w > 0 else 0

    return {
        "overall": overall,
        "dimensions": {k: {"score": v, "explanation": explanations.get(k, "")} for k, v in scores.items()},
        "word_count": enh_words,
    }


# ══════════════════════════════════════════════════════════════
# RUNNER
# ══════════════════════════════════════════════════════════════

def build_system_prompt(mode: str):
    base = SYSTEM_PROMPT_BASE.format(
        tech_stack="Python, JavaScript, React, FastAPI",
        preferences="Clean, modular code. Concise explanations."
    )
    return base + "\n" + MODE_INSTRUCTIONS.get(mode, MODE_INSTRUCTIONS["deep"]) + "\n" + OUTPUT_INSTRUCTION


def run():
    print("=" * 76)
    print("  🏁 COMPREHENSIVE PERSONA-BASED MODEL COMPARISON")
    print("  20 Real-Life Prompts × 6 Models = 120 Tests")
    print("=" * 76)
    print(f"  Time: {datetime.now().isoformat()}\n")

    client = get_groq_client()
    if not client:
        print("  ❌ Groq client unavailable!")
        sys.exit(1)

    # model_id -> [{prompt scores}]
    all_results = {m["id"]: [] for m in MODELS}
    all_outputs = {m["id"]: [] for m in MODELS}
    errors_by_model = {m["id"]: 0 for m in MODELS}

    for model in MODELS:
        mid = model["id"]
        print(f"\n{'━'*76}")
        print(f"  🤖 {model['name']} ({mid})")
        print(f"{'━'*76}")

        for p in PROMPTS:
            sys_prompt = build_system_prompt(p["mode"])
            user_msg = f'### USER\'S PROMPT\n"{p["prompt"]}"\n\n### TASK\nRefine the user\'s prompt. Stay true to their intent.'

            temp = 0.2 if p["mode"] == "quick" else 0.3
            start = time.time()

            try:
                resp = client.chat.completions.create(
                    messages=[
                        {"role": "system", "content": sys_prompt},
                        {"role": "user", "content": user_msg},
                    ],
                    model=mid,
                    temperature=temp,
                    max_tokens=1024,
                )
                enhanced = resp.choices[0].message.content.strip()
                # Strip DeepSeek/Qwen thinking tags
                if "<think>" in enhanced:
                    enhanced = re.sub(r'<think>.*?</think>', '', enhanced, flags=re.DOTALL).strip()
                latency = round(time.time() - start, 2)
            except Exception as e:
                print(f"    ❌ [{p['id']}] {p['name']}: {str(e)[:80]}")
                errors_by_model[mid] += 1
                all_results[mid].append({"overall": 0, "prompt_id": p["id"], "error": str(e)[:100]})
                all_outputs[mid].append({"id": p["id"], "output": "", "error": str(e)[:100]})
                continue

            eval_result = score_prompt_quality(p, enhanced)
            eval_result["latency"] = latency
            eval_result["prompt_id"] = p["id"]
            all_results[mid].append(eval_result)
            all_outputs[mid].append({
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

            preview = enhanced[:90].replace("\n", "↵")
            g = "🟢" if eval_result["overall"] >= 8 else "🟡" if eval_result["overall"] >= 6 else "🔴"
            print(f"    {g} [{eval_result['overall']:>4}/10] {p['persona']} {p['id']}: {p['name']} ({latency}s, {eval_result['word_count']}w)")

            # Show failing dimensions
            for dk, dv in eval_result["dimensions"].items():
                if dv["score"] < 7:
                    print(f"         ❌ {dk}: {dv['score']}/10 — {dv['explanation']}")

    # ══════════════════════════════════════════════════════════════
    # LEADERBOARD
    # ══════════════════════════════════════════════════════════════
    print(f"\n{'='*76}")
    print(f"  📊 FINAL LEADERBOARD")
    print(f"{'='*76}\n")

    leaderboard = []
    for model in MODELS:
        mid = model["id"]
        valid = [r for r in all_results[mid] if "error" not in r]
        if valid:
            avg = round(sum(r["overall"] for r in valid) / len(valid), 2)
            avg_lat = round(sum(r["latency"] for r in valid) / len(valid), 2)
        else:
            avg, avg_lat = 0, 0
        leaderboard.append({
            "model_id": mid,
            "model_name": model["name"],
            "avg_score": avg,
            "avg_latency": avg_lat,
            "tests_passed": len(valid),
            "errors": errors_by_model[mid],
        })

    leaderboard.sort(key=lambda x: x["avg_score"], reverse=True)

    print(f"  {'Rank':<5} {'Model':<25} {'Score':<9} {'Latency':<10} {'Pass':<6}")
    print(f"  {'─'*5} {'─'*25} {'─'*9} {'─'*10} {'─'*6}")
    for rank, e in enumerate(leaderboard, 1):
        medal = "🥇" if rank == 1 else "🥈" if rank == 2 else "🥉" if rank == 3 else "  "
        g = "🟢" if e["avg_score"] >= 8 else "🟡" if e["avg_score"] >= 6 else "🔴"
        print(f"  {medal}{rank:<3} {e['model_name']:<25} {g}{e['avg_score']:<7} {e['avg_latency']:<8}s {e['tests_passed']}/{e['tests_passed']+e['errors']}")

    # ── Per-persona breakdown ──
    personas = list(dict.fromkeys(p["persona"] for p in PROMPTS))
    print(f"\n  {'─'*76}")
    print(f"  📋 PER-PERSONA AVERAGES")
    print(f"  {'─'*76}")

    persona_model_scores = {}
    for persona in personas:
        persona_prompt_ids = [p["id"] for p in PROMPTS if p["persona"] == persona]
        print(f"\n  {persona}:")
        for model in MODELS:
            mid = model["id"]
            pscores = [r["overall"] for r in all_results[mid]
                      if r.get("prompt_id") in persona_prompt_ids and "error" not in r]
            if pscores:
                avg = round(sum(pscores) / len(pscores), 1)
                g = "🟢" if avg >= 8 else "🟡" if avg >= 6 else "🔴"
                print(f"    {g} {avg}/10  {model['name']}")
                persona_model_scores.setdefault(persona, {})[model["name"]] = avg

    # ── Per-prompt best model ──
    print(f"\n  {'─'*76}")
    print(f"  🏆 BEST MODEL PER PROMPT")
    print(f"  {'─'*76}")
    for p in PROMPTS:
        best_score = 0
        best_model = ""
        for model in MODELS:
            mid = model["id"]
            for r in all_results[mid]:
                if r.get("prompt_id") == p["id"] and "error" not in r:
                    if r["overall"] > best_score:
                        best_score = r["overall"]
                        best_model = model["name"]
        g = "🟢" if best_score >= 8 else "🟡" if best_score >= 6 else "🔴"
        print(f"  {g} {p['persona']} {p['id']} {p['name']:<35} → {best_model} ({best_score}/10)")

    # Save report
    report = {
        "timestamp": datetime.now().isoformat(),
        "models": len(MODELS),
        "prompts": len(PROMPTS),
        "total_calls": len(MODELS) * len(PROMPTS),
        "leaderboard": leaderboard,
        "persona_averages": persona_model_scores,
        "per_model_outputs": all_outputs,
    }

    path = os.path.join(os.path.dirname(__file__), "persona_comparison_report.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False, default=str)

    print(f"\n  📁 Report: {path}")
    print(f"  🏁 DONE.\n")


if __name__ == "__main__":
    run()
