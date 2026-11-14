const CONTENT_SCRIPT_ID = 'circle-outreach-content-script';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ACTIVATE_ON_TAB') {
    activateOnTab(msg.tabId, msg.origin)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === 'DEACTIVATE') {
    deactivate(msg.origin)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
});

async function activateOnTab(tabId, origin) {
  const originPattern = origin + '/*';

  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) return { ok: false, error: 'Permission was not granted for this site.' };

  // Register so the content script also auto-loads on future visits/reloads of this origin.
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  const scriptDef = {
    id: CONTENT_SCRIPT_ID,
    matches: [originPattern],
    js: ['content.js'],
    runAt: 'document_idle',
    persistAcrossSessions: true,
  };
  if (existing.length) {
    await chrome.scripting.updateContentScripts([scriptDef]);
  } else {
    await chrome.scripting.registerContentScripts([scriptDef]);
  }

  // Inject immediately into the already-open tab (registration only affects future navigations).
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });

  await chrome.storage.local.set({ grantedOrigin: origin });
  return { ok: true };
}

async function deactivate(origin) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch (e) {
    /* not registered, ignore */
  }
  if (origin) {
    try {
      await chrome.permissions.remove({ origins: [origin + '/*'] });
    } catch (e) {
      /* ignore */
    }
  }
  return { ok: true };
}
