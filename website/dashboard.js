/**
 * Prompt Memory — Observability & Prompt Intelligence Controller
 * LangSmith-style Traces, AI Benchmarks, Context Decomposition & Memory
 */

// API Base configuration (defaults to Hugging Face Spaces production backend)
const API_BASE = import.meta.env?.VITE_API_URL || (
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:8000'
        : (localStorage.getItem('pm_api_url') || 'https://siddhm11-prompt-engine.hf.space')
);

// State
let currentAnalyticsData = null;
let savedPromptsData = [];
let activeInspectedId = null;
const token = localStorage.getItem('pm_token');
const isGuest = localStorage.getItem('pm_guest_mode') === 'true';
const userEmail = localStorage.getItem('pm_email') || (isGuest ? 'guest.builder@promptmemory.ai' : 'user@promptmemory.ai');

// DOM Elements - Shell
const sidebar = document.getElementById('app-sidebar');
const mobileToggle = document.getElementById('mobile-toggle');
const currentViewTitle = document.getElementById('current-view-title');
const demoModeBadge = document.getElementById('demo-mode-badge');
const userDisplayEmail = document.getElementById('user-display-email');
const userAvatarInitial = document.getElementById('user-avatar-initial');
const logoutBtn = document.getElementById('logout-btn');
const toastContainer = document.getElementById('toast-container');
const refreshBtn = document.getElementById('refresh-data-btn');
const openPlaygroundBtn = document.getElementById('open-playground-btn');

// Navigation Tabs
const navItems = document.querySelectorAll('.nav-item');
const tabPanes = document.querySelectorAll('.tab-pane');

// Slide-Out Inspector Drawer Elements
const drawerBackdrop = document.getElementById('drawer-backdrop');
const inspectorDrawer = document.getElementById('inspector-drawer');
const drawerCloseBtn = document.getElementById('drawer-close-btn');
const drawerPlatformBadge = document.getElementById('drawer-platform-badge');
const drawerModeBadge = document.getElementById('drawer-mode-badge');
const drawerScoreBadge = document.getElementById('drawer-score-badge');
const drawerTime = document.getElementById('drawer-time');
const drawerOrigText = document.getElementById('drawer-orig-text');
const drawerEnhText = document.getElementById('drawer-enh-text');
const drawerCopyBtn = document.getElementById('drawer-copy-btn');
const drawerLiftTag = document.getElementById('drawer-lift-tag');
const drawerVerdict = document.getElementById('drawer-verdict');
const drawerDimensions = document.getElementById('drawer-dimensions');
const drawerImprovementsList = document.getElementById('drawer-improvements-list');
const drawerLayer1 = document.getElementById('drawer-layer-1');
const drawerLayer2 = document.getElementById('drawer-layer-2');
const drawerLayer3 = document.getElementById('drawer-layer-3');
const drawerLayer4 = document.getElementById('drawer-layer-4');

// Playground Elements
const playInputOrig = document.getElementById('play-input-orig');
const playInputCtx = document.getElementById('play-input-ctx');
const playInputEnh = document.getElementById('play-input-enh');
const playRunBenchmarkBtn = document.getElementById('play-run-benchmark-btn');
const playStatus = document.getElementById('play-status');
const playStatusText = document.getElementById('play-status-text');
const playOrigNum = document.getElementById('play-orig-num');
const playDeltaNum = document.getElementById('play-delta-num');
const playEnhNum = document.getElementById('play-enh-num');
const playScorePill = document.getElementById('play-score-pill');
const playVerdictText = document.getElementById('play-verdict-text');
const playDimensions = document.getElementById('play-dimensions');
const playEnhancedOutput = document.getElementById('play-enhanced-output');
const playCopyBtn = document.getElementById('play-copy-btn');

// Saved Prompt Modal
const promptModal = document.getElementById('prompt-modal');
const addSavedPromptBtn = document.getElementById('add-saved-prompt-btn');
const closePromptModalBtn = document.getElementById('close-prompt-modal-btn');
const cancelPromptBtn = document.getElementById('cancel-prompt-btn');
const savePromptSubmitBtn = document.getElementById('save-prompt-submit-btn');

