const $ = (id) => document.getElementById(id);

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'status' });
  $('port').value = status.port;
  $('dot').classList.toggle('on', status.connected);
  $('state').textContent = status.connected
    ? 'Connected to the app'
    : status.paired
      ? 'Not connected: start Chat on Creatine'
      : 'Not paired: open pairing in the app, then re-pair';
  $('error').textContent = status.error ?? '';
}

$('save').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'set-port', port: $('port').value });
  setTimeout(refresh, 800);
});

$('repair').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'repair' });
  setTimeout(refresh, 800);
});

refresh();
