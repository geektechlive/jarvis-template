import { WebSocket } from 'ws';

// Usage: RELAY_API_KEY=<key> RELAY_CHANNEL_ID=<id> [RELAY_HOST=<host>] node e2e-brief-test.mjs
if (!process.env.RELAY_API_KEY || !process.env.RELAY_CHANNEL_ID) {
  console.error('Error: RELAY_API_KEY and RELAY_CHANNEL_ID must be set.');
  process.exit(1);
}

const RELAY_API_KEY = process.env.RELAY_API_KEY;
const CHANNEL_ID   = process.env.RELAY_CHANNEL_ID;
const RELAY_HOST   = process.env.RELAY_HOST ?? '<mac-mini-ip>';
const RELAY_PORT = 8443;

const briefingId = 'e2e_bg_test';
const title = 'E2E Background Test';
const briefingText = 'This briefing was delivered while the phone was locked. If you can read this in the Briefings inbox without having tapped the notification, the background wake fix is working correctly. Well done.';

const path = `/v1/channel/${CHANNEL_ID}?role=ion`;
const url = `ws://${RELAY_HOST}:${RELAY_PORT}${path}`;

const ws = new WebSocket(url, {
  headers: { Authorization: `Bearer ${RELAY_API_KEY}` },
});

ws.on('open', () => {
  const payload = JSON.stringify({
    type: 'push',
    title,
    body: 'Your background test brief is ready.',
    sound: 'jarvis-morning.caf',
    briefingId,
    briefingText,
  });
  ws.send(payload);
  console.log('Sent briefing push:', briefingId);
  setTimeout(() => ws.close(), 500);
});

ws.on('close', () => {
  console.log('Done.');
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});
