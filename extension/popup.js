// ════════════════════════════════════════════════════════════════
// Prompt Memory — Extension Popup (Google OAuth Only)
// ════════════════════════════════════════════════════════════════

// const DEFAULT_API_URL = "https://siddhm11-prompt-engine.hf.space";  // ← production
const DEFAULT_API_URL = "http://localhost:8000";  // ← local testing
let API_URL = DEFAULT_API_URL;

const loginSection = document.getElementById("login-section");
const profileSection = document.getElementById("profile-section");
const statusText = document.getElementById("status");
const userDisplay = document.getElementById("user-display");
const profileAvatar = document.getElementById("profile-avatar");
const googleBtn = document.getElementById("google-login-btn");
const logoutBtn = document.getElementById("logout-btn");

// ── Init: Load API URL + check login state ──
chrome.storage.local.get(["user_id", "email", "token", "api_url"], async (result) => {
    if (result.api_url) API_URL = result.api_url;

    if (result.user_id && result.email && result.token) {
        // Auto-refresh token if expiring within 2 days
        if (isTokenExpiringSoon(result.token, 2)) {
            await tryRefreshToken(result.token);
        }
        showProfile(result.email);
    }
});

// ── Token helpers ──
function isTokenExpiringSoon(token, days = 2) {
    try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        const expiresAt = payload.exp * 1000;
        return expiresAt < Date.now() + days * 24 * 60 * 60 * 1000;
    } catch {
        return false;
    }
}

async function tryRefreshToken(token) {
    try {
        const res = await fetch(`${API_URL}/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
        });
        if (res.ok) {
            const data = await res.json();
            chrome.storage.local.set({ token: data.token, email: data.email, user_id: data.user_id });
            return true;
        }
    } catch (e) {
        console.log("Popup: token refresh failed", e);
    }
    return false;
}

// ── Google Login ──
googleBtn.addEventListener("click", () => {
    statusText.innerText = "Opening Google...";
    const width = 500;
    const height = 600;
    const left = (screen.width - width) / 2;
    const top = (screen.height - height) / 2;

    fetch(`${API_URL}/auth/google/login`)
        .then(res => res.json())
        .then(data => {
            window.open(data.url, "GoogleLogin", `width=${width},height=${height},top=${top},left=${left}`);
            statusText.innerText = "Complete sign-in in the popup...";
        })
        .catch(err => {
            statusText.innerText = "Connection error. Try again.";
            console.error("Google login error:", err);
        });
});

// ── Listen for Google callback message ──
window.addEventListener("message", (event) => {
    if (event.data.type === "GOOGLE_AUTH_SUCCESS") {
        const { token, email, user_id } = event.data;
        chrome.storage.local.set({ user_id, email, token }, () => {
            statusText.innerText = "";
            showProfile(email);
        });
    }
});

// ── Logout ──
logoutBtn.addEventListener("click", () => {
    chrome.storage.local.remove(["user_id", "email", "token"], () => {
        showLogin();
    });
});

// ── UI Helpers ──
function showProfile(email) {
    loginSection.classList.add("hidden");
    profileSection.classList.remove("hidden");
    userDisplay.innerText = email;

    // Set avatar to first letter of email
    const initial = email.charAt(0).toUpperCase();
    profileAvatar.innerText = initial;
}

function showLogin() {
    profileSection.classList.add("hidden");
    loginSection.classList.remove("hidden");
    statusText.innerText = "";
}
