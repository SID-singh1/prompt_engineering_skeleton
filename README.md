<p align="center">
  <img src="https://img.shields.io/badge/version-2.0-2a8a7a?style=for-the-badge" alt="Version 2.0" />
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
| 🌐 **Multi-Platform** | Works on **ChatGPT**, **Claude**, **Gemini**, **Perplexity**, **Grok** |
| 🔐 **Secure Auth** | Google OAuth + email OTP login with JWT sessions |
| 👍 **Feedback Loop** | Thumbs up/down on enhancements to continuously improve quality |

---

## 🗂️ Project Structure

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
│   │   ├── auth.py          # Google OAuth + OTP endpoints
│   │   ├── prompts.py       # Enhance, track & feedback endpoints
│   │   ├── saved_prompts.py # CRUD for saved prompt library
│   │   └── users.py         # User profile endpoints
│   │
│   ├── services/
│   │   ├── llm_service.py   # Groq API + sentence-transformer embeddings
│   │   ├── memory_service.py# Semantic retrieval, logging & memorization
│   │   └── email_service.py # SendGrid OTP delivery
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
- *(Optional)* SendGrid API key for email OTP, Google OAuth credentials

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
GROQ_API_KEY=your_groq_api_key

# ── Databases ──
MONGO_URI= make one on your own 
QDRANT_URL=https://your-cluster.qdrant.io
QDRANT_API_KEY=your_qdrant_api_key

# ── Auth ──
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
JWT_SECRET=your_secure_random_secret

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

---

### 2 · Chrome Extension Setup

1. Open Chrome → navigate to `chrome://extensions`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load Unpacked**
4. Select the `extension/` folder inside this project
5. Pin the **⊕ Prompt Memory** extension to your toolbar

---

### 3 · Login & Start Using

1. Click the **⊕ Prompt Memory** icon in your toolbar
2. Sign in with **Google** or enter your email for a one-time code
3. Navigate to any supported AI platform — a floating **⊕** button appears
4. Type a prompt, then click **Enhance** or press `Ctrl+Shift+E`
5. Review the before/after diff → accept, edit, or dismiss

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
| `Ctrl+Shift+V` | Voice-to-Prompt *(prototype — see below)* |

---

## 🎙️ Voice-to-Prompt

> [!NOTE]
> **🚧 Prototype — Coming in the next update**
>
> Voice-to-Prompt is currently in early prototype stage. The feature leverages the browser's built-in Web Speech API to let you speak your prompts naturally, with live transcription and automatic enhancement after you stop speaking.
>
> The shortcut (`Ctrl+Shift+V`) and underlying infrastructure are wired up, but full stability and UX polish are planned for the **next release**.

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
| **LLM** | Groq API (Llama / Mixtral) |
| **Embeddings** | Sentence-Transformers (`all-MiniLM-L6-v2`) |
| **Vector DB** | Qdrant (cloud or in-memory) |
| **Database** | MongoDB Atlas |
| **Auth** | Google OAuth 2.0, Email OTP, JWT |
| **Email** | SendGrid |

---

## 🗺️ Roadmap

- [x] Context-aware prompt enhancement
- [x] Saved prompt library with semantic search
- [x] Multi-platform support (ChatGPT, Claude, Gemini, Perplexity, Grok)
- [x] Google OAuth + OTP authentication
- [x] Keyboard shortcut (`Ctrl+Shift+E`)
- [x] Diff preview with accept/dismiss
- [x] Thumbs up/down feedback loop
- [ ] 🎙️ Voice-to-Prompt (prototype → full release)
- [ ] Prompt analytics dashboard
- [ ] Team / shared prompt libraries
- [ ] Firefox & Edge extension support

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to open an issue or submit a pull request.

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

---

<p align="center">
  Built with ☕ and curiosity by <a href="https://github.com/siddhm11"><strong>@siddhm11</strong></a> & <a href="https://github.com/SID-singh1"><strong>@SID-singh1</strong></a>
</p>