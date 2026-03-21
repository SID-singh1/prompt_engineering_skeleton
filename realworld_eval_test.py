"""
══════════════════════════════════════════════════════════════════════════
  REAL-WORLD SCENARIO EVALUATION — Prompt Engineering Framework v4.0
  ───────────────────────────────────────────────────────────────────
  Tests what REAL developers actually type while coding and checks:
    1. Code Preservation — does the framework keep code blocks intact?
    2. Over-engineering   — does a simple fix get bloated into an essay?
    3. Under-engineering  — does a vague prompt stay too vague?
    4. Intent Accuracy    — does it understand what the user REALLY wants?
    5. Code Hallucination — does it invent/rewrite code the user pasted?
══════════════════════════════════════════════════════════════════════════
"""

import sys, os, uuid, json, time, re, textwrap, difflib
from datetime import datetime

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from backend.core.security import create_jwt_token
from backend.core.database import in_memory_users, in_memory_saved_prompts

import requests

API_URL = "http://localhost:8000"


# ════════════════════════════════════════════════════════════════
# SCORING ENGINE  — Real-world quality checks
# ════════════════════════════════════════════════════════════════

def extract_code_blocks(text: str) -> list:
    """Extract fenced code blocks (```...```) and inline code from text."""
    fenced = re.findall(r'```[\w]*\n?(.*?)```', text, re.DOTALL)
    # Also grab lines that look like code (indented 4+ spaces, or contain common code patterns)
    code_lines = []
    for line in text.split('\n'):
        stripped = line.strip()
        if any(sig in stripped for sig in [
            'def ', 'class ', 'import ', 'from ', 'return ', 'console.log',
            'const ', 'let ', 'var ', 'function ', '=>', '()', '{}', '[];',
            'app.', 'router.', 'async ', 'await ', 'useEffect', 'useState',
            'SELECT ', 'INSERT ', 'CREATE ', 'DROP ', '@app.', '@router.',
        ]):
            code_lines.append(stripped)
    return fenced, code_lines


def score_code_preservation(original: str, enhanced: str) -> dict:
    """
    Check if code snippets from the original prompt are preserved verbatim
    in the enhanced prompt. Code should NOT be rewritten.
    """
    _, orig_code_lines = extract_code_blocks(original)
    
    if not orig_code_lines:
        return {"score": -1, "explanation": "No code in original prompt — N/A", "preserved": None, "altered": None}
    
    preserved = []
    altered = []
    
    for code_line in orig_code_lines:
        # Normalize whitespace for comparison
        normalized = code_line.strip()
        if normalized in enhanced:
            preserved.append(normalized)
        else:
            # Check for partial matches (code might be wrapped differently)
            # Use fuzzy matching
            close = difflib.get_close_matches(normalized, enhanced.split('\n'), n=1, cutoff=0.7)
            if close:
                altered.append({"original": normalized, "closest_match": close[0].strip()})
            else:
                altered.append({"original": normalized, "closest_match": None})
    
    total = len(orig_code_lines)
    preserved_count = len(preserved)
    altered_count = len(altered)
    
    if altered_count == 0:
        score = 10
        explanation = f"✅ All {total} code lines preserved verbatim"
    elif preserved_count > altered_count:
        score = 7
        explanation = f"⚠️ {preserved_count}/{total} code lines preserved, {altered_count} altered/missing"
    elif preserved_count == 0:
        score = 2
        explanation = f"❌ None of {total} code lines preserved — code was rewritten or dropped entirely"
    else:
        score = 4
        explanation = f"⚠️ Only {preserved_count}/{total} code lines preserved"
    
    return {
        "score": score,
        "explanation": explanation,
        "preserved": preserved,
        "altered": altered,
    }


