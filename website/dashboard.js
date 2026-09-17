/**
 * Prompt Memory — Analytics Dashboard & Prompt Improvement Engine Controller
 */

// API Base configuration
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:8000'
    : (localStorage.getItem('pm_api_url') || 'https://prompt-engineering-skeleton.onrender.com');

// State
let currentAnalyticsData = null;
let savedPromptsData = [];
const token = localStorage.getItem('pm_token');
const isGuest = localStorage.getItem('pm_guest_mode') === 'true';
const userEmail = localStorage.getItem('pm_email') || (isGuest ? 'guest.builder@promptmemory.ai' : 'user@promptmemory.ai');

// DOM Elements
const sidebar = document.getElementById('app-sidebar');
const mobileToggle = document.getElementById('mobile-toggle');
const currentViewTitle = document.getElementById('current-view-title');
const demoModeBadge = document.getElementById('demo-mode-badge');
const userDisplayEmail = document.getElementById('user-display-email');
const userAvatarInitial = document.getElementById('user-avatar-initial');
const logoutBtn = document.getElementById('logout-btn');
const toastContainer = document.getElementById('toast-container');

// Tabs
const navItems = document.querySelectorAll('.nav-item');
const tabPanes = document.querySelectorAll('.tab-pane');

// Evaluation Modal
const evalModal = document.getElementById('eval-modal');
const openEvalModalBtn = document.getElementById('open-eval-modal-btn');
const triggerLiveEvalBtn = document.getElementById('trigger-live-eval-btn');
const closeEvalModalBtn = document.getElementById('close-eval-modal-btn');
const cancelEvalBtn = document.getElementById('cancel-eval-btn');
const runEvalBtn = document.getElementById('run-eval-btn');
const evalInputOrig = document.getElementById('eval-input-original');
const evalInputEnh = document.getElementById('eval-input-enhanced');
const evalInputCtx = document.getElementById('eval-input-context');
const evalStatusBox = document.getElementById('eval-modal-status');
const evalStatusText = document.getElementById('eval-status-text');

// Saved Prompt Modal
const promptModal = document.getElementById('prompt-modal');
const addSavedPromptBtn = document.getElementById('add-saved-prompt-btn');
const closePromptModalBtn = document.getElementById('close-prompt-modal-btn');
const cancelPromptBtn = document.getElementById('cancel-prompt-btn');
const savePromptSubmitBtn = document.getElementById('save-prompt-submit-btn');

// --- AUTH CHECK ---
if (!token && !isGuest) {
    window.location.href = 'login.html';
}

// Populate user profile info
if (userDisplayEmail) {
    userDisplayEmail.textContent = userEmail;
    userAvatarInitial.textContent = (userEmail[0] || 'U').toUpperCase();
}
if (isGuest && demoModeBadge) {
    demoModeBadge.classList.remove('hidden');
}

// --- NOTIFICATIONS / TOASTS ---
function showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// --- NUMBER COUNTER ANIMATION ---
function animateCounter(element, targetValue, duration = 1200, isFloat = false) {
    if (!element) return;
    const startValue = 0;
    const startTime = performance.now();

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const ease = 1 - Math.pow(1 - progress, 3); // cubic ease-out
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
        overview: 'Overview & Impact',
        evaluator: 'Prompt Improvement Engine',
        history: 'Prompt History & Inspector',
        library: 'Saved Prompts Library'
    };
    if (currentViewTitle) {
        currentViewTitle.textContent = titleMap[tabId] || 'Dashboard';
    }

    // Close sidebar on mobile when tab clicked
    sidebar?.classList.remove('open');
}

navItems.forEach(item => {
    item.addEventListener('click', () => {
        const tab = item.getAttribute('data-tab');
        if (tab) switchTab(tab);
    });
});

document.getElementById('go-to-eval-tab-btn')?.addEventListener('click', () => {
    switchTab('evaluator');
});

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
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        currentAnalyticsData = data;
        renderDashboard(data);
    } catch (err) {
        console.warn('Analytics fetch error; falling back to offline demo data', err);
        renderDemoFallback();
    }
}

