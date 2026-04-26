'use strict';

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== 'scrape') return false;

  try {
    sendResponse({ ok: true, data: extractPageData() });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
  return true;
});

// ─── Page Data ───────────────────────────────────────────────────────────────

function extractPageData() {
  return {
    title:   document.title || 'Untitled',
    url:     location.href,
    favicon: detectFavicon(),
    content: extractArticleContent(),
  };
}

function detectFavicon() {
  // Prefer explicitly declared icons, largest first
  const selectors = [
    'link[rel="apple-touch-icon"]',
    'link[rel="icon"][sizes="32x32"]',
    'link[rel="icon"][sizes="16x16"]',
    'link[rel~="icon"]',
    'link[rel="shortcut icon"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.href) return el.href;
  }
  return location.origin + '/favicon.ico';
}

// ─── Article Extraction ───────────────────────────────────────────────────────

const ARTICLE_SELECTORS = [
  'article[class]',
  'article',
  '[role="article"]',
  '[itemprop="articleBody"]',
  '.article-body',
  '.article__body',
  '.article-content',
  '.post-content',
  '.post-body',
  '.entry-content',
  '.entry-body',
  '.content-body',
  '.story-body',
  '.story-content',
  '#article-body',
  '#post-body',
  '.main-content article',
  'main article',
];

const JUNK_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'header',
  'aside', 'figure figcaption', 'button', 'form',
  '[class*="ad-"]', '[id*="ad-"]', '[class*="-ad"]',
  '.ad', '.ads', '.advertisement', '.sidebar', '.related', '.comments',
  '.social-share', '.share-buttons', '[class*="banner"]', '[class*="promo"]',
  '[aria-hidden="true"]',
].join(', ');

function extractArticleContent() {
  // 1. Try known article containers
  for (const sel of ARTICLE_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = cleanElement(el);
    if (text.length > 400) return normalise(text);
  }

  // 2. Try <main>
  const main = document.querySelector('main, [role="main"]');
  if (main) {
    const text = cleanElement(main);
    if (text.length > 300) return normalise(text);
  }

  // 3. Heuristic: find the text-densest block
  const dense = findDensestBlock();
  if (dense && dense.length > 200) return normalise(dense);

  // 4. Last resort — whole body stripped of junk
  const bodyClone = document.body.cloneNode(true);
  bodyClone.querySelectorAll(JUNK_SELECTORS).forEach((n) => n.remove());
  return normalise((bodyClone.textContent || '').substring(0, 60_000));
}

function cleanElement(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll(JUNK_SELECTORS).forEach((n) => n.remove());
  return clone.textContent || '';
}

function findDensestBlock() {
  // Score each block-level container by (words − link_count×3)
  // to favour content-heavy sections and penalise nav-heavy ones
  let bestText  = '';
  let bestScore = 0;

  const candidates = document.querySelectorAll('div, section, main');
  for (const el of candidates) {
    const raw   = el.textContent || '';
    const words = raw.trim().split(/\s+/).length;
    const links = el.querySelectorAll('a').length;
    const score = words - links * 3;

    if (score > bestScore && words > 200) {
      bestScore = score;
      bestText  = raw;
    }
  }
  return bestText;
}

function normalise(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ ]{2,}/g, ' ')      // collapse repeated spaces
    .split('\n')
    .map(line => line.trim())      // strip leading/trailing spaces per line
    .filter((line, i, arr) => {
      // Keep non-empty lines; keep at most ONE consecutive blank line
      if (line.length > 0) return true;
      const prev = arr[i - 1];
      return prev !== undefined && prev.length > 0;
    })
    .join('\n')
    .trim();
}