def score_over_engineering(original: str, enhanced: str, mode: str, complexity_hint: str) -> dict:
    """
    Check if the enhanced prompt is bloated relative to the ask.
    A simple 'fix this bug' shouldn't become 300 words of CO-STAR.
    """
    orig_words = len(original.split())
    enh_words = len(enhanced.split())
    ratio = enh_words / max(orig_words, 1)
    
    # Detect over-engineering signals
    over_eng_signals = [
        "#### ", "### ", "## ",  # Excessive headers
        "**Constraints**", "**Requirements**", "**Expected Output**",
        "**Output Format**", "**Role**", "**Context**", "**Strategy**",
        "Step 1:", "Step 2:", "Step 3:", "Step 4:", "Step 5:",
    ]
    signal_count = sum(1 for s in over_eng_signals if s in enhanced)
    
    if complexity_hint == "simple":
        # Simple asks should NOT get heavy structure
        if mode == "quick":
            if enh_words > 60:
                score = 4
                explanation = f"❌ Over-engineered: simple ask in quick mode produced {enh_words} words (should be <60)"
            elif signal_count > 1:
                score = 5
                explanation = f"⚠️ Too much structure ({signal_count} formatting signals) for a simple ask"
            else:
                score = 10
                explanation = f"✅ Appropriately concise: {enh_words} words for simple quick ask"
        elif mode == "deep":
            if enh_words > 250 and signal_count > 4:
                score = 5
                explanation = f"⚠️ Possibly over-engineered: {enh_words} words + {signal_count} structural signals for a simple ask"
            elif enh_words > 400:
                score = 3
                explanation = f"❌ Heavily over-engineered: {enh_words} words for a straightforward bug fix"
            else:
                score = 9
                explanation = f"✅ Reasonable depth: {enh_words} words"
        else:
            score = 8
            explanation = f"Creative mode: {enh_words} words — no over-engineering concern"
    
    elif complexity_hint == "complex":
        # Complex asks SHOULD have structure
        if mode == "deep" and signal_count >= 2 and enh_words >= 80:
            score = 10
            explanation = f"✅ Appropriately structured: {enh_words} words + {signal_count} structural signals for complex ask"
        elif enh_words < 50:
            score = 4
            explanation = f"❌ Under-engineered: complex ask only got {enh_words} words"
        else:
            score = 7
            explanation = f"Acceptable: {enh_words} words for complex ask"
    
    else:  # medium
        if ratio > 15 and signal_count > 5:
            score = 5
            explanation = f"⚠️ Possibly bloated: {ratio:.1f}x expansion with {signal_count} structural signals"
        else:
            score = 8
            explanation = f"Balanced: {enh_words} words ({ratio:.1f}x expansion)"
    
    return {"score": score, "explanation": explanation}


def score_under_engineering(original: str, enhanced: str, mode: str) -> dict:
    """
    Check if a vague prompt was improved enough to be actionable.
    'fix it' should become something specific.
    """
    orig_words = len(original.split())
    enh_words = len(enhanced.split())
    
    if orig_words > 20:
        # Not a vague prompt, under-engineering check less relevant
        return {"score": 8, "explanation": "Original was already detailed — no under-engineering risk"}
    
    # For short/vague prompts, check if value was added
    if enh_words <= orig_words * 1.3:
        return {"score": 3, "explanation": f"❌ Under-engineered: {orig_words}→{enh_words} words, barely any enhancement"}
    
    # Check if the enhanced version adds specificity
    specificity_signals = [
        "specifically", "particular", "error", "issue", "problem",
        "expected", "actual", "behavior", "context", "clarif",
        "could you", "provide more", "what kind", "which", 
    ]
    spec_count = sum(1 for s in specificity_signals if s.lower() in enhanced.lower())
    
    if spec_count >= 2:
        return {"score": 9, "explanation": f"✅ Added {spec_count} specificity signals to vague prompt"}
    elif enh_words > orig_words * 2:
        return {"score": 7, "explanation": f"Good expansion ({orig_words}→{enh_words}) but could be more specific"}
    else:
        return {"score": 5, "explanation": f"⚠️ Expanded ({orig_words}→{enh_words}) but lacks concrete specificity"}


def score_intent_accuracy(enhanced: str, expected_intent: str, anti_signals: list = None) -> dict:
    """
    Check if the enhanced prompt captures the TRUE intent.
    Uses expected intent keywords and anti-signals (words that shouldn't appear).
    """
    enh_lower = enhanced.lower()
    
    # Check expected intent keywords
    intent_words = expected_intent.lower().split()
    found = sum(1 for w in intent_words if w in enh_lower)
    coverage = found / max(len(intent_words), 1)
    
    # Check anti-signals
    anti_violations = []
    if anti_signals:
        for anti in anti_signals:
            if anti.lower() in enh_lower:
                anti_violations.append(anti)
    
    score = 10
    parts = []
    
    if coverage >= 0.6:
        parts.append(f"✅ Intent coverage: {found}/{len(intent_words)} key terms found")
    elif coverage >= 0.3:
        score -= 2
        parts.append(f"⚠️ Partial intent: {found}/{len(intent_words)} key terms found")
    else:
        score -= 5
        parts.append(f"❌ Intent missed: only {found}/{len(intent_words)} key terms found")
    
    if anti_violations:
        score -= len(anti_violations) * 2
        parts.append(f"❌ Anti-signals found: {anti_violations}")
    
    return {"score": max(score, 1), "explanation": "; ".join(parts)}


