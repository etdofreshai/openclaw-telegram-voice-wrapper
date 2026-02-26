# VAD Interruption & State Logic

## State Machine

The app has 5 states (`AppStatus`): **idle**, **listening**, **recording**, **waiting**, **playing**

```
┌──────────────────────────────────────────────────────────────────┐
│                        STATE DIAGRAM                             │
│                                                                  │
│   ┌──────┐  toggleVad()   ┌───────────┐  VAD detects speech     │
│   │ IDLE │ ──────────────→│ LISTENING  │─────────────────────┐   │
│   └──────┘                └───────────┘                      │   │
│      ↑                      ↑   ↑   ↑                       ▼   │
│      │                      │   │   │                  ┌──────────┐
│      │            queue     │   │   │ error/           │RECORDING │
│      │            empty     │   │   │ too short        └──────────┘
│      │              │       │   │   │ (discard)             │
│   ┌──────────┐      │       │   │   │                       │
│   │ PLAYING  │──────┘       │   │   │      VAD silence      │
│   └──────────┘              │   │   │      detected         │
│      ↑                      │   │   │                       ▼
│      │  voice msg arrives   │   │   │                 ┌──────────┐
│      │  via WebSocket       │   │   └─────────────────│ WAITING  │
│      └──────────────────────┘   │                     └──────────┘
│                                 │                           │
│                                 │   text-only response      │
│                                 │   (no voice to play)      │
│                                 └───────────────────────────┘
└──────────────────────────────────────────────────────────────────┘
```

## State Details

### 1. IDLE
- VAD is off. Nothing happening.
- **Can record:** Only via manual PTT (hold mic button / spacebar)

### 2. LISTENING 👂
- VAD is on and actively analyzing mic input every 50ms
- Waiting for RMS level to exceed threshold
- **Can interrupt:** YES — this is the "ready" state. Just start talking.
- **TTS not playing**, VAD not paused

### 3. RECORDING 🔴
- VAD detected speech → `onSpeechStart` callback fired
- `vadStartRecording()` creates a `MediaRecorder` on the VAD's mic stream
- Audio chunks accumulate in `audioChunksRef`
- **Can interrupt:** NO — you're already recording. Just keep talking.
- Ends when: VAD detects silence for `silenceMs` (default 2000ms, configurable 1.5-5s)
- Safety timeout: force-stops after 300s (5 min)

### 4. WAITING ⏳
- Recording stopped, audio sent to Telegram as voice note
- Pipeline: `vadStopRecording()` → `processRecording()` → `handleRecordingPipeline()`
- VAD is **NOT resumed** — it stays paused during waiting
- **Can interrupt:** NO — VAD is paused, mic input is ignored
- Exits when: voice/text response arrives via WebSocket

### 5. PLAYING 🔊
- TTS audio response is playing back
- VAD is explicitly **paused** (`vadRef.current.pause()`)
- Audio queue may have multiple clips
- **Can interrupt:** NO — VAD is paused, won't detect speech
- Exits when: audio queue empties → `playNextInQueue()` calls `vadRef.current.resume()` → back to LISTENING

## The Interrupt Mechanism (or lack thereof)

### Key Finding: **There is NO true interruption in VAD mode.**

Once you're past LISTENING, you cannot interrupt until the full cycle completes:

```
LISTENING → RECORDING → WAITING → PLAYING → (queue empty) → LISTENING
     ↑                                                            │
     └────────────────── ONLY HERE can you talk again ────────────┘
```

### Why you can't interrupt during PLAYING:
- `playNextInQueue()` calls `vad.pause()` before playing audio
- While paused, `VAD.analyze()` returns immediately: `if (!this.active || this.paused) return;`
- VAD only resumes when the **entire audio queue is empty** (all clips played)
- There's no "barge-in" / interrupt mechanism

### Why you can't interrupt during WAITING:
- VAD is not resumed after sending — it stays in whatever state
- `processRecording()` only resumes VAD on error or if recording was too short
- Normal flow: status goes to 'waiting', VAD stays dormant until response arrives

## Recording Pipeline (detailed)

