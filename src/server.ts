import express from 'express';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import dotenv from 'dotenv';
import fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import { CustomFile } from 'telegram/client/uploads.js';

dotenv.config();

// Configure ffmpeg path (bundled static binary)
if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);

/** Convert any audio format (WebM, MP4, etc.) to OGG Opus for Telegram voice notes */
async function convertToOgg(inputBuffer: Buffer): Promise<Buffer> {
  const id = randomBytes(8).toString('hex');
  const inputPath = join(tmpdir(), `vc_in_${id}`);
  const outputPath = join(tmpdir(), `vc_out_${id}.ogg`);
  await fs.promises.writeFile(inputPath, inputBuffer);
  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(['-c:a libopus', '-b:a 64k', '-vn'])
      .save(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err));
  });
  const out = await fs.promises.readFile(outputPath);
  await Promise.all([
    fs.promises.unlink(inputPath).catch(() => {}),
    fs.promises.unlink(outputPath).catch(() => {}),
  ]);
  return out;
}

const PORT = parseInt(process.env.PORT || process.env.BACKEND_PORT || '3000');
const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID || '0');
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || '';
const TELEGRAM_SESSION_STRING = process.env.TELEGRAM_SESSION_STRING || '';
const TELEGRAM_TARGET_CHAT_ID_RAW = process.env.TELEGRAM_TARGET_CHAT_ID || '';
const FRONTEND_AUTH_PASSWORD = process.env.FRONTEND_AUTH_PASSWORD || '';

// Mutable: the currently-selected target chat. Initialized from env if provided.
let currentTargetChatId: string = TELEGRAM_TARGET_CHAT_ID_RAW;

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
 * Extract blockquote text from Telegram message entities.
 * Returns { quotedText, bodyText } where quotedText is the blockquoted portion.
 */