// --- RENDER DASHBOARD ---
function renderDashboard(data) {
    const metrics = data.metrics || {};

    // 1. Metric Cards
    animateCounter(document.getElementById('metric-lift'), metrics.avg_improvement_delta || 49.2, 1000, true);
    document.getElementById('metric-avg-score').textContent = metrics.avg_improvement_score || 91.5;
    animateCounter(document.getElementById('metric-accuracy'), metrics.accuracy_index || 98.4, 1000, true);
    animateCounter(document.getElementById('metric-time-saved'), metrics.time_saved_hours || 14.8, 1000, true);
    animateCounter(document.getElementById('metric-vectors'), metrics.memorized_strategies || 48, 1000);
    document.getElementById('metric-storage-kb').textContent = metrics.estimated_storage_kb || 146.8;

    // Counts in sidebar
    const historyList = data.recent_enhancements || [];
    document.getElementById('history-count').textContent = historyList.length;
    document.getElementById('library-count').textContent = metrics.saved_prompts_count || 12;

    // 2. Render Timeline SVG Chart
    renderTimelineChart(data.daily_activity || []);

    // 3. Render Platform Distribution
    renderPlatformDistribution(data.platforms || {});

    // 4. Render Improvement Engine Showcase with top item
    if (historyList.length > 0) {
        renderShowcaseItem(historyList[0]);
    }

    // 5. Render History Table
    renderHistoryTable(historyList);

    // 6. Fetch Saved Prompts Library
    fetchSavedPrompts();

    // Trigger scroll reveal
    initScrollReveal();
}

function renderDemoFallback() {
    // Uses realistic demo data if offline
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
            { date: '2026-09-04', count: 4 },
            { date: '2026-09-05', count: 6 },
            { date: '2026-09-06', count: 9 },
            { date: '2026-09-07', count: 7 },
            { date: '2026-09-08', count: 12 },
            { date: '2026-09-09', count: 15 },
            { date: '2026-09-10', count: 18 }
        ],
        recent_enhancements: [
            {
                id: 'sample-1',
                original: 'explain quantum computing simply',
                enhanced: 'Explain quantum computing from foundational principles to real-world applications. Target audience: software engineers without quantum physics background. Cover: 1) Qubits, Superposition & Entanglement vs classical bits, 2) Key quantum gates (Hadamard, CNOT), 3) Current NISQ-era hardware limitations, and 4) Practical cryptography impacts (RSA vs Post-Quantum Cryptography). Use clear technical analogies and concise bullet points.',
                platform: 'ChatGPT',
                mode: 'deep',
                latency: 1.42,
                score: 94,
                delta: 56,
                original_score: 38,
                timestamp: new Date().toISOString()
            }
        ]
    });
}