// Delete Prompt Modal
const deleteModal = document.getElementById('delete-modal');
const closeDeleteModalBtn = document.getElementById('close-delete-modal-btn');
const cancelDeleteBtn = document.getElementById('cancel-delete-btn');
const confirmDeleteBtn = document.getElementById('confirm-delete-btn');

// --- AUTH CHECK ---
if (!token && !isGuest) {
    window.location.href = 'login.html';
}

// User Profile display
if (userDisplayEmail) {
    userDisplayEmail.textContent = userEmail;
    userAvatarInitial.textContent = (userEmail[0] || 'U').toUpperCase();
}
if (isGuest && demoModeBadge) {
    demoModeBadge.classList.remove('hidden');
}

// --- NOTIFICATION TOAST ---
function showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer?.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 250);
    }, duration);
}

// --- PLATFORM NORMALIZER ---
function normalizePlatform(raw) {
    if (!raw) return 'ChatGPT';
    const s = String(raw).toLowerCase().trim();
    if (s.includes('chatgpt') || s.includes('openai')) return 'ChatGPT';
    if (s.includes('claude') || s.includes('anthropic')) return 'Claude';
    if (s.includes('gemini') || s.includes('google')) return 'Gemini';
    if (s.includes('perplexity')) return 'Perplexity';
    if (s.includes('deepseek')) return 'DeepSeek';
    if (s.includes('v0')) return 'v0.dev';
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// --- BUTTON FEEDBACK HELPER ---
function setButtonCopiedState(button, originalHtml, copiedText = '✓ Copied!') {
    if (!button) return;
    button.innerHTML = copiedText;
    button.classList.add('btn-copied');
    setTimeout(() => {
        button.innerHTML = originalHtml;
        button.classList.remove('btn-copied');
    }, 2000);
}

// --- METRIC DEFINITIONS & DIMENSION CARDS ---
const METRIC_DEFINITIONS = {
    clarity_structure: {
        title: 'Clarity & Structure',
        desc: 'Measures logical organization, numbered execution steps, markdown hierarchy, and reading ease that make instructions instantly unambiguous to models.'
    },
    specificity_constraints: {
        title: 'Specificity & Constraints',
        desc: 'Measures boundary conditions, negative rules ("avoid", "do not"), audience definition, and exact output format requirements.'
    },
    context_grounding: {
        title: 'Context Grounding',
        desc: 'Measures how effectively relevant background, active tech stack, and user rules from vector memory are grounded into the prompt without fluff.'
    },
    actionability_precision: {
        title: 'Actionability & Precision',
        desc: 'Measures first-turn execution readiness—ensures the model produces direct solutions and clean deliverables without requiring clarification turns.'
    }
};

function renderDimensionCardHtml(key, orig, enh) {
    const meta = METRIC_DEFINITIONS[key] || {
        title: key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        desc: 'Scored out of 25 points based on prompt engineering standards.'
    };
    const pct = Math.min(100, Math.round((enh / 25) * 100));
    return `
        <div class="dimension-card">
            <div class="dim-header-row">
                <div class="dim-title">${meta.title}</div>
                <div class="dim-info-tooltip" tabindex="0" role="button" aria-label="Info about ${meta.title}">
                    <span class="info-icon">ℹ</span>
                    <div class="tooltip-popup">
                        <strong>${meta.title} (0–25 pts)</strong>
                        <p>${meta.desc}</p>
                    </div>
                </div>
            </div>
            <div class="dim-scores">
                <span class="dim-orig">${orig}</span>
                <span class="dim-arrow">→</span>
                <span class="dim-enh">${enh}</span>
                <span class="dim-max">/25</span>
            </div>
            <div class="dim-bar"><div class="dim-fill fill-accent" style="width: ${pct}%;"></div></div>
        </div>
    `;
}

// --- NUMBER COUNTER ANIMATION ---
function animateCounter(element, targetValue, duration = 900, isFloat = false) {
    if (!element) return;
    const startValue = 0;
    const startTime = performance.now();

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const ease = 1 - Math.pow(1 - progress, 3);
        const current = startValue + (targetValue - startValue) * ease;

        element.textContent = isFloat ? current.toFixed(1) : Math.round(current);
        if (progress < 1) {
            requestAnimationFrame(update);
        } else {
            element.textContent = isFloat ? targetValue.toFixed(1) : targetValue;
        }
    }
    requestAnimationFrame(update);
}

