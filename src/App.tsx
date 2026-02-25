import { useEffect, useRef, useState, useCallback } from 'react'
import { VAD } from './vad'
import {
  soundRecordStart, soundRecordStop, soundSendSuccess, soundError,
  soundVadSpeechStart,
  soundVadListening, soundTooShort, soundCalibrationBeep, unlockAudioCtx,
} from './sounds'

const BASE = import.meta.env.BASE_URL

type AppStatus = 'idle' | 'listening' | 'recording' | 'waiting' | 'playing'

interface Message {
  role: 'user' | 'assistant'
  text: string
  audioUrl?: string
  timestamp: number
}

const STATUS_LABELS: Record<AppStatus, string> = {
  idle: '⏸ Idle',
  listening: '👂 Listening...',
  recording: '🔴 Recording...',
  waiting: '⏳ Waiting for response...',
  playing: '🔊 Playing response...',
}

const STATUS_ICONS: Record<AppStatus, string> = {
  idle: '⏸',
  listening: '👂',
  recording: '🔴',
  waiting: '⏳',
  playing: '🔊',
}

const CALIBRATION_PHRASES = [
  'The quick brown fox jumps over the lazy dog near the riverbank on a warm summer evening.',
  'She sells seashells by the seashore while the waves crash gently against the sandy beach.',
  'Every morning I wake up early and make a fresh cup of coffee before starting my daily routine.',
  'The old bookstore on the corner has been there for decades, filled with stories waiting to be read.',
]

const THRESH_MAX = 0.12

