/**
 * Prompt Memory — Google OAuth & Guest Authentication Controller
 */

// Determine API base URL dynamically (supports Vercel env variable VITE_API_URL)
const API_BASE = import.meta.env?.VITE_API_URL || (
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:8000'
        : (localStorage.getItem('pm_api_url') || 'https://siddhm11-prompt-engine.hf.space')
);

const AUTH_POLL_INTERVAL_MS = 1000;
const AUTH_TIMEOUT_MS = 180000; // 3 minutes

const googleBtn = document.getElementById('google-signin-btn');
const googleBtnText = document.getElementById('google-btn-text');
const googleSpinner = document.getElementById('google-btn-spinner');
const demoBtn = document.getElementById('guest-demo-btn');
const authAlert = document.getElementById('auth-alert');

function showAlert(message, type = 'error') {
    authAlert.textContent = message;
    authAlert.className = `auth-alert ${type}`;
    authAlert.classList.remove('hidden');
}

function hideAlert() {
    authAlert.classList.add('hidden');
}

function setButtonLoading(loading, message = 'Connecting to Google...') {
    if (loading) {
        googleBtn.disabled = true;
        googleSpinner.classList.remove('hidden');
        googleBtnText.textContent = message;
    } else {
        googleBtn.disabled = false;
        googleSpinner.classList.add('hidden');
        googleBtnText.textContent = 'Continue with Google';
    }
}

// Redirect if already authenticated
if (localStorage.getItem('pm_token')) {
    window.location.href = 'dashboard.html';
}

// Handle Google OAuth
async function handleGoogleLogin() {
    hideAlert();
    setButtonLoading(true, 'Initializing sign in...');

    let authUrl, state;
    try {
        const res = await fetch(`${API_BASE}/auth/google/login`);
        if (!res.ok) {
            throw new Error(`Server returned HTTP ${res.status}`);
        }
        const data = await res.json();
        authUrl = data.url;
        state = data.state;
    } catch (err) {
        setButtonLoading(false);
        showAlert(`Could not connect to authentication server at ${API_BASE}. You can explore using Guest Mode below.`);
        return;
    }

    if (!authUrl || !state) {
        setButtonLoading(false);
        showAlert('Sign-in server returned an invalid response. Please try again.');
        return;
    }

    // Open popup
    const width = 540;
    const height = 640;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    const popup = window.open(
        authUrl,
        'PromptMemoryGoogleLogin',
        `width=${width},height=${height},left=${left},top=${top},status=no,toolbar=no,menubar=no`
    );

    if (!popup) {
        setButtonLoading(false);
        showAlert('Popup blocked by browser. Please allow popups for this site or use Demo Mode.');
        return;
    }

    setButtonLoading(true, 'Waiting for Google sign in...');

    const deadline = Date.now() + AUTH_TIMEOUT_MS;
    const interval = setInterval(async () => {
        // Check timeout
        if (Date.now() > deadline) {
            clearInterval(interval);
            setButtonLoading(false);
            showAlert('Sign in timed out. Please try again.');
            return;
        }

        // Poll backend
        try {
            const pollRes = await fetch(`${API_BASE}/auth/google/poll?state=${encodeURIComponent(state)}`);
            if (!pollRes.ok) return;

            const pollData = await pollRes.json();
            if (pollData && pollData.status === 'ready' && pollData.token) {
                clearInterval(interval);
                try { popup.close(); } catch (_) {}

                // Store credentials
                localStorage.setItem('pm_token', pollData.token);
                localStorage.setItem('pm_email', pollData.email || 'user@promptmemory.ai');
                localStorage.setItem('pm_user_id', pollData.user_id || '');
                localStorage.removeItem('pm_guest_mode');

                showAlert('Signed in successfully! Launching dashboard...', 'success');
                setTimeout(() => {
                    window.location.href = 'dashboard.html';
                }, 600);
            }
        } catch (err) {
            // Transient error while polling; keep waiting
        }

        // Check if user manually closed popup without logging in
        if (popup.closed) {
            // Give one final poll attempt
            setTimeout(async () => {
                try {
                    const finalRes = await fetch(`${API_BASE}/auth/google/poll?state=${encodeURIComponent(state)}`);
                    const finalData = await finalRes.json();
                    if (finalData && finalData.status === 'ready' && finalData.token) {
                        clearInterval(interval);
                        localStorage.setItem('pm_token', finalData.token);
                        localStorage.setItem('pm_email', finalData.email || 'user@promptmemory.ai');
                        localStorage.setItem('pm_user_id', finalData.user_id || '');
                        localStorage.removeItem('pm_guest_mode');
                        window.location.href = 'dashboard.html';
                        return;
                    }
                } catch (_) {}
                clearInterval(interval);
                setButtonLoading(false);
                showAlert('Sign in window was closed before finishing.');
            }, 500);
        }
    }, AUTH_POLL_INTERVAL_MS);
}

// Handle Guest / Demo Mode
function handleGuestDemo() {
    localStorage.setItem('pm_guest_mode', 'true');
    localStorage.setItem('pm_email', 'guest.builder@promptmemory.ai');
    localStorage.setItem('pm_user_id', 'guest_demo_user');
    window.location.href = 'dashboard.html';
}

googleBtn?.addEventListener('click', handleGoogleLogin);
demoBtn?.addEventListener('click', handleGuestDemo);