```
1. VAD.analyze() detects RMS > threshold
   └→ onSpeechStart callback
      └→ vadStartRecording()
         ├─ Guard: only if status === 'listening' (prevents double-start)
         ├─ Creates MediaRecorder on VAD's mic stream
         ├─ Sets status → 'recording'
         └─ Plays subtle tick sound

2. VAD.analyze() detects silence > silenceMs
   └→ onSpeechEnd callback (if speech ≥ minSpeechMs=1500ms)
      └→ vadStopRecording()
         ├─ Sets status → 'waiting'
         ├─ Plays stop sound
         └─ Stops MediaRecorder (after 500ms delay)

   └→ onSpeechTooShort callback (if speech < 1500ms)
      ├─ Sets cancelRecordingRef = true
      ├─ Stops MediaRecorder (chunks discarded in onstop handler)
      └─ Plays "too short" error sound
      └─ Status stays wherever it was (no resume to listening!)
      ⚠️ BUG?: After too-short in VAD mode, status isn't reset to 'listening'

3. MediaRecorder.onstop fires
   └→ If cancelRecordingRef: discard chunks, return
   └→ processRecording()
      ├─ If chunks empty or duration < 800ms: resume VAD → LISTENING
      └─ Otherwise: handleRecordingPipeline(blob)

4. handleRecordingPipeline(blob)
   ├─ Adds user message to UI
   ├─ Sets status → 'waiting'
   ├─ Plays send sound
   ├─ POST /api/send-voice (FormData with audio blob)
   │   └─ Server converts to OGG Opus via ffmpeg
   │   └─ Sends as Telegram voice note via MTProto
   └─ On error: resume VAD → LISTENING

5. Response arrives via WebSocket
   ├─ Voice: ws message type='voice'
   │   └─ handleIncomingVoice() → enqueueAudio()
   │      └─ playNextInQueue() → status → 'playing', vad.pause()
   │      └─ Audio plays... ended event → playNextInQueue()
   │      └─ Queue empty → vad.resume() → status → 'listening' ✅
   │
   └─ Text-only: ws message type='text'
       └─ If status === 'waiting' && VAD enabled:
          └─ vad.resume() → status → 'listening' ✅
```

## Buffers & Queues

| Buffer | Location | Purpose |
|--------|----------|---------|
| `audioChunksRef` | App.tsx | Raw MediaRecorder chunks (current recording) |
| `audioQueueRef` | App.tsx | Queue of blob URLs for TTS playback |
| `VAD.dataArray` | vad.ts | Float32Array for RMS analysis (not audio storage) |

- **Audio queue** (`audioQueueRef`): Multiple voice responses can queue up. Each plays sequentially. VAD only resumes after ALL are played.
- **No send queue**: There's no queue for outgoing messages. One recording → one send → wait for response.

## Code References

| Function | File | Purpose |
|----------|------|---------|
| `toggleVad()` | App.tsx | Enable/disable VAD mode |
| `vadStartRecording()` | App.tsx | Start MediaRecorder when VAD detects speech |
| `vadStopRecording()` | App.tsx | Stop recording when VAD detects silence |
| `processRecording()` | App.tsx | Validate recording, hand off to pipeline |
| `handleRecordingPipeline()` | App.tsx | Send audio to server, handle response |
| `playNextInQueue()` | App.tsx | Play next TTS clip or resume VAD |
| `enqueueAudio()` | App.tsx | Add voice response to playback queue |
| `VAD.analyze()` | vad.ts | Core 50ms loop: RMS check → speech start/end |
| `VAD.pause()` | vad.ts | Disable analysis (during playback) |
| `VAD.resume()` | vad.ts | Re-enable analysis (after playback) |

## TL;DR for ET

**When can you talk over OpenClaw?**

| State | Can you interrupt? | What happens if you try? |
|-------|-------------------|-------------------------|
| **Listening** 👂 | ✅ YES | VAD picks up your speech, starts recording |
| **Recording** 🔴 | 🟡 You're already talking | Just keep going, it's capturing |
| **Waiting** ⏳ | ❌ NO | Mic input ignored until response arrives |
| **Playing** 🔊 | ❌ NO | Mic input ignored until ALL clips finish playing |
| **Idle** ⏸ | ❌ VAD off | Use PTT button instead |

**The cycle:** You talk → silence detected → audio sent → wait → response plays back → *only then* can you talk again.

**There is no barge-in.** You cannot interrupt playback by speaking. You must wait for the full response to finish playing before VAD starts listening again.

### Workarounds
- **Speed up playback**: Use the Speed buttons (1x, 1.25x, 1.5x, 2x) to get through responses faster
- **Shorter silence window**: Set Silence to 1.5s so it stops recording sooner after you pause
- **Manual PTT while VAD is off**: PTT mode pauses any playing audio when you press the button (but PTT is disabled when VAD is on)
