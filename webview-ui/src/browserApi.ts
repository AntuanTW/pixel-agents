// Auto-scale UI to match viewport width.
// The pixel office was designed for a ~500px wide VS Code panel with 22px base font.
// In a wide browser tab, text would be unreadable without scaling.
function updateScale(): void {
  const root = document.documentElement;
  const width = window.innerWidth;
  const scale = Math.min(1.4, Math.max(1, width / 500));

  // Apply scale factor to CSS custom properties via inline style on :root.
  // These override the Tailwind --text-* values defined in index.css.
  root.style.setProperty('--text-2xs', `${Math.round(16 * scale)}px`);
  root.style.setProperty('--text-xs', `${Math.round(18 * scale)}px`);
  root.style.setProperty('--text-sm', `${Math.round(20 * scale)}px`);
  root.style.setProperty('--text-base', `${Math.round(22 * scale)}px`);
  root.style.setProperty('--text-lg', `${Math.round(26 * scale)}px`);
  root.style.setProperty('--text-xl', `${Math.round(30 * scale)}px`);
  root.style.setProperty('--text-2xl', `${Math.round(36 * scale)}px`);
  root.style.setProperty('--text-3xl', `${Math.round(44 * scale)}px`);
  root.style.setProperty('--text-4xl', `${Math.round(52 * scale)}px`);
  root.style.setProperty('--text-5xl', `${Math.round(64 * scale)}px`);
}

updateScale();
window.addEventListener('resize', updateScale);

const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${location.host}/ws`);
const sendQueue: unknown[] = [];

ws.onopen = () => {
  for (const msg of sendQueue) ws.send(JSON.stringify(msg));
  sendQueue.length = 0;
};

ws.onmessage = (event) => {
  window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(event.data as string) }));
};

ws.onerror = () => { /* connection error — client will retry on reload */ };
ws.onclose = () => { /* connection lost */ };

export const vscode = {
  postMessage: (msg: unknown) => {
    // Intercept messages that need a path (browsers can't open native folder pickers).
    // Show a prompt() dialog so the user can type/paste a path.
    const m = msg as { type: string; path?: string };
    if (m.type === 'addExternalAssetDirectory' && !m.path) {
      const p = prompt('Enter the path to the asset directory:');
      if (!p) return;
      m.path = p;
    }
    if (m.type === 'addWorkDirectory' && !m.path) {
      const p = prompt('Enter the path to the work directory:');
      if (!p) return;
      m.path = p;
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      sendQueue.push(msg);
    }
  },
};
