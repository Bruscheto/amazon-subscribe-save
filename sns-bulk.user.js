// ==UserScript==
// @name         Amazon Subscribe & Save — Bulk Manager
// @namespace    https://example.com/amazon-ss-bulk
// @version      1.6.0
// @description  Floating panel to bulk-cancel all Subscribe & Save items through Amazon's current UI, or set every subscription to a 12-month delivery frequency.
// @author       you
// @match        https://www.amazon.com/auto-deliveries/*
// @match        https://www.amazon.com/gp/subscribe-and-save/*
// @icon         https://www.amazon.com/favicon.ico
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const SUBSCRIPTIONS_URL = 'https://www.amazon.com/auto-deliveries/subscriptionList?ref_=sns_discover_m_d_nav_mys';

  /* ------------------------------------------------------------------ *
   * CONFIG — tweak these if Amazon changes things or you want it gentler
   * ------------------------------------------------------------------ */
  const CONFIG = {
    // Delay between cancel requests (ms). Higher = gentler / slower.
    cancelDelayMs: 800,

    // Max time to wait for each Amazon cancellation screen (ms).
    cancelUiTimeoutMs: 15000,

    // Max "Show more subscriptions" clicks before giving up.
    maxExpandClicks: 60,
    expandDelayMs: 1000,

    // Delay between each schedule-change submit (ms).
    scheduleDelayMs: 300,

  };

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const isVisible = (el) => !!(el && el.getClientRects().length);

  function waitForVisible(selector, timeoutMs, root = document) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const match = $$(selector, root).find(isVisible);
        if (match) { resolve(match); return; }
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${selector}`));
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function waitUntil(check, timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (check()) { resolve(); return; }
        if (Date.now() - started >= timeoutMs) {
          reject(new Error('Amazon did not finish the cancellation in time.'));
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  /* ------------------------------------------------------------------ *
   * UI panel
   * ------------------------------------------------------------------ */
  let statusEl, cancelBtn, freqBtn;

  function setStatus(msg, kind = 'info') {
    if (!statusEl) return;
    const color = { info: '#787774', ok: '#346538', warn: '#956400', err: '#9f2f2d' }[kind] || '#787774';
    statusEl.style.color = color;
    statusEl.textContent = msg;
  }

  function setBusy(busy) {
    [cancelBtn, freqBtn].forEach((b) => { if (b) b.disabled = busy; });
  }

  function buildPanel() {
    if (document.getElementById('ss-bulk-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'ss-bulk-panel';
    panel.innerHTML = `
      <style>
        #ss-bulk-panel,#ss-bulk-panel *{box-sizing:border-box}
        #ss-bulk-panel{--ss-ink:#282826;--ss-muted:#777671;--ss-faint:#a09f9a;
          --ss-line:#e7e6e2;--ss-canvas:#fff;--ss-hover:#f5f5f2;position:fixed;
          right:max(14px,env(safe-area-inset-right));bottom:max(14px,env(safe-area-inset-bottom));
          z-index:2147483647;width:288px;max-width:calc(100vw - 28px);overflow:hidden;
          font-family:'Amazon Ember',-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif;
          color:var(--ss-ink);background:var(--ss-canvas);border:1px solid #dfded9;border-radius:10px;
          box-shadow:0 6px 24px rgba(25,25,22,.045);-webkit-font-smoothing:antialiased}
        #ss-bulk-panel .ss-head{display:flex;align-items:center;justify-content:space-between;
          min-height:56px;padding:12px 14px;border-bottom:1px solid var(--ss-line)}
        #ss-bulk-panel .ss-title{display:flex;flex-direction:column;gap:3px}
        #ss-bulk-panel .ss-eyebrow{color:var(--ss-faint);font-size:9.5px;font-weight:600;
          line-height:1.2;letter-spacing:.075em;text-transform:uppercase}
        #ss-bulk-panel .ss-name{color:var(--ss-ink);font-size:14px;font-weight:650;
          line-height:1.2;letter-spacing:-.012em}
        #ss-bulk-panel .ss-body{display:flex;flex-direction:column;gap:8px;padding:14px}
        #ss-bulk-panel button{font:inherit}
        #ss-bulk-panel button.ss-act{display:flex;align-items:center;justify-content:center;
          width:100%;min-height:38px;padding:9px 12px;cursor:pointer;border:1px solid transparent;
          border-radius:6px;font-size:12px;font-weight:650;line-height:1.25;letter-spacing:-.005em;
          transition:background-color .14s ease,border-color .14s ease,color .14s ease,transform .14s ease}
        #ss-bulk-panel button.ss-act:active:not(:disabled){transform:scale(.99)}
        #ss-bulk-panel button.ss-act:disabled{cursor:not-allowed;opacity:.42}
        #ss-bulk-panel .ss-freq{color:#fff;background:#2d2d2a}
        #ss-bulk-panel .ss-freq:hover:not(:disabled){background:#41413d}
        #ss-bulk-panel .ss-cancel{color:#93413e;background:#fff}
        #ss-bulk-panel .ss-cancel:hover:not(:disabled){background:#fbf5f4}
        #ss-bulk-panel .ss-status{margin-top:4px;padding:11px 2px 1px;color:var(--ss-muted);
          border-top:1px solid var(--ss-line);font-size:11px;line-height:1.45}
        #ss-bulk-panel .ss-min{position:relative;flex:0 0 auto;width:28px;height:28px;padding:0;
          cursor:pointer;color:#85847f;background:transparent;border:0;border-radius:6px;
          transition:color .14s ease,background-color .14s ease}
        #ss-bulk-panel .ss-min::before,#ss-bulk-panel .ss-min::after{content:'';position:absolute;
          top:50%;left:50%;width:10px;height:1.5px;border-radius:2px;background:currentColor;
          transform:translate(-50%,-50%)}
        #ss-bulk-panel .ss-min::after{opacity:0;transform:translate(-50%,-50%) rotate(90deg)}
        #ss-bulk-panel .ss-min:hover{color:#4f4f4b;background:var(--ss-hover)}
        #ss-bulk-panel button:focus-visible{outline:2px solid #686762;outline-offset:2px}
        #ss-bulk-panel.ss-collapsed{width:40px;border-radius:9px}
        #ss-bulk-panel.ss-collapsed .ss-head{min-height:38px;padding:5px;border-bottom:0}
        #ss-bulk-panel.ss-collapsed .ss-title{display:none}
        #ss-bulk-panel.ss-collapsed .ss-min{margin:auto}
        #ss-bulk-panel.ss-collapsed .ss-min::after{opacity:1}
        #ss-bulk-panel.ss-collapsed .ss-body{display:none}
        @media (prefers-reduced-motion:reduce){#ss-bulk-panel button{transition:none!important}}
      </style>
      <div class="ss-head">
        <div class="ss-title">
          <span class="ss-eyebrow">Subscribe &amp; Save</span>
          <span class="ss-name">Bulk manager</span>
        </div>
        <button type="button" class="ss-min" title="Collapse" aria-label="Collapse panel" aria-expanded="true"></button>
      </div>
      <div class="ss-body">
        <button type="button" class="ss-act ss-freq">Set all to 12 months</button>
        <button type="button" class="ss-act ss-cancel">Cancel all subscriptions</button>
        <div class="ss-status" role="status" aria-live="polite">Ready</div>
      </div>`;
    document.body.appendChild(panel);

    statusEl = panel.querySelector('.ss-status');
    cancelBtn = panel.querySelector('.ss-cancel');
    freqBtn = panel.querySelector('.ss-freq');

    const minBtn = panel.querySelector('.ss-min');
    minBtn.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('ss-collapsed');
      minBtn.title = collapsed ? 'Expand' : 'Collapse';
      minBtn.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} panel`);
      minBtn.setAttribute('aria-expanded', String(!collapsed));
    });
    cancelBtn.addEventListener('click', runCancelAll);
    freqBtn.addEventListener('click', runSetFrequency);
  }

  /* ------------------------------------------------------------------ *
   * CANCEL ALL
   * ------------------------------------------------------------------ */
  function subscriptionIdFrom(span) {
    const raw = span.getAttribute('data-edit-link-subscription-tablet') || '';
    let url = raw;
    try { url = JSON.parse(raw).tabletUrl || raw; } catch (e) { /* fall back to raw string */ }
    return url.match(/subscriptionId=([^&"]+)/)?.[1] || null;
  }

  function collectSubscriptionIds() {
    const ids = $$('span[data-action="edit-link-subscription-tablet"]')
      .map(subscriptionIdFrom)
      .filter(Boolean);
    return [...new Set(ids)]; // de-dupe (Amazon renders ~2 spans per item)
  }

  function findEditControl(id) {
    return $$('span[data-action="edit-link-subscription-tablet"]')
      .find((span) => isVisible(span) && subscriptionIdFrom(span) === id) || null;
  }

  function closeOpenEditDialog() {
    const close = $$('.a-popover-modal button[data-action="a-popover-close"]')
      .find(isVisible);
    if (close) close.click();
  }

  function ensureSubscriptionsPage() {
    if (location.pathname === '/auto-deliveries/subscriptionList') return true;
    setStatus('Opening your subscriptions…', 'info');
    location.assign(SUBSCRIPTIONS_URL);
    return false;
  }

  async function openEditSubscriptions() {
    if ($$('select[name="changeFrequency"]').some(isVisible)) return;
    const edit = $$('[data-action="replenishment-sidesheet"]').find(isVisible);
    if (!edit) throw new Error('Could not find Edit subscriptions.');
    edit.click();
    await waitForVisible('select[name="changeFrequency"]', CONFIG.cancelUiTimeoutMs);
  }

  async function cancelThroughAmazonUi(id) {
    const edit = findEditControl(id);
    if (!edit) throw new Error(`Could not find Edit for ${id}`);
    edit.click();

    const editContent = await waitForVisible(
      '.editSubscriptionContainer',
      CONFIG.cancelUiTimeoutMs
    );
    const editDialog = editContent.closest('.a-popover-modal') || document;
    const cancel = await waitForVisible(
      'a.t-action-type-CANCEL',
      CONFIG.cancelUiTimeoutMs,
      editDialog
    );
    cancel.click();

    const confirmCancel = await waitForVisible(
      '#cancel-subscription-dialog #confirmCancelLink input[type="submit"]',
      CONFIG.cancelUiTimeoutMs,
      editDialog
    );
    confirmCancel.click();
    await sleep(CONFIG.cancelDelayMs);
    await waitUntil(() => !isVisible(confirmCancel), CONFIG.cancelUiTimeoutMs);
    closeOpenEditDialog();
  }

  async function runCancelAll() {
    if (!ensureSubscriptionsPage()) return;

    setBusy(true);
    setStatus('Expanding the full list first…', 'info');
    await expandAll();

    const ids = collectSubscriptionIds();
    if (ids.length === 0) {
      setBusy(false);
      setStatus('No active subscriptions found on this page.', 'warn');
      return;
    }
    if (!confirm(`Cancel ALL ${ids.length} Subscribe & Save items?\n\nThis is permanent and will send one confirmation email per item.`)) {
      setBusy(false);
      setStatus('Cancelled — no changes made.', 'info');
      return;
    }

    let ok = 0, fail = 0;

    for (let i = 0; i < ids.length; i++) {
      setStatus(`Cancelling ${i + 1} / ${ids.length}…`, 'info');
      try {
        await cancelThroughAmazonUi(ids[i]);
        ok++;
      } catch (e) {
        console.error(`[SS] cancel ${ids[i]} failed`, e);
        closeOpenEditDialog();
        fail++;
      }
      await sleep(CONFIG.cancelDelayMs);
    }

    setBusy(false);
    setStatus(`Done. Cancelled ${ok}${fail ? `, ${fail} failed` : ''}. Refresh to verify.`, fail ? 'warn' : 'ok');
  }

  /* ------------------------------------------------------------------ *
   * Shared: expand the full subscription list (used by 12-month action)
   * ------------------------------------------------------------------ */
  function findShowMore() {
    // Old bulk-edit pagination trigger (gone on newer layouts, but try anyway)
    const old = document.querySelector(
      '.a-section.subscription-pagination-trigger-container span[data-action="bulk-edit-pagination-action"] > .subscription-pagination-trigger'
    );
    if (old && !(old.parentElement && old.parentElement.classList.contains('aok-hidden'))) return old;

    // Generic fallback: a visible clickable element reading "show more subscriptions"
    const candidates = $$('a, span, button, input[type="submit"]');
    return candidates.find((el) => {
      const txt = (el.textContent || el.value || '').trim().toLowerCase();
      return el.offsetParent !== null && /show more subscription/.test(txt);
    }) || null;
  }

  function expandAll() {
    return new Promise((resolve) => {
      let clicks = 0;
      const tick = () => {
        const btn = findShowMore();
        if (!btn || clicks >= CONFIG.maxExpandClicks) { resolve(); return; }
        btn.click();
        clicks++;
        setStatus(`Expanding list… (${clicks})`, 'info');
        setTimeout(tick, CONFIG.expandDelayMs);
      };
      tick();
    });
  }

  /* ------------------------------------------------------------------ *
   * SET ALL FREQUENCIES to 12 months
   * ------------------------------------------------------------------ */
  function findSaveButton(sel) {
    // Best-effort: an Update/Save/Apply control near this dropdown.
    const scope = sel.closest('form')
      || sel.closest('.a-box, .a-section, .a-row, [data-lineitemid]')
      || document;
    return scope.querySelector('.a-button-input')
      || [...scope.querySelectorAll('a, span, button, input')].find((b) =>
           /\b(update|save|apply)\b/i.test((b.textContent || b.value || '').trim()))
      || null;
  }

  async function runSetFrequency() {
    if (!ensureSubscriptionsPage()) return;

    setBusy(true);
    setStatus('Opening Edit subscriptions…', 'info');
    try {
      await openEditSubscriptions();
    } catch (e) {
      console.error('[SS] could not open Edit subscriptions', e);
      setBusy(false);
      setStatus('Could not open Edit subscriptions. Refresh and try again.', 'err');
      return;
    }

    setStatus('Expanding the full list first…', 'info');
    await expandAll();

    const selects = $$('select[name="changeFrequency"]');
    if (selects.length === 0) {
      setBusy(false);
      setStatus('No frequency dropdowns found. Use this on the Edit/Manage Subscriptions view where each item shows a "Delivered every" dropdown.', 'warn');
      return;
    }
    if (!confirm(`Set ALL ${selects.length} subscriptions to deliver every 12 months?`)) {
      setBusy(false);
      setStatus('Cancelled — no changes made.', 'info');
      return;
    }

    let changed = 0;
    for (let i = 0; i < selects.length; i++) {
      const sel = selects[i];
      // Prefer the explicit 12-month option, fall back to "12 month" text, then last option.
      const opt = [...sel.options].find((o) => o.value === '12-m')
        || [...sel.options].find((o) => /12\s*month/i.test(o.textContent))
        || sel.options[sel.options.length - 1];
      setStatus(`Updating ${i + 1} / ${selects.length}…`, 'info');

      if (opt && sel.value !== opt.value) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const saveBtn = findSaveButton(sel);
        if (saveBtn) saveBtn.click();
        changed++;
      }
      await sleep(CONFIG.scheduleDelayMs);
    }

    setBusy(false);
    setStatus(`Done. Updated ${changed} of ${selects.length} to 12 months. Refresh to confirm it saved.`, 'ok');
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */
  buildPanel();
})();
