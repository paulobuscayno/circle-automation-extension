(function () {
  if (window.__circleOutreachLoaded) return;
  window.__circleOutreachLoaded = true;

  const SETTINGS_KEY = 'settings';
  const RUNSTATE_KEY = 'runState';
  const DAILY_KEY = 'dailySendLog';
  const RESULTS_KEY = 'resultsLog';

  const DEFAULT_SETTINGS = {
    messageTemplate: 'Hi {{first_name}}, great to have you in the community! Looking forward to connecting.',
    minDelayMs: 3500,
    maxDelayMs: 8000,
    maxPerSession: 50,
    maxPerDay: 150,
    testMode: true,
    selectors: {
      memberLinkFragment: '/members/',
      dmTextareaPlaceholder: 'type a message',
      connectNotePlaceholder: 'add a personal note',
      sendRequestButtonText: 'Send request',
      connectButtonText: 'Connect',
      messageButtonText: 'Message',
      pendingButtonText: 'Pending',
      viewProfileButtonText: 'View profile',
      dmSendButtonSelector: '',
    },
  };

  let settings = clone(DEFAULT_SETTINGS);
  let runState = {
    isRunning: false,
    status: 'idle', // idle | running | paused | stopped | finished
    processedIds: [],
    failedIds: [],
    stats: { success: 0, failed: 0, skipped: 0 },
  };

  let pauseRequested = false;
  let stopRequested = false;
  let lastScrollY = 0;
  let loopInFlight = null;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function todayKey() { return new Date().toISOString().slice(0, 10); }

  // ---------------- storage ----------------
  async function loadState() {
    const data = await chrome.storage.local.get([SETTINGS_KEY, RUNSTATE_KEY]);
    if (data[SETTINGS_KEY]) {
      settings = {
        ...DEFAULT_SETTINGS,
        ...data[SETTINGS_KEY],
        selectors: { ...DEFAULT_SETTINGS.selectors, ...(data[SETTINGS_KEY].selectors || {}) },
      };
    }
    if (data[RUNSTATE_KEY]) {
      runState = { ...runState, ...data[RUNSTATE_KEY] };
      if (!runState.failedIds) runState.failedIds = [];
      if (!runState.status) runState.status = runState.isRunning ? 'running' : 'idle';
    }
  }

  async function saveRunState() {
    await chrome.storage.local.set({ [RUNSTATE_KEY]: runState });
  }

  // While this content script is alive, it is the single source of truth for runState
  // (every mutation goes through saveRunState). Re-merging storage into it on every poll
  // would clobber in-memory-only transitions like pause before they're persisted. Settings,
  // by contrast, are meant to be picked up live from the side panel, so they reload freely.
  async function loadSettingsOnly() {
    const data = await chrome.storage.local.get([SETTINGS_KEY]);
    if (data[SETTINGS_KEY]) {
      settings = {
        ...DEFAULT_SETTINGS,
        ...data[SETTINGS_KEY],
        selectors: { ...DEFAULT_SETTINGS.selectors, ...(data[SETTINGS_KEY].selectors || {}) },
      };
    }
  }

  async function getDailyCount() {
    const data = await chrome.storage.local.get([DAILY_KEY]);
    const log = data[DAILY_KEY] || {};
    return log[todayKey()] || 0;
  }

  async function bumpDailyCount() {
    const data = await chrome.storage.local.get([DAILY_KEY]);
    const log = data[DAILY_KEY] || {};
    const key = todayKey();
    log[key] = (log[key] || 0) + 1;
    // keep only the last 14 days
    const keys = Object.keys(log).sort();
    while (keys.length > 14) delete log[keys.shift()];
    await chrome.storage.local.set({ [DAILY_KEY]: log });
    return log[key];
  }

  async function appendResult(entry) {
    const data = await chrome.storage.local.get([RESULTS_KEY]);
    const log = data[RESULTS_KEY] || [];
    log.push({ ...entry, ts: new Date().toISOString() });
    while (log.length > 5000) log.shift();
    await chrome.storage.local.set({ [RESULTS_KEY]: log });
  }

  // ---------------- dom utils ----------------
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (!(rect.width || rect.height)) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function textOf(el) {
    return (el.textContent || '').trim().toLowerCase();
  }

  function findButtonByExactText(text) {
    const target = text.trim().toLowerCase();
    const nodes = document.querySelectorAll('button, a');
    for (const el of nodes) {
      if (textOf(el) === target && isVisible(el)) return el;
    }
    return null;
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function randomDelay() {
    const { minDelayMs, maxDelayMs } = settings;
    const ms = minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs);
    return sleep(ms);
  }

  async function waitFor(fn, { timeout = 15000, interval = 250 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = fn();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  function setNativeTextareaValue(textarea, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function renderTemplate(template, member) {
    return template
      .replace(/\{\{\s*first_name\s*\}\}/gi, member.firstName || '')
      .replace(/\{\{\s*full_name\s*\}\}/gi, member.fullName || '');
  }

  function splitName(fullName) {
    const parts = (fullName || '').split(/\s+/).filter(Boolean);
    return { fullName, firstName: parts[0] || '' };
  }

  // ---------------- member card discovery ----------------
  function slugify(text) {
    return (text || '').trim().toLowerCase().replace(/\s+/g, '-');
  }

  function getMemberId(found) {
    if (found.link && found.link.href) {
      try {
        const u = new URL(found.link.href, location.origin);
        return u.pathname.replace(/\/$/, '');
      } catch {
        return found.link.href;
      }
    }
    // No usable profile link on this site's cards (seen on some Circle instances, where the
    // card is a plain clickable div with no real <a href>). Fall back to a name-derived id.
    // Risk: two members with an identical name collide. Prefer the link-based id whenever possible.
    return 'name:' + slugify(found.name);
  }

  function actionTexts() {
    return [
      settings.selectors.messageButtonText,
      settings.selectors.connectButtonText,
      settings.selectors.pendingButtonText,
      settings.selectors.viewProfileButtonText,
    ].map((t) => t.toLowerCase());
  }

  function isActionButton(el, texts) {
    return isVisible(el) && texts.includes(textOf(el));
  }

  function countActionButtonsIn(el, texts) {
    let count = isActionButton(el, texts) ? 1 : 0;
    const descendants = el.querySelectorAll('button, a');
    for (const d of descendants) if (isActionButton(d, texts)) count++;
    return count;
  }

  // A card's boundary is found the way a person would spot one: climb up from the action
  // button until we reach an element that (a) contains exactly that one action button, and
  // (b) has sibling elements that are each, independently, the same kind of single-action unit
  // — i.e. "this is one of several repeated cards". This doesn't assume any particular tag,
  // heading, or link structure, which real Circle instances vary wildly on.
  function findCardForButton(btn, texts) {
    let node = btn;
    for (let i = 0; i < 12 && node && node.parentElement && node.parentElement !== document.body; i++) {
      if (countActionButtonsIn(node, texts) === 1) {
        const parent = node.parentElement;
        const repeatedSiblings = Array.from(parent.children).filter(
          (c) => countActionButtonsIn(c, texts) === 1
        );
        if (repeatedSiblings.length >= 2) {
          return { cardRoot: node };
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  // Picks the member's name out of a card without assuming any tag: walk the card's leaf
  // text, skip the action button itself and short avatar-initial-like fragments ("AS", "R").
  function extractCardName(cardRoot, actionButton) {
    const btnText = textOf(actionButton);
    const walker = document.createTreeWalker(cardRoot, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (node === actionButton || node.contains(actionButton) || actionButton.contains(node)) continue;
      if (node.children.length > 0) continue; // only leaf-ish elements carry their own direct text
      const text = (node.textContent || '').trim();
      if (!text || text.toLowerCase() === btnText) continue;
      if (text.length <= 3 && /^[A-Za-z0-9]+$/.test(text)) continue; // avatar initials like "AS"
      return text;
    }
    return '';
  }

  function findProfileLinkIn(cardRoot) {
    return (
      cardRoot.querySelector(`a[href*="${settings.selectors.memberLinkFragment}"]`) ||
      cardRoot.querySelector('a[href]')
    );
  }

  function scanCards() {
    const texts = actionTexts();
    const buttons = Array.from(document.querySelectorAll('button, a')).filter((el) => isActionButton(el, texts));

    const cards = [];
    const seenRoots = new Set();
    for (const btn of buttons) {
      const found = findCardForButton(btn, texts);
      if (!found || seenRoots.has(found.cardRoot)) continue;
      seenRoots.add(found.cardRoot);
      const link = findProfileLinkIn(found.cardRoot);
      const name = extractCardName(found.cardRoot, btn) || (link && (link.getAttribute('aria-label') || link.textContent || '').trim()) || '';
      cards.push({
        id: getMemberId({ link, name }),
        href: link ? link.href : '',
        name,
        actionButton: btn,
        actionText: textOf(btn),
        cardRoot: found.cardRoot,
      });
    }
    return cards;
  }

  function getTotalMemberCount() {
    const text = document.body.textContent || '';
    const m = text.match(/all members\s*([\d,]+)/i);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }

  // ---------------- send actions ----------------
  async function findDmTextarea() {
    const placeholder = settings.selectors.dmTextareaPlaceholder.toLowerCase();
    return waitFor(() => {
      const areas = document.querySelectorAll('textarea');
      for (const t of areas) {
        const ph = (t.getAttribute('placeholder') || '').toLowerCase();
        if (ph.includes(placeholder) && isVisible(t)) return t;
      }
      return null;
    }, { timeout: 12000 });
  }

  async function findSendButton(textarea) {
    if (settings.selectors.dmSendButtonSelector) {
      const el = document.querySelector(settings.selectors.dmSendButtonSelector);
      if (el) return el;
    }
    const composer = textarea.closest('form') || textarea.parentElement.parentElement || textarea.parentElement;
    const buttons = Array.from(composer.querySelectorAll('button')).filter(isVisible);
    const enabled = buttons.filter((b) => !b.disabled);
    if (enabled.length === 1) return enabled[0];
    return enabled[enabled.length - 1] || null;
  }

  async function sendDmToOpenThread(member) {
    const textarea = await findDmTextarea();
    if (!textarea) throw new Error('DM textarea not found');

    const message = renderTemplate(settings.messageTemplate, member);
    textarea.focus();
    setNativeTextareaValue(textarea, message);
    await sleep(400);

    if (settings.testMode) {
      log(`[test mode] would send DM to ${member.fullName || member.id}`);
      return;
    }

    const sendBtn = await findSendButton(textarea);
    if (!sendBtn) throw new Error('Send button not found');
    sendBtn.click();

    await waitFor(() => (textarea.value || '').trim() === '', { timeout: 6000 });
  }

  async function sendConnectRequest(member) {
    const placeholder = settings.selectors.connectNotePlaceholder.toLowerCase();
    const textarea = await waitFor(() => {
      const areas = document.querySelectorAll('textarea');
      for (const t of areas) {
        const ph = (t.getAttribute('placeholder') || '').toLowerCase();
        if (ph.includes(placeholder) && isVisible(t)) return t;
      }
      return null;
    }, { timeout: 8000 });

    if (!textarea) throw new Error('Connect note textarea not found');

    const message = renderTemplate(settings.messageTemplate, member);
    textarea.focus();
    setNativeTextareaValue(textarea, message);
    await sleep(300);

    if (settings.testMode) {
      log(`[test mode] would send connect request to ${member.fullName || member.id}`);
      const cancelBtn = findButtonByExactText('Cancel');
      if (cancelBtn) cancelBtn.click();
      return;
    }

    const sendReqBtn = findButtonByExactText(settings.selectors.sendRequestButtonText);
    if (!sendReqBtn) throw new Error('Send request button not found');
    sendReqBtn.click();

    // Settle-wait only: some sites unmount the modal, others just hide it. Accept either,
    // and don't block the whole run long either way.
    await waitFor(() => !document.body.contains(textarea) || !isVisible(textarea), { timeout: 4000 });
    await sleep(300);
  }

  function goBackToList() {
    history.back();
    setTimeout(() => window.scrollTo(0, lastScrollY), 400);
  }

  async function processCard(card) {
    const { fullName, firstName } = splitName(card.name);
    const member = { id: card.id, fullName, firstName, href: card.href };

    if (card.actionText === settings.selectors.messageButtonText.toLowerCase()) {
      log(`Messaging ${fullName || card.id}...`);
      lastScrollY = window.scrollY;
      card.actionButton.click();
      await sendDmToOpenThread(member);
      runState.stats.success++;
      await appendResult({ id: card.id, name: fullName, action: 'message', status: 'success' });
      if (!settings.testMode) await bumpDailyCount();
      goBackToList();
    } else if (card.actionText === settings.selectors.connectButtonText.toLowerCase()) {
      log(`Connecting with ${fullName || card.id}...`);
      card.actionButton.click();
      await sendConnectRequest(member);
      runState.stats.success++;
      await appendResult({ id: card.id, name: fullName, action: 'connect', status: 'success' });
      if (!settings.testMode) await bumpDailyCount();
    } else {
      log(`Skipping ${fullName || card.id} (${card.actionText})`);
      runState.stats.skipped++;
      await appendResult({ id: card.id, name: fullName, action: card.actionText, status: 'skipped' });
    }
  }

  // ---------------- status push to side panel ----------------
  function pushStatus() {
    chrome.runtime.sendMessage({ type: 'STATUS_PUSH', runState }, () => void chrome.runtime.lastError);
  }

  function log(msg) {
    console.log('[Outreach Assistant]', msg);
    chrome.runtime.sendMessage({ type: 'LOG', message: msg }, () => void chrome.runtime.lastError);
  }

  // ---------------- main loop ----------------
  let noNewCardsStreak = 0;

  async function checkControl() {
    while (pauseRequested && !stopRequested) {
      pushStatus();
      await sleep(500);
    }
    return !stopRequested;
  }

  async function runLoop() {
    log('Starting outreach run...');
    while (true) {
      if (!(await checkControl())) break;

      if (!settings.testMode) {
        const dailyCount = await getDailyCount();
        if (dailyCount >= settings.maxPerDay) {
          log(`Reached daily send cap (${settings.maxPerDay}). Stopping for today.`);
          break;
        }
      }

      // Fail fast and clearly if this page has no member cards at all (e.g. the tab navigated
      // away to a DM thread or somewhere else) instead of quietly cycling the scroll-retry
      // logic below for ~15s and then reporting a misleading "Done".
      const anyCardsHere = await waitFor(() => scanCards().length > 0, { timeout: 4000 });
      if (!anyCardsHere) {
        log("No member cards found on this page. Make sure this tab is on the community's Members directory (the page listing member cards with Connect/Message buttons), then click Start again.");
        break;
      }
      await sleep(400);

      const cards = scanCards().filter((c) => !runState.processedIds.includes(c.id));

      if (cards.length === 0) {
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(1500);
        const after = scanCards().filter((c) => !runState.processedIds.includes(c.id));
        if (after.length === 0) {
          noNewCardsStreak++;
          if (noNewCardsStreak >= 3) {
            log('No more members to process. Done.');
            break;
          }
          continue;
        }
        noNewCardsStreak = 0;
        continue;
      }
      noNewCardsStreak = 0;

      const card = cards[0];
      try {
        await processCard(card);
      } catch (err) {
        runState.stats.failed++;
        runState.failedIds.push(card.id);
        await appendResult({ id: card.id, name: card.name, action: card.actionText, status: 'failed', error: err.message });
        log(`Failed on ${card.name || card.id}: ${err.message}`);
      }

      runState.processedIds.push(card.id);
      await saveRunState();
      pushStatus();

      if (runState.stats.success >= settings.maxPerSession) {
        log(`Reached max per session (${settings.maxPerSession}). Stopping.`);
        break;
      }

      if (!(await checkControl())) break;
      await randomDelay();
    }
    runState.isRunning = false;
    pauseRequested = false;
    if (runState.status !== 'stopped') runState.status = 'finished';
    await saveRunState();
    pushStatus();
  }

  async function startLoop() {
    await loadState();
    if (runState.isRunning && !pauseRequested) return { ok: true, already: true };
    if (pauseRequested) {
      pauseRequested = false;
      runState.status = 'running';
      log('Resumed');
      await saveRunState();
      pushStatus();
      return { ok: true };
    }
    stopRequested = false;
    pauseRequested = false;
    runState.isRunning = true;
    runState.status = 'running';
    await saveRunState();
    pushStatus();
    loopInFlight = runLoop().catch((err) => log('Fatal error: ' + err.message));
    return { ok: true };
  }

  function togglePause() {
    if (!runState.isRunning) return { ok: false, error: 'Not running' };
    pauseRequested = !pauseRequested;
    runState.status = pauseRequested ? 'paused' : 'running';
    saveRunState();
    log(pauseRequested ? 'Paused' : 'Resumed');
    pushStatus();
    return { ok: true, paused: pauseRequested };
  }

  async function stopLoop() {
    stopRequested = true;
    pauseRequested = false;
    runState.isRunning = false;
    runState.status = 'stopped';
    await saveRunState();
    pushStatus();
    log('Stopped');
    return { ok: true };
  }

  async function retryFailed() {
    runState.processedIds = runState.processedIds.filter((id) => !runState.failedIds.includes(id));
    const count = runState.failedIds.length;
    runState.failedIds = [];
    await saveRunState();
    pushStatus();
    log(`${count} failed member(s) re-queued for retry. Click Start to retry them.`);
    return { ok: true, count };
  }

  async function previewNext() {
    await loadSettingsOnly();
    const cards = scanCards().filter((c) => !runState.processedIds.includes(c.id));
    if (cards.length === 0) return { ok: false, error: 'No unprocessed members found on screen.' };
    const { fullName, firstName } = splitName(cards[0].name);
    const message = renderTemplate(settings.messageTemplate, { fullName, firstName });
    return { ok: true, name: fullName || cards[0].id, action: cards[0].actionText, message };
  }

  function highlightDetected() {
    const cards = scanCards();
    cards.forEach((c) => { c.cardRoot.style.outline = '2px solid red'; });
    setTimeout(() => cards.forEach((c) => (c.cardRoot.style.outline = '')), 4000);
    return cards.length;
  }

  // ---------------- messaging with side panel ----------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg.type === 'HIGHLIGHT') {
        await loadSettingsOnly();
        sendResponse({ count: highlightDetected() });
      } else if (msg.type === 'GET_STATUS') {
        sendResponse({ runState, settings, totalMembers: getTotalMemberCount() });
      } else if (msg.type === 'SETTINGS_UPDATED') {
        await loadSettingsOnly();
        sendResponse({ ok: true });
      } else if (msg.type === 'START') {
        sendResponse(await startLoop());
      } else if (msg.type === 'PAUSE_TOGGLE') {
        sendResponse(togglePause());
      } else if (msg.type === 'STOP') {
        sendResponse(await stopLoop());
      } else if (msg.type === 'RETRY_FAILED') {
        sendResponse(await retryFailed());
      } else if (msg.type === 'PREVIEW_NEXT') {
        sendResponse(await previewNext());
      } else if (msg.type === 'RESET_PROGRESS') {
        runState.processedIds = [];
        runState.failedIds = [];
        runState.stats = { success: 0, failed: 0, skipped: 0 };
        runState.status = 'idle';
        await saveRunState();
        pushStatus();
        sendResponse({ ok: true });
      } else if (msg.type === 'GET_RESULTS_CSV') {
        const data = await chrome.storage.local.get([RESULTS_KEY]);
        sendResponse({ ok: true, log: data[RESULTS_KEY] || [] });
      }
    })();
    return true;
  });

  // ---------------- init ----------------
  (async () => {
    await loadState(); // full load is correct here: this is the one point where storage is authoritative (fresh script instance)
    if (runState.isRunning) {
      // Require an explicit click to resume after a reload, instead of silently auto-running.
      runState.isRunning = false;
      runState.status = 'stopped';
      await saveRunState();
      log('Page reloaded mid-run. Click Start to resume (already-processed members are skipped).');
    }
  })();
})();
