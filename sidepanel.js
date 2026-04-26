'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────

/** Characters sent to the AI platform (truncated if longer). */
const MAX_CONTENT_CHARS = 20_000;

/** Platform display names. */
const PLATFORM_LABELS = {
  chatgpt:    'ChatGPT',
  claude:     'Claude',
  gemini:     'Gemini',
  perplexity: 'Perplexity',
};

/** Platform URLs. */
const AI_URLS = {
  chatgpt:    'https://chatgpt.com',
  claude:     'https://claude.ai',
  gemini:     'https://gemini.google.com',
  perplexity: 'https://www.perplexity.ai',
};

/** Milliseconds to wait after tab "complete" before injecting. */
const INJECT_DELAY_MS = 2800;

// ─── State ────────────────────────────────────────────────────────────────────

let entries    = [];
let expandedId = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadEntries();
  render();

  document.getElementById('scrapeBtn').addEventListener('click', handleScrape);
});

// ─── Storage ──────────────────────────────────────────────────────────────────

async function loadEntries() {
  const res = await chrome.storage.local.get('entries');
  entries = res.entries || [];
}

async function saveEntries() {
  await chrome.storage.local.set({ entries });
}

// Sync if another context (e.g. popup) modifies storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.entries) {
    entries = changes.entries.newValue || [];
    render();
  }
});

// ─── Scrape ───────────────────────────────────────────────────────────────────

async function handleScrape() {
  const btn = document.getElementById('scrapeBtn');
  setScrapeBtnState(btn, 'loading');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('Could not find the active tab');

    // Try the already-injected content script first
    let result;
    try {
      result = await chrome.tabs.sendMessage(tab.id, { action: 'scrape' });
    } catch {
      // Content script not yet present (tab was open before extension was loaded)
      // — inject it on-demand and retry
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files:  ['content.js'],
      });
      result = await chrome.tabs.sendMessage(tab.id, { action: 'scrape' });
    }

    if (!result?.ok) throw new Error(result?.error || 'Scrape returned no data');

    const { title, url, favicon, content } = result.data;

    if (!content || content.trim().length < 50) {
      showToast('⚠️ No readable content found on this page');
      return;
    }

    // Deduplicate by URL — update existing rather than create a second entry
    const existing = entries.find((e) => e.url === url);
    if (existing) {
      Object.assign(existing, { title, favicon, content, createdAt: Date.now() });
      await saveEntries();
      render();
      showToast('↻ Existing entry updated');
      return;
    }

    const entry = {
      id:        crypto.randomUUID(),
      title:     title || 'Untitled',
      url,
      favicon,
      content,
      createdAt: Date.now(),
    };

    entries.unshift(entry); // newest first
    await saveEntries();
    expandedId = entry.id; // auto-expand the fresh entry
    render();
    showToast('✓ Page scraped successfully');

  } catch (err) {
    const msg = err.message || 'Unknown error';
    // Give a friendlier hint for the most common failure
    if (msg.includes('Cannot access') || msg.includes('chrome://')) {
      showToast('✗ Cannot scrape browser / system pages');
    } else {
      showToast('✗ ' + msg);
    }
    console.error('[AI Article Sender] scrape error:', err);
  } finally {
    setScrapeBtnState(btn, 'idle');
  }
}