function extractBlockquote(message: { text?: string; message?: string; entities?: unknown[] }): { quotedText: string; bodyText: string } {
  const text = message.text || message.message || '';
  const entities = message.entities || [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blockquotes = entities.filter((e: any) =>
    e.className === 'MessageEntityBlockquote' || e.constructor?.name === 'MessageEntityBlockquote'
  ) as Array<{ offset: number; length: number }>;

  if (blockquotes.length === 0) return { quotedText: '', bodyText: text };

  const bq = blockquotes[0];
  const quotedText = text.slice(bq.offset, bq.offset + bq.length);
  const before = text.slice(0, bq.offset).trim();
  const after = text.slice(bq.offset + bq.length).trim();
  const bodyText = [before, after].filter(Boolean).join('\n');

  return { quotedText, bodyText };
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
    telegramClient.addEventHandler(async (event: NewMessageEvent) => {
      const message = event.message;

      // Skip our own outgoing messages
      if (message.out) return;

      // No chat selected — drop all messages
      if (!currentTargetChatId) return;

      // Filter by target chat (re-evaluated dynamically on each message)
      const targetChatId = parseChatId(currentTargetChatId);
      const msgPeerId = message.peerId;
      if (msgPeerId) {
        const peerStr = JSON.stringify(msgPeerId);
        const targetStr = String(targetChatId).replace(/^-?/, ''); // abs value
        if (!peerStr.includes(targetStr)) return;
      }

      // Clear typing indicator when a message arrives
      broadcastToClients({ type: 'typing_stop' });

      // Handle voice message (include caption text if present)
      if (message.voice) {
        try {
          console.log(`[Telegram] Incoming voice message id=${message.id}`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const buffer = await telegramClient!.downloadMedia(message as any, {}) as Buffer | undefined;
          if (buffer && buffer.length > 0) {
            const { quotedText, bodyText } = extractBlockquote(message);
            broadcastToClients({
              type: 'voice',
              audioData: buffer.toString('base64'),
              text: bodyText,
              quotedText,
              messageId: message.id,
              timestamp: Date.now(),
            });
            console.log(`[Telegram] Broadcast voice: ${buffer.length} bytes${bodyText ? ` (caption: ${bodyText.slice(0, 40)}...)` : ''}`);
          }
        } catch (err) {
          console.error('[Telegram] Error downloading voice:', err);
        }
        return;
      }

      // Handle text message (show in UI for context)
      const { quotedText, bodyText } = extractBlockquote(message);
      // When blockquote covers entire text, bodyText is "" — don't fall back to full text
      const text = quotedText ? bodyText : (bodyText || message.text || message.message || '');
      if ((text || quotedText) && text !== 'NO_REPLY' && text !== 'HEARTBEAT_OK') {
        console.log(`[Telegram] Text msg id=${message.id} textLen=${(message.text || '').length} entities=${(message.entities || []).length} quote=${quotedText.length} body=${text.length}`);
        broadcastToClients({
          type: 'text',
          text,
          quotedText,
          messageId: message.id,
          timestamp: Date.now(),
        });
      }
    }, new NewMessage({ incoming: true }));

    // ── Raw update handler: message edits + typing indicators ────────────────
    telegramClient.addEventHandler(async (update: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const u = update as any;
      const cn = u.className || u.constructor?.name || '';

      // ── Typing indicators ──
      if (cn === 'UpdateChatUserTyping' || cn === 'UpdateUserTyping') {
        if (!currentTargetChatId) return;
        // Filter by target chat
        const targetStr = String(parseChatId(currentTargetChatId)).replace(/^-?/, '');
        const chatIdStr = String(u.chatId || u.userId || '');
        if (!chatIdStr.includes(targetStr)) return;

        const action = u.action?.className || 'SendMessageTypingAction';
        broadcastToClients({ type: 'typing', action, timestamp: Date.now() });
        return;
      }

      // ── Message edits (bot streaming text) ──
      if (cn !== 'UpdateEditMessage' && cn !== 'UpdateEditChannelMessage') return;
      if (!currentTargetChatId || !telegramClient) return;

      const rawMsgId = u.message?.id;
      if (!rawMsgId || u.message?.out) return;

      try {
        // Raw update doesn't hydrate message.text — fetch the full message
        const targetChatId = parseChatId(currentTargetChatId);
        const messages = await telegramClient.getMessages(
          targetChatId as Parameters<typeof telegramClient.getMessages>[0],
          { ids: [rawMsgId] }
        );
        const message = messages[0];
        if (!message || message.out) return;

        const { quotedText, bodyText } = extractBlockquote(message);
        const text = quotedText ? bodyText : (bodyText || message.text || message.message || '');
        if (text || quotedText) {
          broadcastToClients({
            type: 'text_update',
            text,
            quotedText,
            messageId: rawMsgId,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        console.error('[Telegram] Error fetching edited message:', err);
      }
    });

    console.log(`[Telegram] Listening for messages + edits (target: ${currentTargetChatId || '(none selected)'})`);
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

// ── POST /api/send-voice — Send audio as Telegram voice note ──────────────────
app.post('/api/send-voice', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file' }) as unknown as void;

    if (!telegramClient || !telegramConnected) {
      return res.status(503).json({ error: 'Telegram not connected. Check server logs.' }) as unknown as void;
    }

    if (!currentTargetChatId) {
      return res.status(400).json({ error: 'No target chat selected. Please select a chat first.' }) as unknown as void;
    }

    const targetChatId = parseChatId(currentTargetChatId);
    const rawBuffer = Buffer.from(req.file.buffer);
    console.log(`[Send Voice] Received ${rawBuffer.length}b, mimetype=${req.file.mimetype}`);

    // Convert to OGG Opus so Telegram classifies it as a voice note, not video/webm
    let buffer = rawBuffer;
    let conversionNote = 'raw (no conversion)';
    try {
      buffer = await convertToOgg(rawBuffer);
      conversionNote = `converted ${rawBuffer.length}b → ${buffer.length}b OGG`;
      console.log(`[Send Voice] ${conversionNote}`);
    } catch (convErr) {
      const convMsg = convErr instanceof Error ? convErr.message : String(convErr);
      console.warn('[Send Voice] ffmpeg conversion failed, sending raw:', convMsg);
      conversionNote = `conversion failed: ${convMsg}`;
    }

    await telegramClient.sendFile(
      targetChatId as Parameters<typeof telegramClient.sendFile>[0],
      {
        file: new CustomFile('voice.ogg', buffer.length, '', buffer),
        voiceNote: true,
      }
    );

    console.log(`[Telegram] Sent voice note: ${buffer.length} bytes (${conversionNote})`);
    res.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Send Voice] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/dialogs — List Telegram chats ────────────────────────────────────
app.get('/api/dialogs', async (_req, res) => {
  try {
    if (!telegramClient || !telegramConnected) {
      return res.status(503).json({ error: 'Telegram not connected' }) as unknown as void;
    }

    const dialogs = await telegramClient.getDialogs({ limit: 100 });

    const result = dialogs.map((d) => ({
      id: d.id?.toString() ?? '',
      name: d.name || d.title || '(unnamed)',
      title: d.title || d.name || '(unnamed)',
      isUser: d.isUser,
      isGroup: d.isGroup,
      isChannel: d.isChannel,
      unreadCount: d.unreadCount,
      pinned: d.pinned,
      archived: d.archived,
      lastMessage: (d.message?.text || d.message?.message || '').slice(0, 80),
    }));

    res.json({ dialogs: result, currentChatId: currentTargetChatId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Dialogs] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── POST /api/select-chat — Set the active target chat ───────────────────────
app.post('/api/select-chat', (req, res) => {
  const { chatId } = req.body as { chatId?: string };

  if (!chatId || typeof chatId !== 'string') {
    return res.status(400).json({ error: 'chatId is required (string)' }) as unknown as void;
  }

  currentTargetChatId = chatId.trim();
  console.log(`[Chat] Target chat changed to: ${currentTargetChatId}`);

  broadcastToClients({ type: 'chat_selected', chatId: currentTargetChatId });
  res.json({ ok: true, chatId: currentTargetChatId });
});

// ── GET /api/messages — Fetch recent message history from active chat ─────────
app.get('/api/messages', async (req, res) => {
  try {
    if (!telegramClient || !telegramConnected) {
      return res.status(503).json({ error: 'Telegram not connected' }) as unknown as void;
    }
    if (!currentTargetChatId) {
      return res.status(400).json({ error: 'No chat selected' }) as unknown as void;
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const targetChatId = parseChatId(currentTargetChatId);

    const msgs = await telegramClient.getMessages(
      targetChatId as Parameters<typeof telegramClient.getMessages>[0],
      { limit }
    );

    // Process messages in parallel (download voice media concurrently)
    const result = await Promise.all(
      msgs.map(async (m) => {
        const { quotedText, bodyText } = extractBlockquote(m);
        const text = quotedText ? bodyText : (bodyText || m.text || m.message || '');

        let audioData: string | null = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((m as any).voice) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const buffer = await telegramClient!.downloadMedia(m as any, {}) as Buffer | undefined;
            if (buffer && buffer.length > 0) {
              audioData = buffer.toString('base64');
            }
          } catch (err) {
            console.error(`[Messages] Error downloading voice id=${m.id}:`, err);
          }
        }

        return {
          id: m.id,
          out: !!m.out,
          text: (text !== 'NO_REPLY' && text !== 'HEARTBEAT_OK') ? text : '',
          quotedText,
          audioData,
          date: m.date,
        };
      })
    );

    // Reverse so oldest is first (getMessages returns newest-first)
    result.reverse();

    // Filter out empty messages (no text, no quote, no audio)
    const filtered = result.filter((m) => m.text || m.quotedText || m.audioData);

    console.log(`[Messages] Fetched ${filtered.length} messages (of ${msgs.length} raw)`);
    res.json({ messages: filtered });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Messages] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/auth-required — Check if password auth is enabled ─────────────────
app.get('/api/auth-required', (_req, res) => {
  res.json({ required: !!FRONTEND_AUTH_PASSWORD });
});

// ── POST /api/auth — Verify password ─────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  if (!FRONTEND_AUTH_PASSWORD) {
    return res.json({ ok: true }) as unknown as void;
  }
  const { password } = req.body || {};
  if (password === FRONTEND_AUTH_PASSWORD) {
    return res.json({ ok: true }) as unknown as void;
  }
  return res.status(401).json({ ok: false, error: 'Wrong password' }) as unknown as void;
});

// ── GET /api/health ────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    telegramConnected,
    chatSelected: !!currentTargetChatId,
    clients: wsClients.size,
  });
});

// ── Static (Vite build output) ────────────────────────────────────────────────
const distPath = join(process.cwd(), 'dist');
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
  // Send current Telegram + chat status to new client
  ws.send(JSON.stringify({
    type: 'status',
    telegramConnected,
    chatId: currentTargetChatId || null,
  }));
});

// ─── Start ────────────────────────────────────────────────────────────────────
connectTelegram().catch(console.error);

server.listen(PORT, () => {
  console.log(`[Server] Backend running on http://localhost:${PORT}`);
  console.log(`[Server] TELEGRAM_TARGET_CHAT_ID: ${TELEGRAM_TARGET_CHAT_ID_RAW || '(not set)'}`);
});