def score_code_hallucination(original: str, enhanced: str) -> dict:
    """
    Check if the framework INVENTED new code that wasn't in the original.
    If the user didn't paste code, the enhanced prompt should NOT contain code.
    If user pasted code, the enhanced should not add different code.
    """
    _, orig_code_lines = extract_code_blocks(original)
    _, enh_code_lines = extract_code_blocks(enhanced)
    
    if not orig_code_lines and not enh_code_lines:
        return {"score": 10, "explanation": "✅ No code in input, no code in output — clean"}
    
    if not orig_code_lines and enh_code_lines:
        return {
            "score": 4,
            "explanation": f"⚠️ Code hallucination: {len(enh_code_lines)} code lines invented that weren't in original",
            "hallucinated_code": enh_code_lines[:5]
        }
    
    if orig_code_lines and not enh_code_lines:
        return {
            "score": 5,
            "explanation": f"⚠️ Code dropped: user's {len(orig_code_lines)} code lines were removed from prompt"
        }
    
    # Both have code — check if new code was added
    new_code = [line for line in enh_code_lines if line not in orig_code_lines]
    if not new_code:
        return {"score": 10, "explanation": f"✅ Code preserved, no new code invented"}
    else:
        return {
            "score": 5,
            "explanation": f"⚠️ {len(new_code)} new code lines added that weren't in original",
            "new_code": new_code[:5]
        }


def score_no_meta_commentary(enhanced: str) -> dict:
    """Check that output is ONLY the refined prompt."""
    bad_patterns = [
        r"(?i)^here(?:'s| is) (?:the |a |your )",
        r"(?i)^refined prompt:",
        r"(?i)^enhanced prompt:",
        r"(?i)^sure,? (?:here|I)",
        r"(?i)^certainly",
        r"(?i)I've (?:refined|enhanced|improved)",
    ]
    for pattern in bad_patterns:
        if re.search(pattern, enhanced.strip()):
            return {"score": 3, "explanation": f"❌ Meta-commentary detected: {pattern}"}
    return {"score": 10, "explanation": "✅ Clean output — no meta-commentary"}


def evaluate_scenario(scene: dict) -> dict:
    """Run all real-world scoring checks on a single scenario."""
    result = scene.get("result", {})
    payload = scene.get("payload", {})
    meta = scene.get("meta", {})
    
    original = payload.get("prompt", "")
    enhanced = result.get("enhanced", "")
    mode = payload.get("mode", "deep")
    complexity = meta.get("complexity", "medium")
    expected_intent = meta.get("expected_intent", "")
    anti_signals = meta.get("anti_signals", [])
    has_code = meta.get("has_code", False)
    
    dimensions = {}
    
    # 1. Code Preservation (only if original has code)
    if has_code:
        dimensions["code_preservation"] = score_code_preservation(original, enhanced)
    
    # 2. Over-engineering
    dimensions["over_engineering"] = score_over_engineering(original, enhanced, mode, complexity)
    
    # 3. Under-engineering (especially for vague prompts)
    dimensions["under_engineering"] = score_under_engineering(original, enhanced, mode)
    
    # 4. Intent accuracy
    if expected_intent:
        dimensions["intent_accuracy"] = score_intent_accuracy(enhanced, expected_intent, anti_signals)
    
    # 5. Code hallucination
    dimensions["code_hallucination"] = score_code_hallucination(original, enhanced)
    
    # 6. No meta-commentary
    dimensions["no_meta_commentary"] = score_no_meta_commentary(enhanced)
    
    # Weighted average
    weights = {
        "code_preservation": 3.0,    # CRITICAL for code prompts
        "over_engineering": 2.0,
        "under_engineering": 2.0,
        "intent_accuracy": 2.5,
        "code_hallucination": 2.5,
        "no_meta_commentary": 1.0,
    }
    
    total_s = 0
    total_w = 0
    for dim_name, dim_result in dimensions.items():
        if dim_result["score"] == -1:
            continue  # Skip N/A dimensions
        w = weights.get(dim_name, 1.0)
        total_s += dim_result["score"] * w
        total_w += w
    
    overall = round(total_s / total_w, 1) if total_w > 0 else 0
    
    return {"dimensions": dimensions, "overall_score": overall}


