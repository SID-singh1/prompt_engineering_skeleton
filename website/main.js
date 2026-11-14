// The landing page reads fully without JavaScript. This only adds the
// sticky-nav backdrop and swaps "Sign in" for "Dashboard" when signed in.
const nav = document.querySelector('.nav');
function updateNavigation() {
    if (nav) nav.classList.toggle('nav-scrolled', window.scrollY > 12);
}
window.addEventListener('scroll', updateNavigation, { passive: true });
updateNavigation();

let signedIn = false;
try {
    signedIn = Boolean(localStorage.getItem('pm_token')) || localStorage.getItem('pm_guest_mode') === 'true';
} catch {
    // Storage can be blocked; the page works the same signed out.
}

const navLoginLink = document.getElementById('nav-login-link');
if (signedIn && navLoginLink) {
    navLoginLink.textContent = 'Dashboard';
    navLoginLink.href = '/dashboard';
}
