# openclaw-telegram-voice-wrapper

A hands-free voice interface to OpenClaw via Telegram's MTProto user API (gramjs).

Speak → Whisper STT transcribes → message sent as **you** via Telegram → OpenClaw responds with a voice bubble → plays back in the browser → mic re-arms.

Your full conversation lives natively in Telegram history.

## Architecture

```
[Browser Mic + VAD]
       ↓  (auto-detected speech)
[Whisper STT]
       ↓  (transcribed text)
[Telegram MTProto User API (gramjs)]  ← messages appear from ET, not a bot
       ↓  (message sent to target chat)
[OpenClaw processes + responds]
       ↓  (voice bubble OGG in Telegram)
[gramjs event listener → backend]
       ↓  (base64 OGG over WebSocket)
[Browser audio queue → playback]
       ↓  (finished playing)
[Mic re-arms → loop]
```

## Setup

### 1. Get Telegram API credentials

Go to [my.telegram.org/apps](https://my.telegram.org/apps) and create an application.
Copy `api_id` and `api_hash`.

### 2. Generate session string

This authenticates gramjs as **your** Telegram user account.

```bash
cp .env.example .env
# Fill in TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first
npm install
npm run generate-session
```

Follow the prompts (phone number + verification code). Copy the printed session string into `.env` as `TELEGRAM_SESSION_STRING=<value>`.

> ⚠️ The session string grants full access to your Telegram account. Keep it secret.

### 3. Configure target chat

Set `TELEGRAM_TARGET_CHAT_ID` in `.env` to the chat where OpenClaw listens:
- Username: `@openclaw_bot`  
- Numeric group ID: `-1001234567890`
- Numeric user/bot ID: `1234567890`

To find a chat ID, forward a message from it to [@userinfobot](https://t.me/userinfobot) or check [how to get Telegram chat ID](https://stackoverflow.com/a/32572159).

### 4. Add OpenAI API key

```
OPENAI_API_KEY=sk-proj-...
```

### 5. Run

```bash
npm run dev
# Opens at http://localhost:5173
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | For Whisper STT |
| `TELEGRAM_API_ID` | ✅ | From my.telegram.org/apps |
| `TELEGRAM_API_HASH` | ✅ | From my.telegram.org/apps |
| `TELEGRAM_SESSION_STRING` | ✅ | gramjs auth token (run generate-session) |
| `TELEGRAM_TARGET_CHAT_ID` | ✅ | Chat to send/receive messages |
| `BACKEND_PORT` | ❌ | Backend port (default: 3001) |

## Features

- **VAD auto-record** — no button tapping; speaks when you do, stops on silence
- **Push-to-talk** — tap 🎤 or press Space as fallback
- **Microphone calibration** — drag threshold handle or run calibration wizard
- **Non-blocking audio queue** — receives and queues voice responses immediately, plays in order
- **Minimal noise filtering** — transcriptions under 6 words are discarded
- **Conversation history** — shows sent text + received voice messages

## Tech Stack

- **Frontend**: Vite + React + TypeScript  
- **Backend**: Express + TypeScript  
- **STT**: OpenAI Whisper API  
- **Telegram**: gramjs (MTProto user API)  
- **Audio**: Web Audio API + VAD

## Session String Security

The `TELEGRAM_SESSION_STRING` is equivalent to having your Telegram logged in. It should never be committed to git (`.gitignore` covers `.env`) and should be treated like a password.

If you need to revoke it, go to Telegram Settings → Devices and terminate the active session.