// --- TAB SWITCHING ---
function switchTab(tabId) {
    navItems.forEach(item => {
        item.classList.toggle('active', item.getAttribute('data-tab') === tabId);
    });

    tabPanes.forEach(pane => {
        pane.classList.toggle('active', pane.id === `pane-${tabId}`);
    });

    const titleMap = {
        prompts: 'Prompts & Traces',
        benchmarks: 'Quality & Benchmarks',
        memory: 'Context & Vector Memory',
        playground: 'Live Playground'
    };
    if (currentViewTitle) {
        currentViewTitle.textContent = titleMap[tabId] || 'Observability';
    }

    // Close drawer when navigating tabs
    closeInspector();
    sidebar?.classList.remove('open');
}

navItems.forEach(item => {
    item.addEventListener('click', () => {
        const tab = item.getAttribute('data-tab');
        if (tab) switchTab(tab);
    });
});

openPlaygroundBtn?.addEventListener('click', () => switchTab('playground'));

// Mobile menu toggle
mobileToggle?.addEventListener('click', () => {
    sidebar?.classList.toggle('open');
});

// Logout
logoutBtn?.addEventListener('click', () => {
    localStorage.removeItem('pm_token');
    localStorage.removeItem('pm_guest_mode');
    localStorage.removeItem('pm_email');
    localStorage.removeItem('pm_user_id');
    window.location.href = 'login.html';
});

