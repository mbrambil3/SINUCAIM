// Minimal service worker. Used as a message bridge between popup and content.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ping') {
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === 'toggleFromPopup') {
    // Forward to active tab content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return sendResponse({ ok: false });
      chrome.tabs.sendMessage(
        tabs[0].id,
        { type: 'toggle', enabled: msg.enabled },
        (resp) => {
          sendResponse(resp || { ok: false });
        }
      );
    });
    return true;
  }
});
