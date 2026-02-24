# openclaw-telegram-voice-wrapper

## What Is This?

A seamless, conversational voice interface to OpenClaw — powered by Telegram as the backend channel.

Instead of talking *to* OpenClaw directly (like openclaw-whisper), this wrapper sends your voice *through* Telegram. Your words go in as Telegram messages, OpenClaw processes them, and responses come back as Telegram voice bubbles. Everything lives in your Telegram history naturally.

The goal: **term-based talking**. No tapping buttons to start/stop recording. No switching between modes. Just speak — it listens, understands, responds.

## Reference Repos

- [`etdofreshai/openclaw-whisper`](https://github.com/etdofreshai/openclaw-whisper) — auto-record / VAD (voice activity detection), silence detection, push-to-talk
- [`etdofreshai/openclaw-realtime`](https://github.com/etdofreshai/openclaw-realtime) — real-time audio streaming, low-latency playback

## Features

### Voice Input
- **Auto-record mode** (from openclaw-whisper) — VAD detects when you start/stop speaking, no button needed
- **Silence detection** — stops recording after configurable silence threshold
- Transcribed via OpenAI Whisper (STT)

### Telegram Integration
- Sends transcribed text as a Telegram message (via bot or user API)
- OpenClaw receives it, processes it, responds via Telegram
- Response arrives as a Telegram voice bubble (TTS via gpt-4o-mini-tts)
- Full conversation history lives in Telegram natively

### Real-Time Audio Output (from openclaw-realtime)
- Plays incoming audio response as it streams in — no waiting for the full clip
- Low-latency feel: hear the response start before it finishes generating

### Conversational Flow
- Hear response → automatically arms the mic for next input
- No manual tap to re-enable — it's a continuous conversation loop
- Interrupt support: speaking while response is playing cancels playback and records new input

## Architecture

```
[Mic + VAD]
     ↓ (auto-detected speech)
[Whisper STT]
     ↓ (transcribed text)
[Telegram Bot API / User API]
     ↓ (message sent as ET)
[OpenClaw via Telegram channel]
     ↓ (response delivered as voice bubble)
[Real-time audio playback]
     ↓ (finished playing)
[Mic re-arms → loop]
```

## Tech Stack
- Frontend: Vite + React + TypeScript (Live Edit compatible)
- Backend: Express + TypeScript
- STT: OpenAI Whisper API
- TTS: OpenClaw handles it (gpt-4o-mini-tts via Telegram)
- Telegram: Bot API (or MTProto user API for sending as ET)
- Audio: Web Audio API + VAD (from openclaw-whisper)
- Streaming playback: (from openclaw-realtime)

## Open Questions
- **Telegram send method**: Bot API (easier, messages appear from bot) vs MTProto user API (messages appear from ET, feels native) — user API requires gramjs + phone auth
- **Interrupt handling**: How aggressive should interruption be? Configurable threshold?
- **Multi-device**: Should mic input be lockable to one device at a time?

## Non-Goals
- Not a replacement for openclaw-whisper (which talks directly to OpenClaw gateway)
- Not a general Telegram client — just the voice loop