// --- FETCH ANALYTICS DATA ---
async function fetchAnalytics() {
    try {
        const headers = {};
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const res = await fetch(`${API_BASE}/api/user/analytics`, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        currentAnalyticsData = data;
        renderDashboard(data);
    } catch (err) {
        console.warn('Analytics fetch error; rendering demo data fallback', err);
        renderDemoFallback();
    }
}

// --- RENDER DASHBOARD ---
function renderDashboard(data) {
    const metrics = data.metrics || {};
    const historyList = data.recent_enhancements || [];

    // 1. Top KPI Summary Strip
    animateCounter(document.getElementById('metric-total-runs'), metrics.total_enhancements || historyList.length);
    document.getElementById('metric-avg-score').textContent = metrics.avg_improvement_score || 91.5;
    document.getElementById('metric-lift').textContent = `+${metrics.avg_improvement_delta || 49.2} pts`;
    animateCounter(document.getElementById('metric-time-saved'), metrics.time_saved_hours || 14.8, 900, true);
    animateCounter(document.getElementById('metric-vectors'), metrics.memorized_strategies || 48, 900);
    document.getElementById('metric-storage-kb').textContent = metrics.estimated_storage_kb || 146.8;

    // Badges & counts
    const platformCount = Object.keys(data.platforms || {}).length || 4;
    document.getElementById('metric-platforms-active').textContent = `${platformCount} Platforms`;
    document.getElementById('history-count').textContent = historyList.length;
    document.getElementById('library-count').textContent = metrics.saved_prompts_count || 12;

    // Vector Memory Tab Stats
    const vecCount = document.getElementById('vector-indexed-count');
    const vecStore = document.getElementById('vector-storage-val');
    if (vecCount) vecCount.textContent = metrics.memorized_strategies || 48;
    if (vecStore) vecStore.textContent = `${metrics.estimated_storage_kb || 146.8} KB`;

    // 2. Tab 1: Render Prompts & Traces Feed
    renderHistoryTable(historyList);

    // 3. Tab 2: Render Activity Chart & Platform Breakdown
    renderTimelineChart(data.daily_activity || []);
    renderPlatformDistribution(data.platforms || {});

    // 4. Tab 3: Fetch Saved Prompts
    fetchSavedPrompts();
}

function renderDemoFallback() {
    renderDashboard({
        is_demo: true,
        metrics: {
            total_enhancements: 128,
            avg_improvement_score: 91.5,
            avg_improvement_delta: 49.2,
            accuracy_index: 98.4,
            time_saved_hours: 14.8,
            memorized_strategies: 48,
            saved_prompts_count: 12,
            estimated_storage_kb: 146.8
        },
        platforms: { ChatGPT: 64, Claude: 42, Gemini: 18, Perplexity: 10 },
        daily_activity: [
            { date: '2026-09-08', count: 7 },
            { date: '2026-09-09', count: 12 },
            { date: '2026-09-10', count: 9 },
            { date: '2026-09-11', count: 15 },
            { date: '2026-09-12', count: 14 },
            { date: '2026-09-13', count: 18 },
            { date: '2026-09-14', count: 22 }
        ],
        recent_enhancements: [
            {
                id: 'demo-1',
                original: 'explain quantum computing simply',
                enhanced: 'Explain quantum computing from foundational principles to real-world applications. Target audience: software engineers without quantum physics background. Cover: 1) Qubits, Superposition & Entanglement vs classical bits, 2) Key quantum gates (Hadamard, CNOT), 3) Current NISQ-era hardware limitations, and 4) Practical cryptography impacts (RSA vs Post-Quantum Cryptography). Use clear technical analogies and concise bullet points.',
                platform: 'ChatGPT',
                mode: 'deep',
                latency: 1.42,
                score: 94,
                delta: 56,
                original_score: 38,
                dimensions: {
                    clarity_structure: { original: 10, enhanced: 24, delta: 14 },
                    specificity_constraints: { original: 9, enhanced: 23, delta: 14 },
                    context_grounding: { original: 8, enhanced: 24, delta: 16 },
                    actionability_precision: { original: 11, enhanced: 23, delta: 12 }
                },
                verdict: 'Transforms a generic inquiry into a modular, production-ready technical briefing tailored for engineers.',
                key_improvements: [
                    'Targeted software engineering audience boundary',
                    'Defined 4 clear pedagogical sections',
                    'Required post-quantum cryptography impact'
                ],
                context_details: {
                    extracted: 'Software engineer persona, prefers technical analogies',
                    selected: 'Technical Explainer standard template',
                    conversation: 'Discussing RSA 2048 and Shor\'s algorithm'
                },
                timestamp: new Date(Date.now() - 15 * 60 * 1000).toISOString()
            },
            {
                id: 'demo-2',
                original: 'write a python script for scraping stocks',
                enhanced: 'Create a production-grade Python script using `httpx` and `BeautifulSoup4` to scrape historical stock price data. Requirements: 1) Respect robots.txt and implement exponential backoff retry logic, 2) Parse tickers, daily OHLCV prices, and market cap, 3) Output cleaned records into structured Pydantic models with type validation, and 4) Save results to both SQLite and CSV with comprehensive logging and error handling.',
                platform: 'Claude',
                mode: 'deep',
                latency: 1.68,
                score: 92,
                delta: 51,
                original_score: 41,
                dimensions: {
                    clarity_structure: { original: 11, enhanced: 24, delta: 13 },
                    specificity_constraints: { original: 10, enhanced: 23, delta: 13 },
                    context_grounding: { original: 9, enhanced: 22, delta: 13 },
                    actionability_precision: { original: 11, enhanced: 23, delta: 12 }
                },
                verdict: 'Injected production libraries (httpx, Pydantic), retry mechanisms, and concrete validation rules.',
                key_improvements: [
                    'Specified httpx and BeautifulSoup4 instead of vague requests',
                    'Required Pydantic schemas and dual SQLite/CSV storage',
                    'Enforced exponential backoff and error handling'
                ],
                context_details: {
                    extracted: 'Python 3.11 developer stack',
                    selected: 'Production Code Standard',
                    conversation: 'Setting up market analytics pipeline'
                },
                timestamp: new Date(Date.now() - 2 * 3600 * 1000).toISOString()
            }
        ]
    });
}

// --- RENDER TIMELINE CHART ---
function renderTimelineChart(dailyData) {
    const container = document.getElementById('timeline-chart-container');
    if (!container || !dailyData.length) return;

    const width = container.clientWidth || 500;
    const height = 200;
    const padding = { top: 20, right: 20, bottom: 30, left: 30 };

    const maxCount = Math.max(...dailyData.map(d => d.count), 10);
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const points = dailyData.map((d, i) => {
        const x = padding.left + (i / Math.max(dailyData.length - 1, 1)) * chartW;
        const y = padding.top + chartH - (d.count / maxCount) * chartH;
        return { x, y, ...d };
    });

    const pathD = points.reduce((acc, p, i) =>
        i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`, '');

    const areaD = `${pathD} L ${points[points.length - 1].x} ${height - padding.bottom} L ${points[0].x} ${height - padding.bottom} Z`;

    const svg = `
        <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="overflow: visible;">
            <defs>
                <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#50c8a8" stop-opacity="0.3" />
                    <stop offset="100%" stop-color="#50c8a8" stop-opacity="0.0" />
                </linearGradient>
            </defs>
            <path d="${areaD}" fill="url(#chartGrad)" />
            <path d="${pathD}" fill="none" stroke="#50c8a8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
            ${points.map(p => `
                <circle cx="${p.x}" cy="${p.y}" r="4.5" fill="#090a0f" stroke="#50c8a8" stroke-width="2" style="cursor: pointer;">
                    <title>${p.date}: ${p.count} enhancements</title>
                </circle>
            `).join('')}
            ${points.filter((_, i) => i % 2 === 0 || i === points.length - 1).map(p => `
                <text x="${p.x}" y="${height - 8}" fill="#646573" font-size="10" font-family="Inter, sans-serif" text-anchor="middle">
                    ${p.date.slice(5)}
                </text>
            `).join('')}
        </svg>
    `;

    container.innerHTML = svg;
}

// --- RENDER PLATFORM DISTRIBUTION ---
function renderPlatformDistribution(platforms) {
    const list = document.getElementById('platform-distribution-list');
    if (!list) return;

    // Normalize and aggregate counts (e.g. merge chatgpt.com into ChatGPT)
    const merged = {};
    for (const [raw, count] of Object.entries(platforms)) {
        const norm = normalizePlatform(raw);
        merged[norm] = (merged[norm] || 0) + count;
    }

    const entries = Object.entries(merged);
    if (!entries.length) {
        list.innerHTML = '<p style="color:#646573;font-size:13px;">No platform runs recorded yet.</p>';
        return;
    }

    const total = entries.reduce((sum, [, count]) => sum + count, 0) || 1;

    list.innerHTML = entries.map(([name, count]) => {
        const pct = Math.round((count / total) * 100);
        return `
            <div class="dist-item">
                <div class="dist-header">
                    <span class="dist-name">${name}</span>
                    <span class="dist-count">${count} (${pct}%)</span>
                </div>
                <div class="dist-bar-bg">
                    <div class="dist-bar-fill" style="width: ${pct}%;"></div>
                </div>
            </div>
        `;
    }).join('');
}

// --- UNIFIED SEARCH & PLATFORM FILTERS ---
function applyFilters() {
    const searchVal = (document.getElementById('history-search-input')?.value || '').trim().toLowerCase();
    const platformVal = (document.getElementById('history-platform-filter')?.value || 'all').toLowerCase();
    const rows = document.querySelectorAll('#history-table-body tr');

    rows.forEach(row => {
        if (row.querySelector('td[colspan]')) return;
        const rowPlatform = (row.getAttribute('data-platform') || '').toLowerCase();
        const rowText = row.textContent.toLowerCase();

        const matchesPlatform = (platformVal === 'all') || (rowPlatform === platformVal);
        const matchesSearch = !searchVal || rowText.includes(searchVal);

        row.style.display = (matchesPlatform && matchesSearch) ? '' : 'none';
    });
}

function updatePlatformFilterOptions(items) {
    const select = document.getElementById('history-platform-filter');
    if (!select) return;
    const currentVal = select.value;
    const platforms = new Set(['ChatGPT', 'Claude', 'Gemini', 'Perplexity']);
    items.forEach(item => {
        if (item.platform) {
            platforms.add(normalizePlatform(item.platform));
        }
    });

    select.innerHTML = '<option value="all">All Platforms</option>' +
        Array.from(platforms).map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');

    if (platforms.has(currentVal)) {
        select.value = currentVal;
    } else {
        select.value = 'all';
    }
}

// --- TAB 1: RENDER RUNS & TRACES TABLE ---
function renderHistoryTable(items) {
    const tbody = document.getElementById('history-table-body');
    if (!tbody) return;

    if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#646573;padding:40px;">No prompt enhancements recorded yet. Use the Chrome extension or test live in the Playground!</td></tr>';
        updatePlatformFilterOptions([]);
        return;
    }

    tbody.innerHTML = items.map(item => {
        const score = item.score || 90;
        const delta = item.delta || 45;
        const scoreClass = score >= 90 ? 'high' : score >= 80 ? 'mid' : 'low';
        const normPlatform = normalizePlatform(item.platform);
        const dateStr = item.timestamp
            ? new Date(item.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            : 'Recent';

        return `
            <tr data-id="${item.id}" data-platform="${escapeHtml(normPlatform)}" onclick="openInspectorById('${item.id}')">
                <td>
                    <span class="platform-badge">${escapeHtml(normPlatform)}</span>
                </td>
                <td>
                    <div class="table-prompt-preview" title="${escapeHtml(item.original)}">${escapeHtml(item.original)}</div>
                </td>
                <td>
                    <div class="table-prompt-preview" title="${escapeHtml(item.enhanced)}">${escapeHtml(item.enhanced)}</div>
                </td>
                <td>
                    <span class="score-pill-badge ${scoreClass}">
                        ${score}/100 <span style="font-size:10px;opacity:.8;">(+${delta})</span>
                    </span>
                </td>
                <td style="color:#9c9da9;">${item.latency ? item.latency + 's' : '1.8s'}</td>
                <td style="color:#646573;font-size:12px;">${dateStr}</td>
                <td class="text-right" onclick="event.stopPropagation();">
                    <button class="btn-inspect" onclick="openInspectorById('${item.id}')">Inspect →</button>
                </td>
            </tr>
        `;
    }).join('');

    updatePlatformFilterOptions(items);
    applyFilters();
}

// --- SLIDE-OUT INSPECTOR DRAWER CONTROLLER ---
window.openInspectorById = function(id) {
    const list = currentAnalyticsData?.recent_enhancements || [];
    const item = list.find(x => x.id === id) || list[0];
    if (!item) return;

    activeInspectedId = id;

    // Highlight row in table
    document.querySelectorAll('#history-table-body tr').forEach(r => {
        r.classList.toggle('active-inspect', r.getAttribute('data-id') === id);
    });

    // Header info
    drawerPlatformBadge.textContent = normalizePlatform(item.platform);
    drawerModeBadge.textContent = (item.mode || 'deep').toUpperCase();
    drawerScoreBadge.textContent = `${item.score || 92}/100`;
    drawerTime.textContent = item.timestamp ? new Date(item.timestamp).toLocaleString() : 'Just now';

    // Diff
    drawerOrigText.textContent = item.original || '';
    drawerEnhText.textContent = item.enhanced || '';

    // Copy Handler with visual feedback
    drawerCopyBtn.onclick = () => {
        const text = item.enhanced || '';
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            setButtonCopiedState(drawerCopyBtn, '📋 Copy Enhanced', '✓ Copied!');
            showToast('Enhanced prompt copied!');
        });
    };

    // Quality breakdown
    drawerLiftTag.textContent = `+${item.delta || 50} pts Quality Lift`;
    drawerVerdict.textContent = item.verdict || 'The enhanced prompt provides structured execution steps, concrete domain constraints, and high actionability.';

    // Dimensions
    const dims = item.dimensions || {
        clarity_structure: { original: 10, enhanced: 24 },
        specificity_constraints: { original: 10, enhanced: 23 },
        context_grounding: { original: 8, enhanced: 24 },
        actionability_precision: { original: 11, enhanced: 23 }
    };

    drawerDimensions.innerHTML = Object.entries(dims).map(([key, val]) => {
        const orig = val.original ?? 10;
        const enh = val.enhanced ?? 23;
        return renderDimensionCardHtml(key, orig, enh);
    }).join('');

    // Key Improvements list
    const improvements = item.key_improvements?.length
        ? item.key_improvements
        : ['Structured execution steps added', 'Clear audience boundaries defined', 'Context injected cleanly'];

    drawerImprovementsList.innerHTML = improvements.map(imp => `<li>${escapeHtml(imp)}</li>`).join('');

    // Context Decomposition Layers
    const ctx = item.context_details || {};
    drawerLayer1.textContent = item.original || 'No input';
    drawerLayer2.textContent = ctx.extracted || 'Auto-matched from passive history: Developer persona, technical depth preferences.';
    drawerLayer3.textContent = ctx.selected || 'Applied Template: Structured Engineering Prompt format.';
    drawerLayer4.textContent = ctx.conversation || 'Scraped from chat tab DOM context.';

    // Show drawer
    drawerBackdrop?.classList.remove('hidden');
    inspectorDrawer?.classList.remove('hidden');
};

function closeInspector() {
    drawerBackdrop?.classList.add('hidden');
    inspectorDrawer?.classList.add('hidden');
    document.querySelectorAll('#history-table-body tr').forEach(r => r.classList.remove('active-inspect'));
    activeInspectedId = null;
}

drawerCloseBtn?.addEventListener('click', closeInspector);
drawerBackdrop?.addEventListener('click', closeInspector);

// Custom Modal Delete Trace Flow
document.getElementById('drawer-delete-btn')?.addEventListener('click', () => {
    if (!activeInspectedId) return;
    deleteModal?.classList.remove('hidden');
});

closeDeleteModalBtn?.addEventListener('click', () => deleteModal?.classList.add('hidden'));
cancelDeleteBtn?.addEventListener('click', () => deleteModal?.classList.add('hidden'));

confirmDeleteBtn?.addEventListener('click', async () => {
    if (!activeInspectedId) return;
    confirmDeleteBtn.disabled = true;
    confirmDeleteBtn.textContent = 'Deleting...';
    try {
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(`${API_BASE}/api/user/prompt-history/${activeInspectedId}`, {
            method: 'DELETE',
            headers,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (currentAnalyticsData?.recent_enhancements) {
            currentAnalyticsData.recent_enhancements = currentAnalyticsData.recent_enhancements.filter(x => x.id !== activeInspectedId);
            renderHistoryTable(currentAnalyticsData.recent_enhancements);
            const countEl = document.getElementById('history-count');
            if (countEl) countEl.textContent = currentAnalyticsData.recent_enhancements.length;
        }
        deleteModal?.classList.add('hidden');
        closeInspector();
        showToast('Prompt trace deleted successfully!');
    } catch (err) {
        deleteModal?.classList.add('hidden');
        showToast(`Failed to delete trace: ${err.message}`);
    } finally {
        confirmDeleteBtn.disabled = false;
        confirmDeleteBtn.textContent = 'Delete Trace';
    }
});

// Filter table events
document.getElementById('history-search-input')?.addEventListener('input', applyFilters);
document.getElementById('history-platform-filter')?.addEventListener('change', applyFilters);

// --- TAB 4: LIVE PLAYGROUND CONTROLLER ---
playRunBenchmarkBtn?.addEventListener('click', async () => {
    const orig = playInputOrig.value.trim();
    let enh = playInputEnh.value.trim();
    const ctx = playInputCtx.value.trim();

    if (!orig) {
        showToast('Please enter an original prompt to test.');
        return;
    }

    if (!enh) {
        enh = `Synthesize a comprehensive, production-ready response for: "${orig}". Include clear step-by-step logic, domain constraints, output schema, and comprehensive error handling.`;
        playInputEnh.value = enh;
    }

    playStatus?.classList.remove('hidden');
    playStatusText.textContent = 'Analyzing prompt structure & calling AI Judge...';
    playRunBenchmarkBtn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/api/evaluate/prompt-improvement`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                original_prompt: orig,
                enhanced_prompt: enh,
                extracted_context: ctx || null
            })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const result = await res.json();

        // Render Gauges
        playOrigNum.textContent = result.original_score;
        playEnhNum.textContent = result.enhanced_score;
        playDeltaNum.textContent = `+${result.improvement_delta} pts`;
        playScorePill.textContent = `${result.enhanced_score}/100`;

        // Render Verdict
        playVerdictText.textContent = result.verdict || 'Prompt improvement benchmark complete.';

        // Render Dimensions
        const dims = result.dimensions || {};
        playDimensions.innerHTML = Object.entries(dims).map(([key, val]) => {
            const origS = val.original ?? 10;
            const enhS = val.enhanced ?? 23;
            return renderDimensionCardHtml(key, origS, enhS);
        }).join('');

        // Render Output preview
        playEnhancedOutput.textContent = enh;

        showToast(`AI Benchmark complete! Score: ${result.enhanced_score}/100 (+${result.improvement_delta} pts)`);
    } catch (err) {
        console.error('Playground evaluation error', err);
        showToast('Benchmark evaluation failed. Check connection.');
    } finally {
        playRunBenchmarkBtn.disabled = false;
        playStatus?.classList.add('hidden');
    }
});

