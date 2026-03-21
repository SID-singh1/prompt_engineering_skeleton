// ════════════════════════════════════════════════════════════════
// Prompt Memory — Landing Page Interactions
// ════════════════════════════════════════════════════════════════

// ── Billing Toggle (Monthly ↔ Yearly) ──
const billingToggle = document.getElementById('billing-toggle');
const monthlyLabel = document.getElementById('toggle-monthly');
const yearlyLabel = document.getElementById('toggle-yearly');
let isYearly = false;

function updatePricing() {
    billingToggle.classList.toggle('yearly', isYearly);
    monthlyLabel.classList.toggle('active', !isYearly);
    yearlyLabel.classList.toggle('active', isYearly);

    document.querySelectorAll('.price-value[data-monthly]').forEach((el) => {
        const value = isYearly ? el.dataset.yearly : el.dataset.monthly;
        // Animate number change
        el.style.transform = 'translateY(-4px)';
        el.style.opacity = '0';
        setTimeout(() => {
            el.textContent = value;
            el.style.transform = 'translateY(4px)';
            requestAnimationFrame(() => {
                el.style.transform = 'translateY(0)';
                el.style.opacity = '1';
            });
        }, 150);
    });
}

billingToggle?.addEventListener('click', () => {
    isYearly = !isYearly;
    updatePricing();
});

monthlyLabel?.addEventListener('click', () => {
    if (isYearly) { isYearly = false; updatePricing(); }
});

yearlyLabel?.addEventListener('click', () => {
    if (!isYearly) { isYearly = true; updatePricing(); }
});

// Set initial state
monthlyLabel?.classList.add('active');

// ── Scroll-in Animations ──
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -40px 0px',
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
        }
    });
}, observerOptions);

// Add fade-in animation to cards
document.querySelectorAll('.step-card, .feature-card, .price-card').forEach((el, i) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = `opacity 0.5s ease ${i * 0.1}s, transform 0.5s ease ${i * 0.1}s`;
    observer.observe(el);
});

// CSS class for visible state
const style = document.createElement('style');
style.textContent = `
    .step-card.visible, .feature-card.visible, .price-card.visible {
        opacity: 1 !important;
        transform: translateY(0) !important;
    }
    .price-card-featured.visible {
        transform: scale(1.03) !important;
    }
`;
document.head.appendChild(style);

// ── Nav Background on Scroll ──
const nav = document.querySelector('.nav');
let lastScroll = 0;

window.addEventListener('scroll', () => {
    const scrollY = window.scrollY;
    if (scrollY > 100) {
        nav.style.borderBottomColor = 'rgba(255, 255, 255, 0.1)';
    } else {
        nav.style.borderBottomColor = 'rgba(255, 255, 255, 0.07)';
    }
    lastScroll = scrollY;
}, { passive: true });
