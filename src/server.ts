import express from 'express';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';

dotenv.config();

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT || '3001');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID || '0');
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || '';
const TELEGRAM_SESSION_STRING = process.env.TELEGRAM_SESSION_STRING || '';
const TELEGRAM_TARGET_CHAT_ID_RAW = process.env.TELEGRAM_TARGET_CHAT_ID || '';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─── Telegram client ──────────────────────────────────────────────────────────

let telegramClient: TelegramClient | null = null;
let telegramConnected = false;

// WebSocket clients for push notifications
const wsClients = new Set<WebSocket>();

function broadcastToClients(msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

/**
 * Parse TELEGRAM_TARGET_CHAT_ID: accepts @username, numeric ID (positive or negative).
 * Returns a string (username) or BigInt (numeric).
 */
function parseChatId(raw: string): string | bigint {
  const cleaned = raw.trim();
  if (/^-?\d+$/.test(cleaned)) {
    return BigInt(cleaned);
  }
  return cleaned; // username like "@openclaw_bot" or "openclaw_bot"
}

async function connectTelegram(): Promise<void> {
  if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH || !TELEGRAM_SESSION_STRING) {
    console.warn('[Telegram] Missing credentials (TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_STRING). Skipping connection.');
    return;
  }

  try {
    const session = new StringSession(TELEGRAM_SESSION_STRING);
    telegramClient = new TelegramClient(session, TELEGRAM_API_ID, TELEGRAM_API_HASH, {
      connectionRetries: 5,
    });

    await telegramClient.connect();

    const authorized = await telegramClient.checkAuthorization();
    if (!authorized) {
      throw new Error('Session invalid. Run `npm run generate-session` to create a new session string.');
    }

    telegramConnected = true;
    console.log('[Telegram] Connected via MTProto user API ✓');
    broadcastToClients({ type: 'telegram_connected' });

    // ── Listen for incoming messages from target chat ────────────────────────
    const targetChatId = parseChatId(TELEGRAM_TARGET_CHAT_ID_RAW);

    telegramClient.addEventHandler(async (event: NewMessageEvent) => {
      const message = event.message;

      // Skip our own outgoing messages
      if (message.out) return;

      // Filter by target chat if configured
      if (TELEGRAM_TARGET_CHAT_ID_RAW) {
        const msgPeerId = message.peerId;
        if (msgPeerId) {
          // Rough match: compare string representation of peer ID
          const peerStr = JSON.stringify(msgPeerId);
          const targetStr = String(targetChatId).replace(/^-?/, ''); // abs value
          if (!peerStr.includes(targetStr)) return;
        }
      }

      // Handle voice message
      if (message.voice) {
        try {
          console.log(`[Telegram] Incoming voice message id=${message.id}`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const buffer = await telegramClient!.downloadMedia(message as any, {}) as Buffer | undefined;
          if (buffer && buffer.length > 0) {
            broadcastToClients({
              type: 'voice',
              audioData: buffer.toString('base64'),
              messageId: message.id,
              timestamp: Date.now(),
            });
            console.log(`[Telegram] Broadcast voice: ${buffer.length} bytes`);
          }
        } catch (err) {
          console.error('[Telegram] Error downloading voice:', err);
        }
        return;
      }

      // Handle text message (show in UI for context)
      const text = message.text || message.message || '';
      if (text && text !== 'NO_REPLY' && text !== 'HEARTBEAT_OK') {
        broadcastToClients({
          type: 'text',
          text,
          messageId: message.id,
          timestamp: Date.now(),
        });
      }
    }, new NewMessage({ incoming: true }));

    console.log(`[Telegram] Listening for messages from chat: ${TELEGRAM_TARGET_CHAT_ID_RAW || '(all)'}`);
  } catch (err) {
    console.error('[Telegram] Connection failed:', err);
    telegramConnected = false;
    broadcastToClients({ type: 'telegram_disconnected' });
    setTimeout(connectTelegram, 15000);
  }
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ── POST /api/stt — Whisper speech-to-text ────────────────────────────────────
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file' }) as unknown as void;

    const tmpPath = path.join(os.tmpdir(), `tg_voice_stt_${Date.now()}.webm`);
    fs.writeFileSync(tmpPath, req.file.buffer);

    try {
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath) as Parameters<typeof openai.audio.transcriptions.create>[0]['file'],
        model: 'whisper-1',
      });
      res.json({ text: transcription.text });
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[STT] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── POST /api/send — Send message via Telegram MTProto ────────────────────────
app.post('/api/send', async (req, res) => {
  try {
    const { message } = req.body as { message?: string };
    if (!message) return res.status(400).json({ error: 'No message' }) as unknown as void;

    if (!telegramClient || !telegramConnected) {
      return res.status(503).json({ error: 'Telegram not connected. Check server logs.' }) as unknown as void;
    }

    const targetChatId = parseChatId(TELEGRAM_TARGET_CHAT_ID_RAW);
    await telegramClient.sendMessage(targetChatId as Parameters<typeof telegramClient.sendMessage>[0], { message });
    console.log(`[Telegram] Sent: "${message.slice(0, 80)}..."`);
    res.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Send] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/health ────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    telegramConnected,
    clients: wsClients.size,
  });
});

// ── Static (Vite build output) ────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distPath = join(__dirname, '..', '..', 'dist');
app.use(express.static(distPath));
app.get('*', (_req, res) => {
  const indexPath = join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Not built yet — run npm run build');
  }
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.send(JSON.stringify({ type: 'connected' }));
  // Send current Telegram status to new client
  ws.send(JSON.stringify({ type: 'status', telegramConnected }));
});

// ─── Start ────────────────────────────────────────────────────────────────────
connectTelegram().catch(console.error);

server.listen(PORT, () => {
  console.log(`[Server] Backend running on http://localhost:${PORT}`);
  console.log(`[Server] OPENAI_API_KEY: ${OPENAI_API_KEY ? '✓ set' : '✗ missing'}`);
  console.log(`[Server] TELEGRAM_TARGET_CHAT_ID: ${TELEGRAM_TARGET_CHAT_ID_RAW || '(not set)'}`);
});
