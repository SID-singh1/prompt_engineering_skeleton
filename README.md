<p align="center">
  <img src="https://img.shields.io/badge/version-4.4-2a8a7a?style=for-the-badge" alt="Version 4.4" />
  <img src="https://img.shields.io/badge/Manifest-V3-blue?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white" alt="MongoDB" />
  <img src="https://img.shields.io/badge/Qdrant-FF5722?style=for-the-badge&logo=data&logoColor=white" alt="Qdrant" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=for-the-badge" alt="MIT License" />
</p>

<h1 align="center">⊕ Prompt Memory</h1>

<p align="center">
  <strong>One-click prompt engineering — turns your raw thoughts into precision-crafted LLM queries.</strong><br/>
  A Chrome extension + intelligent backend that learns how <em>you</em> prompt and makes every interaction better.
</p>

---

## ✨ Features at a Glance

| Feature | Description |
|---|---|
| 🧠 **Context-Aware Enhancement** | Understands what you're discussing and refines your prompt accordingly |
| 💾 **Prompt Library** | Save, tag, search, and reuse your best prompts as context |
| 🔍 **Semantic Memory** | Finds similar past prompts using vector similarity — learns from your history |
| ⚡ **Instant Shortcut** | Press `Ctrl+Shift+E` (`⌘+Shift+E` on Mac) to enhance in-place, instantly |
| 🎯 **Mode-Aware** | Switches between Balanced, Technical, and Creative refinement styles |
| 🎙️ **Voice-to-Prompt** | Record a thought, review the Whisper transcript, then enhance it |
| 🌐 **Multi-Platform** | Works on **ChatGPT**, **Claude**, **Gemini**, **Perplexity**, **Grok** |
| 🔐 **Secure Auth** | Google OAuth with JWT sessions (7-day expiry) |
| 👍 **Feedback Loop** | Thumbs up/down on enhancements to continuously improve quality |

---

## 🗂️ Project Structure

For a dated, code-verified comparison of the last committed architecture and
the current local working tree, see
[`docs/ARCHITECTURE_BEFORE_AFTER.md`](docs/ARCHITECTURE_BEFORE_AFTER.md).

```
prompt_engineering_skeleton/
│
├── extension/               # Chrome Extension (Manifest V3)
│   ├── manifest.json        # Extension config, permissions & shortcuts
│   ├── content.js           # Core logic — injected into AI chat pages
│   ├── styles.css           # Injected UI styles (calm, minimal design)
│   ├── popup.html           # Extension popup — login & profile
│   └── popup.js             # Popup auth flow logic
│
├── backend/                 # FastAPI Backend
│   ├── main.py              # App entry point & router registration
│   ├── requirements.txt     # Python dependencies
│   ├── .env                 # Environment variables (secrets)
│   │
│   ├── core/
│   │   ├── config.py        # Settings loader (env vars)
│   │   ├── database.py      # MongoDB + Qdrant connections
│   │   └── security.py      # JWT verification
│   │
│   ├── routers/
│   │   ├── auth.py          # Google OAuth endpoints
│   │   ├── prompts.py       # Enhance, track & feedback endpoints
│   │   ├── saved_prompts.py # CRUD for saved prompt library
│   │   └── users.py         # User profile endpoints
│   │
│   ├── services/
│   │   ├── providers.py     # Provider-agnostic LLM chain + failover
│   │   ├── llm_service.py   # Whisper client + sentence-transformer embeddings
│   │   ├── memory_service.py# Semantic retrieval, logging & memorization
│   │   └── email_service.py # SendGrid helper (currently unused)
│   │
│   └── models/
│       └── schemas.py       # Pydantic request/response models
│
├── run_prod.bat             # One-click production server launcher
└── setup.bat                # Initial environment setup
```

---

## 🚀 Getting Started

### Prerequisites

- **Python 3.10+**
- **Google Chrome** (or any Chromium-based browser)
- API keys for: **Groq**, **MongoDB Atlas**, **Qdrant Cloud** (or use `:memory:`)
- Google OAuth credentials (Client ID + Secret)

### 1 · Backend Setup

```bash
# Clone the repository
git clone https://github.com/siddhm11/prompt_engineering_skeleton.git
cd prompt_engineering_skeleton

# Create & activate a virtual environment
cd backend
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS / Linux

# Install dependencies
pip install -r requirements.txt
```

#### Configure Environment

Create or edit `backend/.env` with your credentials:

