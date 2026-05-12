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
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      sendQueue.push(msg);
    }
  },
};