function setScrapeBtnState(btn, state) {
  if (state === 'loading') {
    btn.disabled = true;
    btn.innerHTML = '<span class="scrape-btn__icon scraping">↻</span> Scraping…';
  } else {
    btn.disabled = false;
    btn.innerHTML = '<span class="scrape-btn__icon">⬇</span> Scrape This Page';
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────

async function deleteEntry(id) {
  entries = entries.filter((e) => e.id !== id);
  if (expandedId === id) expandedId = null;
  await saveEntries();
  render();
}

// ─── Expand / Collapse ────────────────────────────────────────────────────────

function toggleExpand(id) {
  expandedId = expandedId === id ? null : id;
  render();
}

// ─── Send to AI ───────────────────────────────────────────────────────────────
// Done entirely in the sidepanel context — no message passing to background.
// This avoids MV3 service-worker port-closed errors entirely.

async function sendToAI(platform, entry) {
  const url = AI_URLS[platform];
  if (!url) return;

  const truncated = entry.content.length > MAX_CONTENT_CHARS
    ? entry.content.substring(0, MAX_CONTENT_CHARS) + '\n\n[Content truncated for length]'
    : entry.content;

  const prompt = `You are a professional analyst. Analyse the following article and respond in this exact format:

**TLDR:** [One executive-level sentence summarising the core point]

**Summary:** [2–4 sentences expanding on the key details]

**Key Takeaway:** [The single most important thing to remember]

If the article is relevant to any of the following themes, add a clearly labelled section for each that applies:
🏠 **UK Housing:** [Implication or insight specifically for the UK housing market]
🇬🇧 **UK Economy:** [Implication or insight for the broader UK economic outlook]
🤖 **AI / Tech:** [Implication or insight for AI or technology]
₿ **Crypto:** [Implication or insight for cryptocurrency or blockchain]

---
ARTICLE:
${truncated}`;

  const btnEl = document.querySelector(
    `.ai-btn[data-ai="${platform}"][data-entry="${entry.id}"]`
  );
  if (btnEl) { btnEl.disabled = true; btnEl.classList.add('ai-btn--loading'); }

  try {
    const tab = await chrome.tabs.create({ url });
    showToast(`Opened ${PLATFORM_LABELS[platform]} — injecting prompt…`);

    // One-shot listener: fires when our specific tab finishes loading
    const onUpdated = (tabId, changeInfo) => {
      if (tabId !== tab.id || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);

      setTimeout(() => {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func:   injectPromptIntoAI,
          args:   [platform, prompt],
        }).catch((e) => console.warn('[AI Article Sender] inject failed:', e));
      }, INJECT_DELAY_MS);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

  } catch (err) {
    showToast('✗ Could not open AI platform');
    console.error('[AI Article Sender] sendToAI error:', err);
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.classList.remove('ai-btn--loading'); }
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  const list       = document.getElementById('entryList');
  const empty      = document.getElementById('emptyState');
  const countWrap  = document.getElementById('entryCount');
  const countNum   = document.getElementById('entryCountNum');
  const countPlural = document.getElementById('entryCountPlural');

  if (entries.length === 0) {
    list.innerHTML       = '';
    empty.style.display  = 'flex';
    countWrap.style.display = 'none';
    return;
  }

  empty.style.display     = 'none';
  countWrap.style.display = 'flex';
  countNum.textContent    = entries.length;
  countPlural.textContent = entries.length === 1 ? '' : 's';

  list.innerHTML = entries.map((entry) => buildEntryHTML(entry)).join('');

  // Wire events after render
  list.querySelectorAll('[data-action="expand"]').forEach((el) => {
    el.addEventListener('click', () => toggleExpand(el.dataset.id));
  });

  list.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteEntry(btn.dataset.id);
    });
  });

  list.querySelectorAll('.ai-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const entry = entries.find((en) => en.id === btn.dataset.entry);
      if (entry) sendToAI(btn.dataset.ai, entry);
    });
  });
}