# ════════════════════════════════════════════════════════════════
# REAL-WORLD TEST SCENARIOS
# ════════════════════════════════════════════════════════════════

def build_scenarios():
    return [
        # ── GROUP 1: Bug Fix with Code (Should preserve code) ──
        {
            "category": "Bug Fix + Code",
            "name": "1. Python API 500 error with code",
            "meta": {
                "has_code": True,
                "complexity": "simple",
                "expected_intent": "fix debug 500 error API endpoint database query",
                "anti_signals": [],
            },
            "payload": {
                "prompt": """My API keeps returning 500. Here's my code:

@app.get("/users")
def get_users():
    return db.query(User).all()

Why is this failing?""",
                "mode": "quick",
                "platform": "chatgpt.com"
            }
        },
        {
            "category": "Bug Fix + Code",
            "name": "2. React infinite re-render with useEffect",
            "meta": {
                "has_code": True,
                "complexity": "simple",
                "expected_intent": "fix infinite re-render useEffect dependency array React",
                "anti_signals": [],
            },
            "payload": {
                "prompt": """My component keeps re-rendering infinitely. Here's the code:

useEffect(() => {
    setCounter(counter + 1);
});

How do I fix this?""",
                "mode": "quick",
                "platform": "chatgpt.com",
                "conversation_context": [
                    "[user]: I'm building a React dashboard",
                    "[assistant]: Nice! What features are you adding?",
                ]
            }
        },
        {
            "category": "Bug Fix + Code",
            "name": "3. SQL query not returning results",
            "meta": {
                "has_code": True,
                "complexity": "simple",
                "expected_intent": "SQL query returns no results empty join where clause",
                "anti_signals": [],
            },
            "payload": {
                "prompt": """This query returns nothing even though there's data:

SELECT u.name, o.total
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE o.status = 'completed'

What am I doing wrong?""",
                "mode": "quick",
                "platform": "claude.ai"
            }
        },
        {
            "category": "Bug Fix + Code",
            "name": "4. Python type error with actual traceback",
            "meta": {
                "has_code": True,
                "complexity": "simple",
                "expected_intent": "TypeError NoneType fix debug Python traceback",
                "anti_signals": [],
            },
            "payload": {
                "prompt": """Getting this error:

TypeError: 'NoneType' object is not subscriptable

From this code:
data = get_user_profile(user_id)
name = data['name']

What's happening?""",
                "mode": "quick",
                "platform": "chatgpt.com"
            }
        },

        # ── GROUP 2: Simple Asks (Should NOT be over-engineered) ──
        {
            "category": "Simple Ask",
            "name": "5. Quick question about syntax",
            "meta": {
                "has_code": False,
                "complexity": "simple",
                "expected_intent": "difference list comprehension generator expression Python",
                "anti_signals": ["CO-STAR", "Constraints", "Requirements", "Strategy"],
            },
            "payload": {
                "prompt": "what's the difference between a list comprehension and a generator expression in python?",
                "mode": "quick",
                "platform": "chatgpt.com"
            }
        },
        {
            "category": "Simple Ask",
            "name": "6. One-liner help",
            "meta": {
                "has_code": False,
                "complexity": "simple",
                "expected_intent": "reverse string Python one-liner",
                "anti_signals": [],
            },
            "payload": {
                "prompt": "how to reverse a string in python",
                "mode": "quick",
                "platform": "chatgpt.com"
            }
        },
        {
            "category": "Simple Ask",
            "name": "7. Quick concept check",
            "meta": {
                "has_code": False,
                "complexity": "simple",
                "expected_intent": "async await JavaScript promises",
                "anti_signals": [],
            },
            "payload": {
                "prompt": "explain async/await in javascript simply",
                "mode": "quick",
                "platform": "claude.ai"
            }
        },

        # ── GROUP 3: Complex Architecture (SHOULD be deeply enhanced) ──
        {
            "category": "Complex Architecture",
            "name": "8. System design question",
            "meta": {
                "has_code": False,
                "complexity": "complex",
                "expected_intent": "design microservices authentication authorization scalable distributed",
                "anti_signals": [],
            },
            "payload": {
                "prompt": "design a microservices auth system that handles millions of users",
                "mode": "deep",
                "platform": "chatgpt.com"
            }
        },
        {
            "category": "Complex Architecture",
            "name": "9. Full-stack feature spec",
            "meta": {
                "has_code": False,
                "complexity": "complex",
                "expected_intent": "real-time collaboration feature WebSocket React conflict resolution",
                "anti_signals": [],
            },
            "payload": {
                "prompt": "I need to build a real-time collaborative document editing feature like Google Docs",
                "mode": "deep",
                "platform": "chatgpt.com"
            }
        },

        # ── GROUP 4: Vague prompts WITH context (should leverage context) ──
        {
            "category": "Vague + Context",
            "name": "10. 'add tests' with conversation about FastAPI",
            "meta": {
                "has_code": False,
                "complexity": "medium",
                "expected_intent": "unit tests FastAPI endpoint pytest",
                "anti_signals": [],
            },
            "payload": {
                "prompt": "add tests for this",
                "mode": "deep",
                "platform": "chatgpt.com",
                "conversation_context": [
                    "[user]: I built a FastAPI endpoint for user registration",
                    "[assistant]: Here's a POST /register endpoint with email validation",
                    "[user]: Works great but I need to make sure it handles edge cases",
                ]
            }
        },
        {
            "category": "Vague + Context",
            "name": "11. 'optimize this' with DB conversation",
            "meta": {
                "has_code": False,
                "complexity": "medium",
                "expected_intent": "optimize database query performance index slow",
                "anti_signals": [],
            },
            "payload": {
                "prompt": "optimize this",
                "mode": "quick",
                "platform": "chatgpt.com",
                "conversation_context": [
                    "[user]: My Postgres query takes 30 seconds to run",
                    "[assistant]: That's too slow. Can you show the query and explain your table structure?",
                    "[user]: SELECT * FROM events WHERE created_at > '2024-01-01' ORDER BY created_at DESC LIMIT 100",
                    "[assistant]: Do you have an index on created_at?",
                ]
            }
        },

        # ── GROUP 5: Code Refactoring (code should be preserved, ask enhanced) ──
        {
            "category": "Refactoring + Code",
            "name": "12. Refactor messy function — preserve code, enhance ask",
            "meta": {
                "has_code": True,
                "complexity": "medium",
                "expected_intent": "refactor clean improve readable function",
                "anti_signals": [],
            },
            "payload": {
                "prompt": """refactor this:

def process(d):
    r = []
    for i in d:
        if i['status'] == 'active' and i['age'] > 18:
            r.append({'name': i['name'], 'email': i['email']})
    return r""",
                "mode": "deep",
                "platform": "chatgpt.com"
            }
        },
        {
            "category": "Refactoring + Code",
            "name": "13. Convert class component to hooks — preserve code",
            "meta": {
                "has_code": True,
                "complexity": "medium",
                "expected_intent": "convert React class component functional hooks useState useEffect",
                "anti_signals": [],
            },
            "payload": {
                "prompt": """Convert this class component to use hooks:

class Timer extends React.Component {
    constructor(props) {
        super(props);
        this.state = { seconds: 0 };
    }
    componentDidMount() {
        this.interval = setInterval(() => {
            this.setState({ seconds: this.state.seconds + 1 });
        }, 1000);
    }
    componentWillUnmount() {
        clearInterval(this.interval);
    }
    render() {
        return <div>{this.state.seconds}</div>;
    }
}""",
                "mode": "deep",
                "platform": "chatgpt.com"
            }
        },

        # ── GROUP 6: Non-code prompts (framework should NOT hallucinate code) ──
        {
            "category": "Non-Code",
            "name": "14. Career advice — no code should appear",
            "meta": {
                "has_code": False,
                "complexity": "simple",
                "expected_intent": "career switch software engineer advice transition",
                "anti_signals": ["def ", "function ", "import ", "class "],
            },
            "payload": {
                "prompt": "I'm thinking about switching from frontend to backend development. Any tips?",
                "mode": "deep",
                "platform": "chatgpt.com"
            }
        },
        {
            "category": "Non-Code",
            "name": "15. Learning path question",
            "meta": {
                "has_code": False,
                "complexity": "medium",
                "expected_intent": "learn machine learning roadmap beginner path resources",
                "anti_signals": [],
            },
            "payload": {
                "prompt": "what should I learn to get into machine learning? I know python basics",
                "mode": "deep",
                "platform": "chatgpt.com"
            }
        },

        # ── GROUP 7: Mixed code + natural language (hardest case) ──
        {
            "category": "Mixed Code+NL",
            "name": "16. Error + code + question + context",
            "meta": {
                "has_code": True,
                "complexity": "medium",
                "expected_intent": "CORS error FastAPI React frontend blocked header origin",
                "anti_signals": [],
            },
            "payload": {
                "prompt": """I keep getting CORS errors when my React frontend calls:

fetch('http://localhost:8000/api/users', {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token }
})

My FastAPI backend has:
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000"])

But I'm running the frontend on port 3001 now. What's wrong?""",
                "mode": "quick",
                "platform": "chatgpt.com"
            }
        },
        {
            "category": "Mixed Code+NL",
            "name": "17. Multi-file debugging with code snippets",
            "meta": {
                "has_code": True,
                "complexity": "medium",
                "expected_intent": "import module circular dependency ModuleNotFoundError Python",
                "anti_signals": [],
            },
            "payload": {
                "prompt": """Getting ModuleNotFoundError when I try to import:

# In services/user_service.py
from models.user import UserModel

# In models/user.py  
from services.user_service import validate_user

Is this a circular import? How do I fix it without restructuring everything?""",
                "mode": "deep",
                "platform": "claude.ai"
            }
        },
        {
            "category": "Mixed Code+NL",
            "name": "18. Docker debugging with config",
            "meta": {
                "has_code": True,
                "complexity": "medium",
                "expected_intent": "Docker container database connection refused localhost network",
                "anti_signals": [],
            },
            "payload": {
                "prompt": """My dockerized app can't connect to the database:

# docker-compose.yml
services:
  app:
    build: .
    ports: ["8000:8000"]
  db:
    image: postgres:15
    ports: ["5432:5432"]

# In my app config:
DATABASE_URL = "postgresql://user:pass@localhost:5432/mydb"

Container starts but gets connection refused. Why?""",
                "mode": "quick",
                "platform": "chatgpt.com"
            }
        },
    ]


