// Service worker. Exposes chrome.tabs.captureVisibleTab to the content script
// so it can read pixel data reliably, even from WebGL canvases created
// without preserveDrawingBuffer=true.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'capture') {
    // Capture the visible area of the tab that sent the message.
    const windowId = sender && sender.tab && sender.tab.windowId;
    const opts = { format: 'png' };
    const cb = (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else if (!dataUrl) {
        sendResponse({ ok: false, error: 'no_data' });
      } else {
        sendResponse({ ok: true, dataUrl });
      }
    };
    if (typeof windowId === 'number') {
      chrome.tabs.captureVisibleTab(windowId, opts, cb);
    } else {
      chrome.tabs.captureVisibleTab(opts, cb);
    }
    return true; // async response
  }

  if (msg.type === 'toggleFromPopup') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return sendResponse({ ok: false });
      chrome.tabs.sendMessage(
        tabs[0].id,
        { type: 'toggle', enabled: msg.enabled },
        (resp) => sendResponse(resp || { ok: false })
      );
    });
    return true;
  }

  if (msg.type === 'ping') {
    sendResponse({ ok: true });
    return true;
  }
});