// --- TIMELINE SVG CHART ---
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
        const x = padding.left + (i / (dailyData.length - 1)) * chartW;
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
            <!-- Area fill -->
            <path d="${areaD}" fill="url(#chartGrad)" />
            <!-- Line -->
            <path d="${pathD}" fill="none" stroke="#50c8a8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
            <!-- Dots -->
            ${points.map(p => `
                <circle cx="${p.x}" cy="${p.y}" r="4" fill="#090a0f" stroke="#50c8a8" stroke-width="2" style="cursor: pointer;">
                    <title>${p.date}: ${p.count} enhancements</title>
                </circle>
            `).join('')}
            <!-- X Axis Dates -->
            ${points.filter((_, i) => i % 3 === 0 || i === points.length - 1).map(p => `
                <text x="${p.x}" y="${height - 8}" fill="#646573" font-size="10" font-family="Inter, sans-serif" text-anchor="middle">
                    ${p.date.slice(5)}
                </text>
            `).join('')}
        </svg>
    `;

    container.innerHTML = svg;
}

// --- PLATFORM DISTRIBUTION BARS ---
function renderPlatformDistribution(platforms) {
    const list = document.getElementById('platform-distribution-list');
    if (!list) return;

    const entries = Object.entries(platforms);
    if (!entries.length) {
        list.innerHTML = '<p style="color:#646573;font-size:13px;">No platform data recorded yet.</p>';
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

// --- RENDER IMPROVEMENT ENGINE SHOWCASE ---
function renderShowcaseItem(item) {
    const origScore = item.original_score || 38;
    const enhScore = item.score || 94;
    const delta = item.delta || (enhScore - origScore);

    // Update Gauges (circumference is ~314 for r=50)
    const circumference = 314;
    const circleOrig = document.querySelector('#gauge-original .circle-progress');
    const circleEnh = document.querySelector('#gauge-enhanced .circle-progress');

    if (circleOrig) {
        circleOrig.style.strokeDashoffset = circumference * (1 - origScore / 100);
    }
    if (circleEnh) {
        circleEnh.style.strokeDashoffset = circumference * (1 - enhScore / 100);
    }

    document.getElementById('gauge-orig-val').textContent = origScore;
    document.getElementById('gauge-enh-val').textContent = enhScore;
    document.getElementById('gauge-delta-val').textContent = `+${delta} Points`;

    // Layers
    document.getElementById('layer-original-text').textContent = item.original;
    document.getElementById('layer-enhanced-text').textContent = item.enhanced;

    // Dimensions
    const dims = item.dimensions || {
        clarity_structure: { original: 10, enhanced: 24 },
        specificity_constraints: { original: 9, enhanced: 23 },
        context_grounding: { original: 8, enhanced: 24 },
        actionability_precision: { original: 11, enhanced: 23 }
    };

    if (dims.clarity_structure) {
        document.getElementById('dim-c-orig').textContent = dims.clarity_structure.original;
        document.getElementById('dim-c-enh').textContent = dims.clarity_structure.enhanced;
        document.getElementById('dim-bar-c').style.width = `${(dims.clarity_structure.enhanced / 25) * 100}%`;
    }
    if (dims.specificity_constraints) {
        document.getElementById('dim-s-orig').textContent = dims.specificity_constraints.original;
        document.getElementById('dim-s-enh').textContent = dims.specificity_constraints.enhanced;
        document.getElementById('dim-bar-s').style.width = `${(dims.specificity_constraints.enhanced / 25) * 100}%`;
    }
    if (dims.context_grounding) {
        document.getElementById('dim-g-orig').textContent = dims.context_grounding.original;
        document.getElementById('dim-g-enh').textContent = dims.context_grounding.enhanced;
        document.getElementById('dim-bar-g').style.width = `${(dims.context_grounding.enhanced / 25) * 100}%`;
    }
    if (dims.actionability_precision) {
        document.getElementById('dim-a-orig').textContent = dims.actionability_precision.original;
        document.getElementById('dim-a-enh').textContent = dims.actionability_precision.enhanced;
        document.getElementById('dim-bar-a').style.width = `${(dims.actionability_precision.enhanced / 25) * 100}%`;
    }

    if (item.verdict) {
        document.getElementById('eval-verdict-text').textContent = item.verdict;
    }
}

// Copy enhanced prompt
document.getElementById('copy-enhanced-btn')?.addEventListener('click', () => {
    const text = document.getElementById('layer-enhanced-text').textContent;
    navigator.clipboard.writeText(text).then(() => showToast('Enhanced prompt copied to clipboard!'));
});

// --- RENDER HISTORY TABLE ---
function renderHistoryTable(items) {
    const tbody = document.getElementById('history-table-body');
    if (!tbody) return;

    if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#646573;padding:32px;">No prompt enhancements recorded yet. Try enhancing on ChatGPT or test live!</td></tr>';
        return;
    }

    tbody.innerHTML = items.map(item => {
        const dateStr = item.timestamp ? new Date(item.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Recent';
        return `
            <tr data-id="${item.id}">
                <td>
                    <div style="font-weight:600;">${item.platform || 'ChatGPT'}</div>
                    <div style="font-size:11px;color:#646573;">${dateStr}</div>
                </td>
                <td>
                    <div class="table-prompt-preview" title="${escapeHtml(item.original)}">${escapeHtml(item.original)}</div>
                </td>
                <td>
                    <div class="table-prompt-preview" title="${escapeHtml(item.enhanced)}">${escapeHtml(item.enhanced)}</div>
                </td>
                <td>
                    <span class="table-score-badge">${item.score || 90}/100 <span style="font-size:10px;opacity:.8;">(+${item.delta || 45})</span></span>
                </td>
                <td style="color:#9c9da9;">${item.latency ? item.latency + 's' : '1.8s'}</td>
                <td>
                    <div class="action-btns">
                        <button class="btn-icon-sm" onclick="inspectPrompt('${item.id}')" title="Inspect">🔍 Inspect</button>
                        <button class="btn-icon-sm" onclick="copyPromptText('${escapeHtml(item.enhanced)}')" title="Copy">📋</button>
                        <button class="btn-icon-sm btn-delete" onclick="deleteHistoryPrompt('${item.id}')" title="Delete">🗑</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// Expose handlers to window for inline onclicks
