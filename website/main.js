// Keep the landing page readable immediately, including without JavaScript.
// Avoid hiding cards for decorative scroll effects or delaying installation.
const nav = document.querySelector('.nav');
function updateNavigation() {
    if (nav) nav.classList.toggle('nav-scrolled', window.scrollY > 100);
}
window.addEventListener('scroll', updateNavigation, { passive: true });
updateNavigation();

// ── Check Auth Session on Landing Page ──
const token = localStorage.getItem('pm_token');
const isGuest = localStorage.getItem('pm_guest_mode') === 'true';
const navLoginLink = document.getElementById('nav-login-link');

if ((token || isGuest) && navLoginLink) {
    navLoginLink.textContent = 'Dashboard';
    navLoginLink.href = 'dashboard.html';
}

// ── Where "Add to Chrome" goes ──
// The Chrome Web Store listing's URL, once it exists (an Unlisted listing has
// one too). Empty: every Add to Chrome button scrolls to the manual install
// steps. Set: they all go to the store, and the manual steps fold away.
const STORE_URL = '';

if (STORE_URL) {
    document.querySelectorAll('[data-store-link]').forEach((a) => {
        a.href = STORE_URL;
        a.target = '_blank';
        a.rel = 'noopener';
    });
    document.querySelectorAll('[data-store-hide]').forEach((el) => { el.hidden = true; });
    document.querySelectorAll('[data-store-show]').forEach((el) => { el.hidden = false; });
}