export default function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [status, setStatus] = useState<AppStatus>('idle')
  const [wsConnected, setWsConnected] = useState(false)
  const [telegramConnected, setTelegramConnected] = useState(false)
  const [vadEnabled, setVadEnabled] = useState(false)
  const [vadCalibrating, setVadCalibrating] = useState(false)
  const [calibrationStep, setCalibrationStep] = useState<'silence' | 'speak' | 'done' | ''>('')
  const [calibrationPhrase, setCalibrationPhrase] = useState('')
  const [audioQueueLen, setAudioQueueLen] = useState(0)
  const [vadLevel, setVadLevel] = useState(0)
  const [vadThreshold, setVadThreshold] = useState(0)
  const [micActivated, setMicActivated] = useState(false)
  const [recordingCooldown, setRecordingCooldown] = useState(false)
  const [ttsPlaying, setTtsPlaying] = useState(false)

  // Refs for non-reactive state
  const wsRef = useRef<WebSocket | null>(null)
  const vadRef = useRef<VAD | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const recordingStartRef = useRef(0)
  const cancelRecordingRef = useRef(false)
  const audioQueueRef = useRef<string[]>([])
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)
  const ttsPlayingRef = useRef(false)
  const statusRef = useRef<AppStatus>('idle')
  const meterStartedRef = useRef(false)
  const threshWrapRef = useRef<HTMLElement | null>(null)
  const threshHandleRef = useRef<HTMLElement | null>(null)
  const conversationRef = useRef<HTMLDivElement>(null)

  // Keep statusRef in sync
  useEffect(() => { statusRef.current = status }, [status])
  useEffect(() => { ttsPlayingRef.current = ttsPlaying }, [ttsPlaying])

  // ─── Audio queue helpers ──────────────────────────────────────────────────
  const ensureTtsAudio = useCallback((): HTMLAudioElement => {
    if (!ttsAudioRef.current) {
      const a = new Audio()
      a.preload = 'auto'
      a.addEventListener('ended', () => {
        ttsPlayingRef.current = false
        setTtsPlaying(false)
        playNextInQueue()
      })
      a.addEventListener('error', () => {
        ttsPlayingRef.current = false
        setTtsPlaying(false)
        playNextInQueue()
      })
      ttsAudioRef.current = a
    }
    return ttsAudioRef.current
  }, [])

  const playNextInQueue = useCallback(() => {
    const queue = audioQueueRef.current
    if (queue.length === 0) {
      ttsPlayingRef.current = false
      setTtsPlaying(false)
      setAudioQueueLen(0)
      // Re-arm VAD after queue is empty
      if (vadRef.current && vadEnabled) {
        vadRef.current.resume()
        soundVadListening()
        setStatus('listening')
      } else {
        setStatus('idle')
      }
      return
    }
    const url = queue.shift()!
    setAudioQueueLen(queue.length)
    ttsPlayingRef.current = true
    setTtsPlaying(true)
    setStatus('playing')
    if (vadRef.current) vadRef.current.pause()
    const a = ensureTtsAudio()
    a.src = url
    a.play().catch((e) => {
      console.warn('Audio play failed:', e)
      ttsPlayingRef.current = false
      setTtsPlaying(false)
      playNextInQueue()
    })
  }, [vadEnabled, ensureTtsAudio])

  const enqueueAudio = useCallback((url: string) => {
    audioQueueRef.current.push(url)
    setAudioQueueLen(audioQueueRef.current.length)
    if (!ttsPlayingRef.current) {
      playNextInQueue()
    }
  }, [playNextInQueue])

  // ─── WebSocket ────────────────────────────────────────────────────────────
  const connectWs = useCallback(() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${location.host}${BASE}ws`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('WS connected')
      setWsConnected(true)
    }

    ws.onclose = () => {
      console.log('WS disconnected, reconnecting...')
      setWsConnected(false)
      wsRef.current = null
      setTimeout(connectWs, 3000)
    }

    ws.onerror = (err) => console.error('WS error:', err)

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)

        if (msg.type === 'connected') {
          // handshake OK
        } else if (msg.type === 'status') {
          setTelegramConnected(!!msg.telegramConnected)
        } else if (msg.type === 'voice') {
          // Incoming voice OGG from Telegram
          handleIncomingVoice(msg.audioData, msg.messageId)
        } else if (msg.type === 'text') {
          // Incoming text message (also push as assistant message for context)
          if (msg.text && msg.text !== 'NO_REPLY' && msg.text !== 'HEARTBEAT_OK') {
            addMessage({ role: 'assistant', text: msg.text, timestamp: msg.timestamp || Date.now() })
          }
        } else if (msg.type === 'telegram_connected') {
          setTelegramConnected(true)
        } else if (msg.type === 'telegram_disconnected') {
          setTelegramConnected(false)
        }
      } catch (e) {
        console.error('WS parse error:', e)
      }
    }
  }, [])

  const handleIncomingVoice = useCallback((audioData: string, _messageId: number) => {
    try {
      // Decode base64 OGG → Blob URL
      const bytes = Uint8Array.from(atob(audioData), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: 'audio/ogg' })
      const url = URL.createObjectURL(blob)

      // Add message to conversation
      addMessage({
        role: 'assistant',
        text: '🔊 Voice message',
        audioUrl: url,
        timestamp: Date.now(),
      })

      // Queue for playback
      enqueueAudio(url)
    } catch (e) {
      console.error('Error handling incoming voice:', e)
    }
  }, [enqueueAudio])

  const addMessage = useCallback((msg: Message) => {
    setMessages((prev) => [...prev, msg])
    // Scroll to bottom
    requestAnimationFrame(() => {
      if (conversationRef.current) {
        conversationRef.current.scrollTop = conversationRef.current.scrollHeight
      }
    })
  }, [])

  // ─── Mic / Level meter ───────────────────────────────────────────────────
  const startMeter = useCallback(async () => {
    if (meterStartedRef.current) return
    meterStartedRef.current = true
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      setMicActivated(true)
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      ctx.createMediaStreamSource(stream).connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      setInterval(() => {
        if (vadRef.current?.isActive) return
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        const rms = Math.sqrt(sum / buf.length)
        let thresh = 0.03
        try {
          const s = JSON.parse(localStorage.getItem('telegram-voice-calibration') || '{}')
          thresh = s.manualThreshold || 0.03
        } catch { }
        setVadLevel(rms)
        setVadThreshold(thresh)
      }, 50)
    } catch (e) {
      console.warn('Meter mic access failed:', e)
    }
  }, [])

  const unlockAudio = useCallback(() => {
    if (meterStartedRef.current) return
    const a = ensureTtsAudio()
    const wasSrc = a.src
    a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='
    a.play().then(() => {
      a.pause()
      a.currentTime = 0
      ttsPlayingRef.current = false
      if (wasSrc) a.src = wasSrc
    }).catch(() => { ttsPlayingRef.current = false })
    startMeter()
  }, [ensureTtsAudio, startMeter])

  // ─── VAD ─────────────────────────────────────────────────────────────────
  const toggleVad = useCallback(async () => {
    unlockAudio()
    unlockAudioCtx()
    await startMeter()

    if (vadEnabled) {
      setVadEnabled(false)
      if (vadRef.current) { vadRef.current.stop(); vadRef.current = null }
      if (statusRef.current === 'listening') setStatus('idle')
      return
    }

    setVadEnabled(true)
    setStatus('listening')

    const vad = new VAD({
      silenceMs: 2000,
      minSpeechMs: 1500,
      onSpeechStart: () => {
        if (!ttsPlayingRef.current && statusRef.current === 'listening') {
          vadStartRecording()
        }
      },
      onSpeechEnd: () => {
        if (statusRef.current === 'recording') vadStopRecording()
      },
      onSpeechTooShort: () => {
        if (statusRef.current === 'recording') {
          cancelRecordingRef.current = true
          if (mediaRecorderRef.current?.state !== 'inactive') {
            mediaRecorderRef.current?.stop()
          }
        }
        soundTooShort()
      },
      onLevel: (rms, thresh) => {
        setVadLevel(rms)
        setVadThreshold(thresh)
      },
    })

    vadRef.current = vad
    try {
      await vad.start()
      // Restore saved calibration
      try {
        const saved = JSON.parse(localStorage.getItem('telegram-voice-calibration') || '')
        if (saved.noiseFloor != null) vad.setNoiseFloor(saved.noiseFloor)
        if (saved.manualThreshold != null) vad.setEffectiveThreshold(saved.manualThreshold)
      } catch { }
      soundVadListening()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('VAD start failed:', msg)
      alert(`VAD failed: ${msg}`)
      setVadEnabled(false)
      vadRef.current = null
      setStatus('idle')
    }
  }, [vadEnabled, unlockAudio, startMeter])

  // ─── Recording ───────────────────────────────────────────────────────────
  function getSupportedMimeType(): string {
    const types = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    for (const t of types) { if (MediaRecorder.isTypeSupported(t)) return t }
    return 'audio/webm'
  }

  const vadStartRecording = useCallback(() => {
    const vad = vadRef.current
    if (!vad || statusRef.current !== 'listening') return
    const stream = vad.getStream()
    if (!stream) return

    audioChunksRef.current = []
    cancelRecordingRef.current = false
    const mr = new MediaRecorder(stream, { mimeType: getSupportedMimeType() })
    mediaRecorderRef.current = mr

    mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
    mr.onstop = () => {
      if (cancelRecordingRef.current) {
        cancelRecordingRef.current = false
        audioChunksRef.current = []
        return
      }
      processRecording()
    }

    mr.start()
    recordingStartRef.current = Date.now()
    setStatus('recording')
    soundVadSpeechStart()
  }, [])

  const vadStopRecording = useCallback(() => {
    const mr = mediaRecorderRef.current
    if (!mr || mr.state === 'inactive') return
    setStatus('waiting')
    soundRecordStop()
    const captured = mr
    setTimeout(() => {
      if (captured.state !== 'inactive') captured.stop()
    }, 500)
  }, [])

  const startManualRecording = useCallback(async () => {
    if (recordingCooldown || vadEnabled) return
    unlockAudio()
    unlockAudioCtx()
    // Pause playing audio while recording
    if (ttsAudioRef.current && !ttsAudioRef.current.paused) {
      ttsAudioRef.current.pause()
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioChunksRef.current = []
      const mr = new MediaRecorder(stream, { mimeType: getSupportedMimeType() })
      mediaRecorderRef.current = mr
      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
      mr.onstop = () => { stream.getTracks().forEach((t) => t.stop()); processRecording() }
      mr.start()
      recordingStartRef.current = Date.now()
      setStatus('recording')
      soundRecordStart()
    } catch (err) {
      console.error('Mic error:', err)
      alert('Could not access microphone.')
    }
  }, [recordingCooldown, vadEnabled, unlockAudio])

  const stopManualRecording = useCallback(() => {
    const mr = mediaRecorderRef.current
    if (!mr || mr.state === 'inactive') return
    setStatus('waiting')
    soundRecordStop()
    const captured = mr
    setTimeout(() => {
      if (captured.state !== 'inactive') captured.stop()
    }, 500)
  }, [])

  const processRecording = useCallback(async () => {
    const duration = Date.now() - recordingStartRef.current
    const chunks = audioChunksRef.current
    if (chunks.length === 0 || duration < 800) {
      if (vadRef.current && vadEnabled) {
        vadRef.current.resume()
        setStatus('listening')
        soundVadListening()
      } else {
        setStatus('idle')
      }
      return
    }

    setRecordingCooldown(true)
    setTimeout(() => setRecordingCooldown(false), 500)

    const blob = new Blob(chunks, { type: getSupportedMimeType() })
    handleRecordingPipeline(blob)
  }, [vadEnabled])

  const handleRecordingPipeline = useCallback(async (blob: Blob) => {
    try {
      // 1. Add user voice message to conversation
      const userAudioUrl = URL.createObjectURL(blob)
      addMessage({ role: 'user', text: 'Voice message', audioUrl: userAudioUrl, timestamp: Date.now() })
      setStatus('waiting')
      soundSendSuccess()

      // 2. Send audio directly as Telegram voice note
      const formData = new FormData()
      formData.append('audio', blob, 'voice.ogg')

      const sendRes = await fetch(`${BASE}api/send-voice`, {
        method: 'POST',
        body: formData,
      })

      if (!sendRes.ok) {
        const err = await sendRes.json().catch(() => ({ error: sendRes.statusText }))
        throw new Error(`Send failed: ${err.error || sendRes.statusText}`)
      }

      // Response will arrive via WebSocket as a voice message
      // Status stays 'waiting' until voice arrives and playback begins
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Pipeline error:', msg)
      soundError()
      addMessage({ role: 'assistant', text: `Error: ${msg}`, timestamp: Date.now() })

      if (vadRef.current && vadEnabled) {
        vadRef.current.resume()
        setStatus('listening')
        soundVadListening()
      } else {
        setStatus('idle')
      }
    }
  }, [vadEnabled, addMessage])

  // ─── Calibration ─────────────────────────────────────────────────────────
  const startCalibration = useCallback(async () => {
    unlockAudio()
    unlockAudioCtx()
    await startMeter()

    let vad = vadRef.current
    const needsStart = !vad
    if (needsStart) {
      vad = new VAD({
        silenceMs: 1500, minSpeechMs: 1500,
        onLevel: (rms, thresh) => { setVadLevel(rms); setVadThreshold(thresh) },
      })
      vadRef.current = vad
      await vad.start()
    }

    setVadCalibrating(true)
    setCalibrationStep('silence')
    setCalibrationPhrase('')
    soundCalibrationBeep()
    await new Promise((r) => setTimeout(r, 500))
    await vad!.calibrate(3000)
    soundCalibrationBeep()
    await new Promise((r) => setTimeout(r, 500))

    const phrase = CALIBRATION_PHRASES[Math.floor(Math.random() * CALIBRATION_PHRASES.length)]
    setCalibrationStep('speak')
    setCalibrationPhrase(phrase)
    soundCalibrationBeep()
    await new Promise((r) => setTimeout(r, 300))

    // Measure speech
    const speechSamples: number[] = []
    const speechStart = Date.now()
    const MIN_SPEECH_MS = 5000
    const SILENCE_MS = 2000
    let lastLoudTime = Date.now()

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (!vadRef.current) { clearInterval(interval); resolve(); return }
        const rms = vadRef.current.getNoiseFloor() ? vadLevel : 0
        speechSamples.push(rms)
        const elapsed = Date.now() - speechStart
        const noiseFloor = vadRef.current.getNoiseFloor()
        if (rms > noiseFloor + 0.005) lastLoudTime = Date.now()
        if (elapsed >= MIN_SPEECH_MS && Date.now() - lastLoudTime >= SILENCE_MS) { clearInterval(interval); resolve() }
        if (elapsed >= 20000) { clearInterval(interval); resolve() }
      }, 50)
    })

    speechSamples.sort((a, b) => a - b)
    const speechMedian = speechSamples[Math.floor(speechSamples.length * 0.5)] || 0
    const noiseFloor = vad!.getNoiseFloor()
    const newThreshold = Math.max(0.01, (speechMedian - noiseFloor) * 0.4)
    vad!.setNoiseFloor(noiseFloor)
    vad!.setEffectiveThreshold(noiseFloor + newThreshold)
    const effectiveThreshold = vad!.getEffectiveThreshold()
    setVadThreshold(effectiveThreshold)
    localStorage.setItem('telegram-voice-calibration', JSON.stringify({ noiseFloor, threshold: newThreshold, manualThreshold: effectiveThreshold }))

    soundCalibrationBeep()
    await new Promise((r) => setTimeout(r, 200))
    soundCalibrationBeep()
    setVadCalibrating(false)
    setCalibrationStep('done')
    setCalibrationPhrase('')

    if (needsStart && !vadEnabled && vadRef.current) {
      vadRef.current.stop()
      vadRef.current = null
    }
    soundVadListening()
  }, [unlockAudio, startMeter, vadEnabled, vadLevel])

  // ─── Threshold drag ───────────────────────────────────────────────────────
  useEffect(() => {
    const wrap = document.querySelector('.threshold-bar-wrap') as HTMLElement | null
    const handle = document.querySelector('.threshold-handle') as HTMLElement | null
    if (!wrap || !handle) return

    threshWrapRef.current = wrap
    threshHandleRef.current = handle

    let dragging = false
    const getThresh = (clientX: number) => {
      const rect = wrap.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return pct * THRESH_MAX
    }
    const applyThresh = (clientX: number) => {
      const t = getThresh(clientX)
      if (vadRef.current) vadRef.current.setEffectiveThreshold(t)
      else setVadThreshold(t)
      const pct = Math.min(100, (t / THRESH_MAX) * 100)
      handle.style.left = `${pct}%`
      const saved = JSON.parse(localStorage.getItem('telegram-voice-calibration') || '{}')
      saved.manualThreshold = t
      localStorage.setItem('telegram-voice-calibration', JSON.stringify(saved))
    }

    handle.addEventListener('mousedown', () => { dragging = true })
    handle.addEventListener('touchstart', (e) => { dragging = true; e.preventDefault() }, { passive: false })
    const onMove = (e: MouseEvent) => { if (dragging) applyThresh(e.clientX) }
    const onTouchMove = (e: TouchEvent) => { if (dragging) applyThresh(e.touches[0].clientX) }
    const onUp = () => { dragging = false }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('touchmove', onTouchMove, { passive: true })
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchend', onUp)

    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchend', onUp)
    }
  })

  // ─── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    connectWs()
    // Keyboard: Space to toggle PTT
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !vadEnabled && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        if (statusRef.current === 'recording') stopManualRecording()
        else if (statusRef.current === 'idle' || statusRef.current === 'listening') startManualRecording()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [connectWs, startManualRecording, stopManualRecording, vadEnabled])

  // ─── Threshold bar visual update ─────────────────────────────────────────
  useEffect(() => {
    const fill = document.getElementById('threshFill')
    const handle = document.getElementById('threshHandle')
    if (fill) {
      const pct = Math.min(100, (vadLevel / THRESH_MAX) * 100)
      fill.style.width = `${pct}%`
      fill.style.background = vadLevel > vadThreshold ? '#a6e3a1' : '#6c7086'
    }
    if (handle) {
      const pct = Math.min(100, (vadThreshold / THRESH_MAX) * 100)
      handle.style.left = `${pct}%`
    }
  }, [vadLevel, vadThreshold])

  // ─── Render ───────────────────────────────────────────────────────────────
  const isRecording = status === 'recording'
  const isWaiting = status === 'waiting'
  const isPlaying = status === 'playing'

  return (
    <div className="app">
      <header>
        <h1>📱 OpenClaw Telegram Voice</h1>
        <div className="subtitle">Voice → Telegram MTProto → Voice response</div>
      </header>

      <div className="status-bar">
        <div className={`status-dot ${wsConnected && telegramConnected ? 'connected' : wsConnected ? 'warning' : ''}`} />
        <span>
          {wsConnected
            ? telegramConnected
              ? '✅ Connected (WS + Telegram)'
              : '⚠️ WS connected, Telegram disconnected'
            : '❌ Disconnected'}
        </span>
        {audioQueueLen > 0 && (
          <span className="queue-badge">{audioQueueLen} queued</span>
        )}
      </div>

      <div className="conversation" ref={conversationRef}>
        {messages.length === 0 && (
          <div className="empty-state">
            {micActivated
              ? 'Tap the mic button or enable VAD to start talking'
              : 'Tap 👂 to activate the microphone, then start talking'}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            <div className={`bubble ${m.role === 'assistant' && m.audioUrl ? 'voice' : ''}`}>
              {m.text}
            </div>
            {m.audioUrl && (
              <div className="audio-slot">
                <audio controls src={m.audioUrl} preload="auto" />
              </div>
            )}
            <div className="meta">{new Date(m.timestamp).toLocaleTimeString()}</div>
          </div>
        ))}

        {isWaiting && (
          <div className="message assistant">
            <div className="thinking">
              <div className="spinner" />
              <span>Waiting for voice response...</span>
            </div>
          </div>
        )}
      </div>

      <div className="controls">
        <div className="controls-row">
          {!micActivated && (
            <button
              className="btn"
              id="activateBtn"
              title="Activate microphone"
              onClick={() => { unlockAudio(); unlockAudioCtx(); startMeter() }}
            >
              👂
            </button>
          )}

          {/* PTT button */}
          <button
            className={`ptt-btn ${isRecording ? 'recording' : ''}`}
            disabled={recordingCooldown || vadEnabled}
            onClick={() => {
              if (isRecording) stopManualRecording()
              else startManualRecording()
            }}
            title="Push-to-talk (or press Space)"
          >
            {isRecording ? '⏹' : '🎤'}
          </button>

          {/* VAD toggle */}
          <button
            className={`vad-btn ${vadEnabled ? 'active' : ''}`}
            onClick={toggleVad}
            title="Toggle Voice Activity Detection"
          >
            {vadEnabled ? '🔴' : '🎙️'}
          </button>

          {/* Calibrate */}
          <button
            className="calibrate-btn"
            disabled={vadCalibrating}
            onClick={startCalibration}
            title="Calibrate microphone threshold"
          >
            {vadCalibrating ? '📊' : '🎚️'}
          </button>

          {/* Status */}
          <div className={`status-indicator ${status}`}>
            {STATUS_ICONS[status]} {STATUS_LABELS[status]}
          </div>

          {/* Clear */}
          <button
            className="clear-btn"
            title="Clear conversation"
            onClick={() => {
              if (confirm('Clear conversation?')) setMessages([])
            }}
          >
            🗑️
          </button>
        </div>

        {/* Calibration state */}
        {vadCalibrating && (
          <div className="vad-status">
            {calibrationStep === 'silence' && (
              <div className="vad-calibrating">🔇 Stay silent for 3 seconds...</div>
            )}
            {calibrationStep === 'speak' && (
              <div className="vad-calibrating">
                🗣️ Read this aloud (stop when done):<br />
                <span className="calibration-phrase">"{calibrationPhrase}"</span>
              </div>
            )}
            {calibrationStep === 'done' && (
              <div className="vad-calibrating">✅ Calibration complete!</div>
            )}
          </div>
        )}

        {/* VAD status */}
        {!vadCalibrating && vadEnabled && (
          <div className="vad-status">
            <div className="vad-listening">
              {ttsPlaying
                ? `⏸️ Paused (${audioQueueLen + 1} in queue)`
                : isRecording
                  ? '🔴 Recording...'
                  : isPlaying
                    ? '🔊 Playing...'
                    : '👂 Listening...'}
            </div>
          </div>
        )}

        {/* Level meter + threshold handle */}
        <div className="threshold-bar-wrap" title="Drag to set VAD threshold">
          <div className="threshold-fill" id="threshFill" />
          <div className="threshold-handle" id="threshHandle" />
        </div>
      </div>
    </div>
  )
}