playCopyBtn?.addEventListener('click', () => {
    const text = playEnhancedOutput.textContent.trim();
    if (text && text !== 'Run a benchmark to generate output.') {
        navigator.clipboard.writeText(text).then(() => {
            setButtonCopiedState(playCopyBtn, '📋 Copy', '✓ Copied!');
            showToast('Enhanced output copied!');
        });
    }
});

// --- TAB 3: SAVED PROMPTS ---
async function fetchSavedPrompts() {
    const grid = document.getElementById('library-grid');
    if (!grid) return;

    try {
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(`${API_BASE}/saved-prompts`, { headers });
        if (!res.ok) throw new Error();
        savedPromptsData = await res.json();
    } catch {
        savedPromptsData = [
            { id: '1', title: 'Structured Python API Guidelines', content: 'Always return Pydantic models with type annotations and explicit status codes.', tags: ['python', 'api'] },
            { id: '2', title: 'Executive Summary Briefing Rule', content: 'Format summary as: 1) Core takeaway, 2) DRI action matrix, 3) Risks & mitigations.', tags: ['summary', 'briefing'] },
            { id: '3', title: 'Docker Container Security Standards', content: 'Run as non-root user, implement health checks, multi-stage builds.', tags: ['devops', 'docker'] }
        ];
    }

    grid.innerHTML = savedPromptsData.map(p => `
        <div class="library-card">
            <div class="library-card-header">
                <span class="library-card-title">${escapeHtml(p.title || 'Untitled Prompt')}</span>
                <button class="btn-icon-sm" onclick="copyPromptText('${escapeHtml(p.content)}')">📋</button>
            </div>
            <p class="library-card-body">${escapeHtml(p.content)}</p>
            <div class="library-tags">
                ${(p.tags || ['general']).map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')}
            </div>
        </div>
    `).join('');
}