# ════════════════════════════════════════════════════════════════
# TEST RUNNER
# ════════════════════════════════════════════════════════════════

def run_realworld_evaluation():
    print("=" * 72)
    print("  🔬 REAL-WORLD SCENARIO EVALUATION")
    print("  Prompt Engineering Framework v4.0 — Developer Experience Testing")
    print("=" * 72)
    print(f"  Timestamp: {datetime.now().isoformat()}")
    print(f"  Backend:   {API_URL}")
    print()

    # Health check
    try:
        r = requests.get(f"{API_URL}/", timeout=5)
        print(f"  ✅ Server: {r.json()}")
    except Exception as e:
        print(f"  ❌ Server unreachable: {e}")
        sys.exit(1)

    # Create test user
    uid = str(uuid.uuid4())
    email = f"realworld_tester_{uid[:8]}@gmail.com"
    print(f"\n  👤 Test User: {email}")

    token = create_jwt_token(uid, email)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    in_memory_users[uid] = {
        "user_id": uid,
        "email": email,
        "tech_stack": ["Python", "JavaScript", "React", "FastAPI", "PostgreSQL", "Docker"],
        "preferences": "Clean, modular code. Concise explanations."
    }

    scenarios = build_scenarios()
    total = len(scenarios)
    print(f"\n  📋 {total} real-world scenarios loaded\n")
    print("-" * 72)

    results = []
    failures = 0

    for idx, scene in enumerate(scenarios):
        print(f"\n  [{idx+1}/{total}] {scene['category']} | {scene['name']}")
        
        start = time.time()
        try:
            resp = requests.post(f"{API_URL}/enhance", headers=headers, json=scene["payload"], timeout=30)
            resp.raise_for_status()
            data = resp.json()
            latency = round(time.time() - start, 2)

            enhanced = data.get("enhanced", "")
            preview = enhanced[:140].replace("\n", "↵") + ("..." if len(enhanced) > 140 else "")
            
            prompt_preview = scene['payload']['prompt'][:80].replace('\n', '↵')
            print(f"    ⏱ {latency}s")
            print(f"    📝 Input:  \"{prompt_preview}...\"")
            print(f"    ✨ Output: \"{preview}\"")

            scene["result"] = data
            scene["latency"] = latency
            scene["status"] = "success"

        except Exception as e:
            print(f"    ❌ FAILED: {e}")
            scene["result"] = {"enhanced": ""}
            scene["latency"] = round(time.time() - start, 2)
            scene["status"] = "failed"
            failures += 1

        results.append(scene)

    # ── Score all results ──
    print("\n" + "=" * 72)
    print("  📊 SCORING RESULTS — Real-World Quality")
    print("=" * 72)

    category_scores = {}
    all_scores = []

    for scene in results:
        if scene["status"] == "failed":
            evaluation = {"dimensions": {}, "overall_score": 0}
        else:
            evaluation = evaluate_scenario(scene)
        
        scene["evaluation"] = evaluation
        score = evaluation["overall_score"]
        all_scores.append(score)

        cat = scene["category"]
        if cat not in category_scores:
            category_scores[cat] = []
        category_scores[cat].append(score)

        grade = "🟢" if score >= 8 else "🟡" if score >= 6 else "🔴"
        print(f"\n  {grade} [{score}/10] {scene['name']}")
        for dim_name, dim_data in evaluation.get("dimensions", {}).items():
            if dim_data.get("score", 0) == -1:
                continue
            icon = "✅" if dim_data["score"] >= 8 else "⚠️" if dim_data["score"] >= 5 else "❌"
            print(f"       {icon} {dim_name}: {dim_data['score']}/10 — {dim_data['explanation']}")
            # Show altered code if any
            if dim_data.get("altered"):
                for alt in dim_data["altered"][:3]:
                    print(f"          ORIG: {alt.get('original', '')[:80]}")
                    print(f"          NEAR: {alt.get('closest_match', 'NOT FOUND')}")
            if dim_data.get("hallucinated_code"):
                for hc in dim_data["hallucinated_code"][:3]:
                    print(f"          HALLUCINATED: {hc[:80]}")

    # Category summaries
    print("\n" + "=" * 72)
    print("  📈 CATEGORY AVERAGES")
    print("=" * 72)
    for cat, scores in category_scores.items():
        avg = round(sum(scores) / len(scores), 1)
        grade = "🟢" if avg >= 8 else "🟡" if avg >= 6 else "🔴"
        print(f"  {grade} {cat}: {avg}/10 ({len(scores)} tests)")

    # Final
    final = round(sum(all_scores) / len(all_scores), 1) if all_scores else 0
    avg_lat = round(sum(s["latency"] for s in results) / len(results), 2)

    print("\n" + "=" * 72)
    print(f"  ⭐ FINAL REAL-WORLD SCORE: {final} / 10")
    print(f"  ⏱  Average Latency: {avg_lat}s")
    print(f"  📊 {total - failures} passed, {failures} failed")
    print("=" * 72)

    # Save JSON report
    report = {
        "metadata": {
            "timestamp": datetime.now().isoformat(),
            "test_type": "real-world developer scenarios",
            "total": total,
            "passed": total - failures,
            "failed": failures,
            "avg_latency": avg_lat,
            "final_score": final,
        },
        "category_averages": {cat: round(sum(s)/len(s), 1) for cat, s in category_scores.items()},
        "detailed_results": [],
    }

    for scene in results:
        entry = {
            "category": scene["category"],
            "name": scene["name"],
            "status": scene["status"],
            "latency": scene["latency"],
            "complexity": scene["meta"]["complexity"],
            "has_code": scene["meta"]["has_code"],
            "input_prompt": scene["payload"]["prompt"][:500],
            "mode": scene["payload"].get("mode", "deep"),
            "platform": scene["payload"].get("platform", "unknown"),
            "enhanced_output": scene["result"].get("enhanced", "")[:1500],
            "context_used": scene["result"].get("context_used", {}),
            "evaluation": scene.get("evaluation", {}),
        }
        report["detailed_results"].append(entry)

    report_path = os.path.join(os.path.dirname(__file__), "realworld_eval_report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False, default=str)

    print(f"\n  📁 Report: {report_path}")
    print(f"  🏁 EVALUATION COMPLETE.\n")

    return final


if __name__ == "__main__":
    score = run_realworld_evaluation()
    sys.exit(0 if score >= 6 else 1)