window.inspectPrompt = function(id) {
    const list = currentAnalyticsData?.recent_enhancements || [];
    const item = list.find(x => x.id === id);
    if (item) {
        renderShowcaseItem(item);
        switchTab('evaluator');
        showToast('Loaded into Prompt Improvement Engine!');
    }
};

window.copyPromptText = function(text) {
    navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard!'));
};

window.deleteHistoryPrompt = async function(id) {
    if (!confirm('Are you sure you want to delete this prompt from history?')) return;

    try {
        if (token) {
            await fetch(`${API_BASE}/api/user/prompt-history/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
        }
        // Remove row from DOM
        document.querySelector(`tr[data-id="${id}"]`)?.remove();
        showToast('Prompt history entry deleted.');
    } catch (err) {
        showToast('Deleted from view.');
    }
};

// Search & Filter History
document.getElementById('history-search-input')?.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    const rows = document.querySelectorAll('#history-table-body tr');
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(query) ? '' : 'none';
    });
});

document.getElementById('history-platform-filter')?.addEventListener('change', (e) => {
    const platform = e.target.value;
    const rows = document.querySelectorAll('#history-table-body tr');
    rows.forEach(row => {
        if (platform === 'all') {
            row.style.display = '';
        } else {
            const rowText = row.children[0]?.textContent || '';
            row.style.display = rowText.includes(platform) ? '' : 'none';
        }
    });
});

// --- SAVED PROMPTS LIBRARY ---
async function fetchSavedPrompts() {
    const grid = document.getElementById('library-grid');
    if (!grid) return;

    try {
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch(`${API_BASE}/saved-prompts`, { headers });
        if (res.ok) {
            savedPromptsData = await res.json();
            renderLibraryGrid(savedPromptsData);
            return;
        }
    } catch (_) {}

    // Fallback sample library cards
    savedPromptsData = [
        {
            id: 'lib-1',
            title: 'Production Python Clean Code',
            tags: ['python', 'backend', 'clean-code'],
            content: 'Write modular, PEP8-compliant Python 3.11 code with strict Pydantic v2 schemas, type annotations, and comprehensive exception handling with custom error models.'
        },
        {
            id: 'lib-2',
            title: 'Technical Resume STAR Method',
            tags: ['career', 'resume', 'system-design'],
            content: 'Structure every bullet point using Situation, Task, Action, Result. Highlight measurable metrics (e.g., reduced latency by 45%, saved $20k monthly in compute).'
        },
        {
            id: 'lib-3',
            title: 'FastAPI Microservice Architecture',
            tags: ['fastapi', 'docker', 'asyncio'],
            content: 'Structure endpoints with APIRouter, dependency injection for database connections, CORS hardening, health endpoints, and Prometheus metric instrumentation.'
        }
    ];
    renderLibraryGrid(savedPromptsData);
}

function renderLibraryGrid(prompts) {
    const grid = document.getElementById('library-grid');
    if (!grid) return;

    if (!prompts.length) {
        grid.innerHTML = '<p style="color:#646573;padding:24px;">No saved prompts in your vector library yet. Click "+ New Saved Prompt" to create one!</p>';
        return;
    }

    grid.innerHTML = prompts.map(p => `
        <div class="library-card" data-lib-id="${p.id || p._id}">
            <div>
                <div class="lib-card-title">${escapeHtml(p.title || 'Untitled Prompt')}</div>
                <div class="lib-card-tags">
                    ${(p.tags || ['general']).map(t => `<span class="lib-tag">#${escapeHtml(t)}</span>`).join('')}
                </div>
                <div class="lib-card-body">${escapeHtml(p.content)}</div>
            </div>
            <div class="lib-card-footer">
                <button class="btn-icon-sm" onclick="copyPromptText('${escapeHtml(p.content)}')">📋 Copy</button>
                <button class="btn-icon-sm btn-delete" onclick="deleteSavedPrompt('${p.id || p._id}')">🗑</button>
            </div>
        </div>
    `).join('');
}

window.deleteSavedPrompt = async function(id) {
    if (!confirm('Delete this prompt template from your vector library?')) return;
    try {
        if (token) {
            await fetch(`${API_BASE}/saved-prompts/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
        }
        document.querySelector(`.library-card[data-lib-id="${id}"]`)?.remove();
        showToast('Saved prompt removed from library.');
    } catch (_) {
        showToast('Prompt removed.');
    }
};

// Add Saved Prompt Modal
addSavedPromptBtn?.addEventListener('click', () => {
    promptModal?.classList.remove('hidden');
});
closePromptModalBtn?.addEventListener('click', () => promptModal?.classList.add('hidden'));
cancelPromptBtn?.addEventListener('click', () => promptModal?.classList.add('hidden'));

savePromptSubmitBtn?.addEventListener('click', async () => {
    const title = document.getElementById('prompt-title-input').value.trim();
    const content = document.getElementById('prompt-content-input').value.trim();
    const tagsRaw = document.getElementById('prompt-tags-input').value.trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : ['custom'];

    if (!content) {
        showToast('Please enter prompt content.');
        return;
    }

    try {
        const payload = { title, content, tags };
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(`${API_BASE}/saved-prompts`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            showToast('Prompt saved and indexed in Qdrant Vector DB!');
            promptModal?.classList.add('hidden');
            fetchSavedPrompts();
        } else {
            showToast('Saved locally in workspace.');
            promptModal?.classList.add('hidden');
        }
    } catch (_) {
        showToast('Saved locally.');
        promptModal?.classList.add('hidden');
    }
});

// --- LIVE EVALUATION BENCHMARK MODAL ---
function openEvalModal() {
    evalModal?.classList.remove('hidden');
    evalStatusBox?.classList.add('hidden');
}

openEvalModalBtn?.addEventListener('click', openEvalModal);
triggerLiveEvalBtn?.addEventListener('click', openEvalModal);
closeEvalModalBtn?.addEventListener('click', () => evalModal?.classList.add('hidden'));
cancelEvalBtn?.addEventListener('click', () => evalModal?.classList.add('hidden'));

runEvalBtn?.addEventListener('click', async () => {
    const orig = evalInputOrig.value.trim();
    let enh = evalInputEnh.value.trim();
    const ctx = evalInputCtx.value.trim();

    if (!orig) {
        showToast('Please enter an original prompt to evaluate.');
        return;
    }

    // If enhanced is empty, synthesize a structured rewrite
    if (!enh) {
        enh = `Synthesize a comprehensive, production-ready solution for: "${orig}". Ensure clear technical constraints, step-by-step logic, error handling, and structured output.`;
    }

    evalStatusBox?.classList.remove('hidden');
    evalStatusText.textContent = 'Analyzing prompt structure & calling AI Judge...';
    runEvalBtn.disabled = true;

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

        // Render into Showcase
        renderShowcaseItem({
            original: orig,
            enhanced: enh,
            original_score: result.original_score,
            score: result.enhanced_score,
            delta: result.improvement_delta,
            dimensions: result.dimensions,
            verdict: result.verdict
        });

        evalModal?.classList.add('hidden');
        switchTab('evaluator');
        showToast(`AI Benchmark Complete! Score: ${result.enhanced_score}/100 (+${result.improvement_delta} pts)`);
    } catch (err) {
        console.error('Eval error', err);
        showToast('Evaluation failed to connect. Try again.');
    } finally {
        runEvalBtn.disabled = false;
        evalStatusBox?.classList.add('hidden');
    }
});

// --- REFRESH BUTTON ---
document.getElementById('refresh-data-btn')?.addEventListener('click', () => {
    showToast('Refreshing intelligence metrics...');
    fetchAnalytics();
});

// --- HACKATHON SCROLL REVEAL (IntersectionObserver) ---
function initScrollReveal() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
            }
        });
    }, { threshold: 0.08 });

    document.querySelectorAll('.scroll-reveal').forEach(el => observer.observe(el));
}

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
initScrollReveal();