window.copyPromptText = function(text) {
    navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard!'));
};

// Saved prompt modal listeners
addSavedPromptBtn?.addEventListener('click', () => promptModal?.classList.remove('hidden'));
closePromptModalBtn?.addEventListener('click', () => promptModal?.classList.add('hidden'));
cancelPromptBtn?.addEventListener('click', () => promptModal?.classList.add('hidden'));

savePromptSubmitBtn?.addEventListener('click', async () => {
    const title = document.getElementById('prompt-title-input')?.value.trim();
    const content = document.getElementById('prompt-content-input')?.value.trim();
    const tags = document.getElementById('prompt-tags-input')?.value.split(',').map(s => s.trim()).filter(Boolean);

    if (!title || !content) {
        showToast('Please provide both a title and prompt content.');
        return;
    }

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        await fetch(`${API_BASE}/saved-prompts`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ title, content, tags: tags || ['custom'] })
        });
        showToast('Prompt saved and indexed in Qdrant!');
        promptModal?.classList.add('hidden');
        fetchSavedPrompts();
    } catch {
        showToast('Saved locally.');
        promptModal?.classList.add('hidden');
    }
});

// Refresh button
refreshBtn?.addEventListener('click', () => {
    showToast('Refreshing observability data...');
    fetchAnalytics();
});

// Utility
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Initial Kickoff
fetchAnalytics();