```env
# ── LLM ──
# Only GROQ_API_KEY is required. The others add server-side fallback providers;
# users who bring their own key need none of these set.
GROQ_API_KEY=your_groq_api_key
GROQ_API_KEY_2=optional_second_key_for_rotation
# GEMINI_API_KEY=
# OPENROUTER_API_KEY=

# Model selection lives in backend/services/providers.py as an ordered fallback
# chain — do NOT pin a single model id here. Set this only to force one:
# MODEL_OVERRIDE=

# ── Databases ──
MONGO_URI= make one on your own 
QDRANT_URL=https://your-cluster.qdrant.io
QDRANT_API_KEY=your_qdrant_api_key

# ── Auth ──
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
JWT_SECRET=your_secure_random_secret

# ── Private builder dashboard ──
# Generate a long random value. Never commit it or put it in a URL.
BUILDER_DASHBOARD_KEY=your_long_random_dashboard_key
# Add this only when builder.html is hosted on a DIFFERENT origin from the API.
# Same-origin hosting needs no CORS entry.
# BUILDER_DASHBOARD_ORIGINS=https://your-private-dashboard.example
# Limits a dashboard request to its newest N logs; failure events expire after 90 days.
# DASHBOARD_MAX_LOGS=50000
# ANALYTICS_EVENT_TTL_DAYS=90

# ── Email (Optional) ──
SENDGRID_API_KEY=your_sendgrid_api_key
```

#### Start the Server

**Option A** — Double-click `run_prod.bat` (Windows)

**Option B** — Manual start from the project root:

```bash
cd ..   # back to project root
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

The API will be live at **http://localhost:8000**. Hit `/` to verify:

```json
{ "status": "running", "service": "Context-Aware Prompt Engine", "production_ready": true }
```

### Prompt-quality evaluation

Prompt rewrites are covered by an 82-case evaluation corpus spanning intent
fidelity, explicit and negative constraints, code preservation, conversation
context, voice disfluency, multilingual input, numerical fidelity, prompt
injection, modes, and every supported platform. See
[`evals/README.md`](evals/README.md) for the scoring rubric and quota-aware live
runner.

The [product-quality research assessment](evals/PRODUCT_QUALITY_RESEARCH.md)
explains the original measurement gaps; later provider diagnostics and their
limitations are documented in
[`evals/HELDOUT_2026-09-13.md`](evals/HELDOUT_2026-09-13.md).

Validate the corpus without making model calls:

```bash
pytest tests/test_prompt_eval_dataset.py -q
python evals/run_prompt_eval.py --dry-run
python evals/run_context_retrieval_eval.py --validate
```

---

### 2 · Chrome Extension Setup

1. Open Chrome → navigate to `chrome://extensions`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load Unpacked**
4. Select the `extension/` folder inside this project
5. Pin the **⊕ Prompt Memory** extension to your toolbar

---

### 3 · Start Using

1. Click the **⊕ Prompt Memory** icon in your toolbar and accept the first-run
   data disclosure.