function buildEntryHTML(entry) {
  const isExpanded = expandedId === entry.id;
  const domain     = safeDomain(entry.url);
  const date       = new Date(entry.createdAt).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
  const wordCount  = entry.content.trim().split(/\s+/).length.toLocaleString();
  const preview    = esc(entry.content.substring(0, 340).trim());
  const hasMore    = entry.content.length > 340;

  return `
    <li class="entry-card ${isExpanded ? 'entry-card--expanded' : ''}" data-id="${esc(entry.id)}">

      <!-- Clickable header row -->
      <div class="entry-header" data-action="expand" data-id="${esc(entry.id)}" role="button" tabindex="0" aria-expanded="${isExpanded}">
        <div class="entry-favicon-wrap">
          <img
            class="entry-favicon"
            src="${esc(entry.favicon)}"
            alt=""
            onerror="this.style.display='none'"
          >
        </div>
        <div class="entry-meta">
          <div class="entry-title" title="${esc(entry.title)}">${esc(entry.title)}</div>
          <div class="entry-domain">${esc(domain)}</div>
        </div>
        <span class="entry-chevron" aria-hidden="true">${isExpanded ? '▲' : '▼'}</span>
        <button class="entry-delete" data-action="delete" data-id="${esc(entry.id)}" aria-label="Remove entry" title="Remove">×</button>
      </div>

      <!-- Expandable body -->
      ${isExpanded ? `
      <div class="entry-body">
        <div class="entry-pills">
          <span class="pill">📅 ${esc(date)}</span>
          <span class="pill">📝 ${esc(wordCount)} words</span>
          ${entry.content.length > MAX_CONTENT_CHARS
            ? `<span class="pill pill--warn">⚠ Content will be trimmed to ~${(MAX_CONTENT_CHARS / 1000).toFixed(0)}k chars</span>`
            : ''}
        </div>

        <div class="entry-preview">${preview}${hasMore ? '…' : ''}</div>

        <div class="ai-section">
          <p class="ai-section__label">Send to AI Platform</p>
          <div class="ai-grid">
            <button class="ai-btn ai-btn--chatgpt"    data-ai="chatgpt"    data-entry="${esc(entry.id)}">
              <img src="icons/chatgpt.svg"    class="ai-icon" alt=""> ChatGPT
            </button>
            <button class="ai-btn ai-btn--claude"     data-ai="claude"     data-entry="${esc(entry.id)}">
              <img src="icons/claude.svg"     class="ai-icon" alt=""> Claude
            </button>
            <button class="ai-btn ai-btn--gemini"     data-ai="gemini"     data-entry="${esc(entry.id)}">
              <img src="icons/gemini.svg"     class="ai-icon" alt=""> Gemini
            </button>
            <button class="ai-btn ai-btn--perplexity" data-ai="perplexity" data-entry="${esc(entry.id)}">
              <img src="icons/perplexity.svg" class="ai-icon" alt=""> Perplexity
            </button>
          </div>
        </div>
      </div>
      ` : ''}

    </li>
  `;
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(message) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());

  const toast = document.createElement('div');
  toast.className   = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger transition
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('toast--show'));
  });

  setTimeout(() => {
    toast.classList.remove('toast--show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 3200);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// ─── In-Page Injection Function ───────────────────────────────────────────────
// Serialised and executed inside the AI platform's tab via scripting.executeScript.
// Must be completely self-contained — no closure references allowed.

function injectPromptIntoAI(platform, promptText) {
  const MAX_RETRIES = 6;
  const RETRY_MS   = 1000;

  function attempt(n) {
    if (n > MAX_RETRIES) {
      console.warn('[AI Article Sender] gave up after', MAX_RETRIES, 'retries');
      return;
    }

    // ── ChatGPT ──────────────────────────────────────────────────────────────
    if (platform === 'chatgpt') {
      const editor = document.getElementById('prompt-textarea');
      if (!editor) { setTimeout(() => attempt(n + 1), RETRY_MS); return; }

      editor.focus();

      // ProseMirror truncates execCommand('insertText') on long strings.
      // Dispatching a paste ClipboardEvent is the correct way to insert
      // arbitrary-length text into a ProseMirror editor.
      const dt = new DataTransfer();
      dt.setData('text/plain', promptText);
      editor.dispatchEvent(new ClipboardEvent('paste', {
        bubbles:       true,
        cancelable:    true,
        clipboardData: dt,
      }));

      // Poll for the send button — it renders after text lands in the box
      let sendAttempts = 0;
      const trySend = () => {
        sendAttempts++;
        if (sendAttempts > 14) return;
        const btn = document.querySelector('#composer-submit-button');
        if (btn && !btn.disabled) {
          const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
          ['mousedown', 'mouseup', 'click'].forEach((t) =>
            btn.dispatchEvent(new MouseEvent(t, opts))
          );
        } else {
          setTimeout(trySend, 500);
        }
      };
      setTimeout(trySend, 800);
    }

    // ── Claude ───────────────────────────────────────────────────────────────
    else if (platform === 'claude') {
      const box = document.querySelector(
        '.ProseMirror p, [data-placeholder*="help you"], [contenteditable="true"]'
      );
      if (!box) { setTimeout(() => attempt(n + 1), RETRY_MS); return; }

      box.focus();
      document.execCommand('insertText', false, promptText);
      ['input', 'change', 'keyup', 'blur'].forEach((t) =>
        box.dispatchEvent(new Event(t, { bubbles: true }))
      );

      setTimeout(() => {
        const btn = document.querySelector(
          "button[aria-label='Send message'], button[data-testid='send-button']"
        );
        if (btn) {
          btn.removeAttribute('disabled');
          btn.disabled = false;
          const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
          ['mousedown', 'mouseup', 'click'].forEach((t) =>
            btn.dispatchEvent(new MouseEvent(t, opts))
          );
        } else {
          box.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
          }));
        }
      }, 1200);
    }

    // ── Gemini ───────────────────────────────────────────────────────────────
    else if (platform === 'gemini') {
      const box = document.querySelector('rich-textarea .ql-editor');
      if (!box) { setTimeout(() => attempt(n + 1), RETRY_MS); return; }

      box.focus();
      box.innerText = promptText;
      ['input', 'change'].forEach((t) =>
        box.dispatchEvent(new Event(t, { bubbles: true }))
      );

      setTimeout(() => {
        box.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        }));
        const btn = document.querySelector('.send-button-container');
        if (btn) btn.click();
      }, 600);
    }

    // ── Perplexity ───────────────────────────────────────────────────────────
    else if (platform === 'perplexity') {
      const box = document.querySelector('#ask-input > p');
      if (!box) { setTimeout(() => attempt(n + 1), RETRY_MS); return; }

      box.focus();
      document.execCommand('insertText', false, promptText);
      ['input', 'change', 'keyup'].forEach((t) =>
        box.dispatchEvent(new Event(t, { bubbles: true }))
      );

      setTimeout(() => {
        const container = document.querySelector('.justify-self-end');
        const buttons   = container
          ? Array.from(container.querySelectorAll('button'))
          : Array.from(document.querySelectorAll('button'));
        const btn = buttons[buttons.length - 1];
        if (btn) {
          const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
          ['mousedown', 'mouseup', 'click'].forEach((t) =>
            btn.dispatchEvent(new MouseEvent(t, opts))
          );
        } else {
          box.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
          }));
        }
      }, 1200);
    }
  }

  attempt(0);
}
