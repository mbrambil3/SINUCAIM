const toggle = document.getElementById('enable');
const statusEl = document.getElementById('status');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init() {
  const tab = await getActiveTab();
  const isSinucada = tab && tab.url && /https:\/\/([a-z0-9-]+\.)?sinucada\.com/i.test(tab.url);
  const stored = await chrome.storage.local.get('sinucadaAimEnabled');
  const enabled = !!stored.sinucadaAimEnabled;
  toggle.checked = enabled;

  if (!isSinucada) {
    setStatus('Abra uma aba em sinucada.com', 'warn');
    toggle.disabled = true;
    return;
  }
  setStatus(enabled ? 'Mira ATIVA nesta aba' : 'Mira desligada', enabled ? 'ok' : '');
}

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  await chrome.storage.local.set({ sinucadaAimEnabled: enabled });
  const tab = await getActiveTab();
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle', enabled });
    setStatus(enabled ? 'Mira ATIVA nesta aba' : 'Mira desligada', enabled ? 'ok' : '');
  } catch (e) {
    setStatus('Recarregue a aba da Sinucada e tente novamente', 'warn');
  }
});

init();
