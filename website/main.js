// Keep the landing page readable immediately, including without JavaScript.
// Avoid hiding cards for decorative scroll effects or delaying installation.
const nav = document.querySelector('.nav');
function updateNavigation() {
    if (nav) nav.classList.toggle('nav-scrolled', window.scrollY > 100);
}
window.addEventListener('scroll', updateNavigation, { passive: true });
updateNavigation();