2. **Continue with Google** for the shared-key allowance of 15 enhancements a
   day, saved prompts, and History. To use the extension without a Prompt Memory
   account, expand **Use your own API key instead**, get a key from
   [console.groq.com/keys](https://console.groq.com/keys) or another supported
   provider, and select *Save & test*. Your allowance then follows your
   provider's current limits.
3. Navigate to any supported AI platform — a floating **⊕** button appears
4. Type a prompt, then click **Enhance** or press `Ctrl+Shift+E`
5. Review the before/after diff → accept, edit, or dismiss

When reloading an unpacked extension from `chrome://extensions`, refresh
chat tabs that were already open. Chrome leaves their old content scripts in
place until those pages load again.

For signed-in users, generating a rewrite adds it to History but does **not**
teach passive memory. Passive memory is written only after the rewritten prompt
is successfully applied to the composer (including History → Use). Dismissing
the preview, copying text, or applying the original does not approve it.
Previously stored passive vectors without an approval marker are excluded from
retrieval. Saved prompts remain explicit user-managed context. If the database
or vector store is unavailable, acceptance still applies the text, but memory
may not be saved; a later History → Use can retry it. When Mongo is configured,
the server does not write a durable memory vector until the approval log is
durably stored, so a database outage cannot immediately leave an untracked
memory behind. Prompt-log retention may later expire that record; a separate
long-lived consent ledger is still needed before claiming permanent auditability.

> **Why bring your own key?** You use your provider account's allowance instead
> of the shared server key. Current rate limits vary by provider, model, and
> account. With no sign-in your prompts go straight from your browser to the
> chosen provider without touching this server.

---

## 🧠 How It Works

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────────┐
│  You type a  │────▶│   Extension  │────▶│     FastAPI Backend   │
│  raw prompt  │     │  scrapes the │     │                       │
│  on ChatGPT  │     │  conversation│     │  1. Detect intent     │
│  / Claude /  │     │  + your input│     │  2. Retrieve context  │
│  Gemini …    │     │              │     │  3. Match saved       │
└──────────────┘     └──────────────┘     │     prompts (Qdrant)  │
                                          │  4. Craft refined     │
                                          │     prompt (Groq LLM) │
                                          └───────────┬───────────┘
                                                      │
                                          ┌───────────▼───────────┐
                                          │  Enhanced prompt sent  │
                                          │  back to extension →   │
                                          │  Diff preview shown    │
                                          └────────────────────────┘
```

**Context Priority (in order):**
1. 📝 **Conversation history** — what's been discussed on the page
2. 📌 **User-selected saved prompts** — hand-picked context
3. 🔍 **Similarity-matched prompts** — semantically relevant past prompts
4. 👤 **User profile** — technical background (when applicable)

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+E` | Enhance the current prompt instantly |
| `Ctrl+Shift+V` | Voice-to-Prompt |

---

## 🎙️ Voice-to-Prompt

Press `Ctrl+Shift+V` (or `⌘+Shift+V` on macOS) to record a spoken draft. The extension records a short WebM audio clip, sends it to Whisper for transcription, then gives you an editable transcript before any enhancement request is made. You can discard it, put it into the composer as a draft, or enhance the corrected version.

Audio is used only for the transcription request and is not stored by Prompt Memory. The private builder dashboard records safe operational metadata—such as transcription duration, success/failure, and latency—without transcript text or audio. Voice transcription requires a signed-in account so the backend cannot be used as an anonymous audio proxy.

---

## 🌐 Supported Platforms

<p>
  <img src="https://img.shields.io/badge/ChatGPT-74aa9c?style=flat-square&logo=openai&logoColor=white" alt="ChatGPT" />
  <img src="https://img.shields.io/badge/Claude-d97757?style=flat-square&logo=anthropic&logoColor=white" alt="Claude" />
  <img src="https://img.shields.io/badge/Gemini-4285F4?style=flat-square&logo=google&logoColor=white" alt="Gemini" />
  <img src="https://img.shields.io/badge/Perplexity-1a1a2e?style=flat-square&logoColor=white" alt="Perplexity" />
  <img src="https://img.shields.io/badge/Grok-000000?style=flat-square&logo=x&logoColor=white" alt="Grok" />
</p>

---

## 🛡️ Tech Stack

| Layer | Technology |
|---|---|
| **Extension** | Chrome Manifest V3, Vanilla JS, CSS |
| **Backend** | FastAPI, Uvicorn |
| **LLM** | Groq (`qwen/qwen3.8-27b` primary, with an automatic fallback chain) — or your own key on Groq / Gemini / OpenRouter |
| **Embeddings** | Sentence-Transformers (`paraphrase-multilingual-MiniLM-L12-v2`) |
| **Vector DB** | Qdrant (cloud or in-memory) |
| **Database** | MongoDB Atlas |
| **Auth** | Google OAuth 2.0, JWT |
| **Email** | SendGrid |

---

## 🗺️ Roadmap

- [x] Context-aware prompt enhancement
- [x] Saved prompt library with semantic search
- [x] Multi-platform support (ChatGPT, Claude, Gemini, Perplexity, Grok)
- [x] Google OAuth authentication
- [x] Keyboard shortcut (`Ctrl+Shift+E`)
- [x] Diff preview with accept/dismiss
- [x] Thumbs up/down feedback loop
- [x] 🎙️ Voice-to-Prompt with transcript review
- [x] Private builder analytics dashboard
- [ ] Team / shared prompt libraries
- [ ] Firefox & Edge extension support

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Open an issue, submit a pull request, or email [hello.promptmemory@gmail.com](mailto:hello.promptmemory@gmail.com).

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

---

<p align="center">
  Built with ☕ and curiosity by <a href="https://github.com/siddhm11"><strong>@siddhm11</strong></a> & <a href="https://github.com/SID-singh1"><strong>@SID-singh1</strong></a>
</p>
