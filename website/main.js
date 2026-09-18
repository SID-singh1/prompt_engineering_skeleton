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
const navCtaBtn = document.getElementById('nav-cta-btn');

if (token || isGuest) {
    if (navLoginLink) {
        navLoginLink.textContent = 'Dashboard';
        navLoginLink.href = 'dashboard.html';
    }
    if (navCtaBtn) {
        navCtaBtn.textContent = 'Launch App →';
        navCtaBtn.href = 'dashboard.html';
    }
}
