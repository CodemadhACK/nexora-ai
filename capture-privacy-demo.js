'use strict';

const $ = (id) => document.getElementById(id);

function render(status) {
  const on = !!status.excluded;
  $('state').textContent = `Screen Capture Privacy: ${on ? 'ON' : 'OFF'}`;
  $('state').className = on ? 'on' : '';
  $('toggle').textContent = on ? 'Turn privacy OFF' : 'Turn privacy ON';
  $('version').textContent = status.windowsVersion || 'not Windows';
  $('hwnd').textContent = status.hwnd || 'not available';
  $('affinity').textContent = on ? 'WDA_EXCLUDEFROMCAPTURE' : 'WDA_NONE / normal capture';
  $('success').textContent = status.succeeded ? 'succeeded' : 'not succeeded';
  $('error').textContent = status.error || 'none';
}

async function refresh() { render(await window.nexora.privacy.get()); }

// The switch can also be thrown from Settings, and this page has no way of
// knowing that happened unless it is told. Without this it kept displaying its
// own last action, which is how it came to show ON over a window that was being
// captured normally.
window.nexora.on('state:privacy', render);

$('toggle').onclick = async () => {
  const current = await window.nexora.privacy.get();
  render(await window.nexora.privacy.set(!current.excluded));
};

refresh();