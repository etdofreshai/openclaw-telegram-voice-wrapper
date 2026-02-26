import { useEffect, useRef, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { VAD } from './vad'
import {
  soundRecordStart, soundRecordStop, soundSendSuccess, soundError,
  soundVadSpeechStart,
  soundVadListening, soundTooShort, soundCalibrationBeep, unlockAudioCtx,
  startThinkingSound, stopThinkingSound,
} from './sounds'

const BASE = import.meta.env.BASE_URL

type AppStatus = 'idle' | 'listening' | 'recording' | 'waiting' | 'playing'

interface Message {
  role: 'user' | 'assistant'
  text: string
  audioUrl?: string
  timestamp: number
  quotedText?: string
  messageId?: number
  isError?: boolean
}

interface TelegramDialog {
  id: string
  name: string
  title: string
  isUser: boolean
  isGroup: boolean
  isChannel: boolean
  unreadCount: number
  pinned: boolean
  archived: boolean
  lastMessage: string
}

const STATUS_LABELS: Record<AppStatus, string> = {
  idle: 'Idle',
  listening: 'Listening...',
  recording: 'Recording...',
  waiting: 'Waiting...',
  playing: 'Playing...',
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
  // ─── Auth gate ────────────────────────────────────────────────────────────
  const [authChecked, setAuthChecked] = useState(false)
  const [authRequired, setAuthRequired] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [authPassword, setAuthPassword] = useState('')
  const [authError, setAuthError] = useState('')

  useEffect(() => {
    fetch(`${BASE}api/auth-required`)
      .then((r) => r.json())
      .then((data) => {
        setAuthRequired(data.required)
        if (!data.required) {
          setAuthenticated(true)
        } else {
          // Check localStorage for saved auth
          const saved = localStorage.getItem('voice-auth-token')
          if (saved) {
            fetch(`${BASE}api/auth`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: saved }),
            })
              .then((r) => r.json())
              .then((d) => { if (d.ok) setAuthenticated(true) })
              .catch(() => { /* needs manual entry */ })
          }
        }
        setAuthChecked(true)
      })
      .catch(() => {
        // If server is down, skip auth
        setAuthChecked(true)
        setAuthenticated(true)
      })
  }, [])

  const handleAuth = useCallback(async () => {
    setAuthError('')
    try {
      const res = await fetch(`${BASE}api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: authPassword }),
      })
      const data = await res.json()
      if (data.ok) {
        localStorage.setItem('voice-auth-token', authPassword)
        setAuthenticated(true)
      } else {
        setAuthError(data.error || 'Wrong password')
      }
    } catch {
      setAuthError('Connection failed')
    }
  }, [authPassword])

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
  const [tooShortToast, setTooShortToast] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(() => {
    try { return parseFloat(localStorage.getItem('voice-playback-speed') || '1') || 1 }
    catch { return 1 }
  })
  const [vadSilenceMs, setVadSilenceMs] = useState(() => {
    try { return parseInt(localStorage.getItem('vad-silence-ms') || '2000') || 2000 }
    catch { return 2000 }
  })

  // Typing indicator
  const [typingAction, setTypingAction] = useState<string | null>(null)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Chat selection
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [dialogs, setDialogs] = useState<TelegramDialog[]>([])
  const [dialogsLoading, setDialogsLoading] = useState(false)
  const [dialogSearch, setDialogSearch] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)

  // Refs for non-reactive state
  const wsRef = useRef<WebSocket | null>(null)
  const vadRef = useRef<VAD | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const recordingStartRef = useRef(0)
  const cancelRecordingRef = useRef(false)
  const isStoppingRef = useRef(false)
  const touchActiveRef = useRef(false)
  const audioQueueRef = useRef<string[]>([])
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)
  const ttsPlayingRef = useRef(false)
  const statusRef = useRef<AppStatus>('idle')
  const meterStartedRef = useRef(false)
  const threshWrapRef = useRef<HTMLElement | null>(null)
  const threshHandleRef = useRef<HTMLElement | null>(null)
  const conversationRef = useRef<HTMLDivElement>(null)
  const playbackSpeedRef = useRef(playbackSpeed)
  const vadEnabledRef = useRef(vadEnabled)
  const vadSilenceMsRef = useRef(vadSilenceMs)

  // Auto-scroll to bottom and apply playback speed when messages change
  useEffect(() => {
    if (conversationRef.current && messages.length > 0) {
      // Use setTimeout(0) to ensure DOM has painted the new messages
      setTimeout(() => {
        if (conversationRef.current) {
          conversationRef.current.scrollTop = conversationRef.current.scrollHeight
        }
        document.querySelectorAll('.conversation audio').forEach((a) => {
          (a as HTMLAudioElement).playbackRate = playbackSpeedRef.current
        })
      }, 0)
    }
  }, [messages])

  // Synchronous status update — prevents race conditions where VAD callbacks
  // read statusRef before a useEffect can sync it
  const updateStatus = useCallback((s: AppStatus) => {
    statusRef.current = s
    setStatus(s)
  }, [])

  // Keep refs in sync
  useEffect(() => { ttsPlayingRef.current = ttsPlaying }, [ttsPlaying])
  useEffect(() => { vadEnabledRef.current = vadEnabled }, [vadEnabled])

  // Play doot-doot-doot loop while Telegram typing indicator is active
  useEffect(() => {
    if (typingAction) {
      startThinkingSound()
    } else {
      stopThinkingSound()
    }
    return () => stopThinkingSound()
  }, [typingAction])
  useEffect(() => {
    vadSilenceMsRef.current = vadSilenceMs
    localStorage.setItem('vad-silence-ms', String(vadSilenceMs))
    if (vadRef.current) vadRef.current.setSilenceMs(vadSilenceMs)
  }, [vadSilenceMs])
  useEffect(() => {
    playbackSpeedRef.current = playbackSpeed
    localStorage.setItem('voice-playback-speed', String(playbackSpeed))
    // Update all existing audio elements
    document.querySelectorAll('.conversation audio').forEach((a) => {
      (a as HTMLAudioElement).playbackRate = playbackSpeed
    })
    if (ttsAudioRef.current) ttsAudioRef.current.playbackRate = playbackSpeed
  }, [playbackSpeed])

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
      if (vadRef.current && vadEnabledRef.current) {
        vadRef.current.resume()
        soundVadListening()
        updateStatus('listening')
      } else {
        updateStatus('idle')
      }
      return
    }
    const url = queue.shift()!
    setAudioQueueLen(queue.length)
    ttsPlayingRef.current = true
    setTtsPlaying(true)
    updateStatus('playing')
    if (vadRef.current) vadRef.current.pause()
    const a = ensureTtsAudio()
    a.src = url
    a.playbackRate = playbackSpeedRef.current
    a.play().catch((e) => {
      console.warn('Audio play failed:', e)
      setMessages((prev) => [...prev, {
        role: 'assistant',
        text: `⚠️ Audio playback failed: ${(e as Error)?.message || e}`,
        timestamp: Date.now(),
        isError: true,
      }])
      ttsPlayingRef.current = false
      setTtsPlaying(false)
      playNextInQueue()
    })
  }, [ensureTtsAudio])

  const enqueueAudio = useCallback((url: string) => {
    audioQueueRef.current.push(url)
    setAudioQueueLen(audioQueueRef.current.length)
    if (!ttsPlayingRef.current) {
      playNextInQueue()
    }
  }, [playNextInQueue])

  // ─── WebSocket ────────────────────────────────────────────────────────────
  const connectWs = useCallback(() => {
    // Close existing connection to prevent duplicates
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.close()
      wsRef.current = null
    }

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
          if (msg.chatId) {
            setSelectedChatId(msg.chatId)
            loadHistory()
          }
        } else if (msg.type === 'chat_selected') {
          setSelectedChatId(msg.chatId || null)
        } else if (msg.type === 'voice') {
          setTypingAction(null)
          handleIncomingVoice(msg.audioData, msg.messageId, msg.text, msg.quotedText)
        } else if (msg.type === 'text') {
          setTypingAction(null)
          const text = msg.text || ''
          const quotedText = msg.quotedText || ''
          if ((text || quotedText) && text !== 'NO_REPLY' && text !== 'HEARTBEAT_OK') {
            upsertMessage(msg.messageId, { role: 'assistant', text, quotedText: quotedText || undefined, messageId: msg.messageId, timestamp: msg.timestamp || Date.now() })
            // Resume VAD after text-only response (no voice to play)
            if (statusRef.current === 'waiting' && vadRef.current && vadEnabledRef.current) {
              vadRef.current.resume()
              updateStatus('listening')
              soundVadListening()
            }
          }
        } else if (msg.type === 'text_update') {
          setTypingAction(null)
          const text = msg.text || ''
          const quotedText = msg.quotedText || ''
          if (text || quotedText) {
            upsertMessage(msg.messageId, { role: 'assistant', text, quotedText: quotedText || undefined, messageId: msg.messageId, timestamp: msg.timestamp || Date.now() })
          }
        } else if (msg.type === 'typing') {
          setTypingAction(msg.action || 'SendMessageTypingAction')
          if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
          typingTimeoutRef.current = setTimeout(() => setTypingAction(null), 6000)
        } else if (msg.type === 'typing_stop') {
          setTypingAction(null)
          if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
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

  const handleIncomingVoice = useCallback((audioData: string, messageId: number, text?: string, quotedText?: string) => {
    try {
      // Voice arrived — clear typing indicator immediately (don't wait for typing_stop)
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
      setTypingAction(null)

      // Decode base64 OGG → Blob URL
      const bytes = Uint8Array.from(atob(audioData), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: 'audio/ogg' })
      const url = URL.createObjectURL(blob)

      // Add message to conversation
      addMessage({
        role: 'assistant',
        text: text || '',
        quotedText,
        messageId,
        audioUrl: url,
        timestamp: Date.now(),
      })

      // Queue for playback
      enqueueAudio(url)
    } catch (e) {
      console.error('Error handling incoming voice:', e)
      setMessages((prev) => [...prev, {
        role: 'assistant',
        text: `⚠️ Failed to load voice message: ${(e as Error)?.message || e}`,
        timestamp: Date.now(),
        isError: true,
      }])
    }
  }, [enqueueAudio, setMessages, setTypingAction])

  const addMessage = useCallback((msg: Message) => {
    setMessages((prev) => [...prev, msg])
  }, [])

  /** Upsert: update existing message by Telegram messageId, or append if new */
  const upsertMessage = useCallback((messageId: number, msg: Message) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.messageId === messageId)
      if (idx >= 0) {
        const updated = [...prev]
        updated[idx] = { ...updated[idx], text: msg.text, quotedText: msg.quotedText }
        return updated
      }
      return [...prev, msg]
    })
  }, [])

  // ─── Chat selection ─────────────────────────────────────────────────────
  const fetchDialogs = useCallback(async (autoSelect = true) => {
    setDialogsLoading(true)
    try {
      const res = await fetch(`${BASE}api/dialogs`)
      if (!res.ok) throw new Error((await res.json()).error || res.statusText)
      const data = await res.json()
      setDialogs(data.dialogs)
      if (autoSelect && data.currentChatId) setSelectedChatId(data.currentChatId)
    } catch (err: unknown) {
      console.error('Failed to fetch dialogs:', err instanceof Error ? err.message : err)
    } finally {
      setDialogsLoading(false)
    }
  }, [])

  const loadHistory = useCallback(async () => {
    setMessages([])
    setHistoryLoading(true)
    try {
      const histRes = await fetch(`${BASE}api/messages?limit=20`)
      if (histRes.ok) {
        const data = await histRes.json()
        const history: Message[] = (data.messages || []).map((m: { id: number; out: boolean; text: string; quotedText: string; audioData: string | null; date: number }) => {
          const msg: Message = {
            role: m.out ? 'user' : 'assistant',
            text: m.text || '',
            quotedText: m.quotedText || undefined,
            messageId: m.id,
            timestamp: m.date * 1000,
          }
          if (m.audioData) {
            const bytes = Uint8Array.from(atob(m.audioData), (c) => c.charCodeAt(0))
            const blob = new Blob([bytes], { type: 'audio/ogg' })
            msg.audioUrl = URL.createObjectURL(blob)
          }
          return msg
        })
        setMessages(history)
      }
    } catch (histErr) {
      console.error('Failed to fetch message history:', histErr)
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const selectChat = useCallback(async (chatId: string) => {
    try {
      const res = await fetch(`${BASE}api/select-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
      })
      if (!res.ok) throw new Error((await res.json()).error || res.statusText)
      setSelectedChatId(chatId)
      await loadHistory()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Chat selection failed:', msg)
    }
  }, [loadHistory])

  // Auto-fetch dialogs when Telegram connects
  useEffect(() => {
    if (telegramConnected) fetchDialogs()
  }, [telegramConnected, fetchDialogs])

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
      // Cancel any in-progress VAD recording
      if (statusRef.current === 'recording') {
        cancelRecordingRef.current = true
        if (mediaRecorderRef.current?.state !== 'inactive') {
          mediaRecorderRef.current?.stop()
        }
      }
      if (vadRef.current) { vadRef.current.stop(); vadRef.current = null }
      // Reset to idle unless audio is actively playing (let it finish)
      if (statusRef.current !== 'playing') updateStatus('idle')
      return
    }

    setVadEnabled(true)
    updateStatus('listening')

    const vad = new VAD({
      silenceMs: vadSilenceMsRef.current,
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
      updateStatus('idle')
    }
  }, [vadEnabled, unlockAudio, startMeter, updateStatus])

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
    updateStatus('recording')
    soundVadSpeechStart()

    // Safety timeout: force-stop recording after 300s (5 min) to prevent stuck state
    // (30s was too aggressive, 120s still cut off longer recordings)
    setTimeout(() => {
      if (statusRef.current === 'recording' && mediaRecorderRef.current?.state !== 'inactive') {
        console.warn('VAD recording safety timeout (300s) — force stopping')
        vadStopRecording()
      }
    }, 300000)
  }, [updateStatus])

  const vadStopRecording = useCallback(() => {
    const mr = mediaRecorderRef.current
    if (!mr || mr.state === 'inactive') return
    updateStatus('waiting')
    soundRecordStop()
    const captured = mr
    setTimeout(() => {
      if (captured.state !== 'inactive') captured.stop()
    }, 500)
  }, [updateStatus])

  const startManualRecording = useCallback(async () => {
    if (recordingCooldown || vadEnabled) return
    // If mic not yet activated, just request permission and wait — don't try to record
    // (getUserMedia async + permission prompt would leave state broken on release)
    if (!meterStartedRef.current) {
      unlockAudio()
      unlockAudioCtx()
      startMeter()
      return
    }
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
      updateStatus('recording')
      soundRecordStart()
    } catch (err) {
      console.error('Mic error:', err)
      alert('Could not access microphone.')
    }
  }, [recordingCooldown, vadEnabled, unlockAudio, updateStatus, startMeter])

  const stopManualRecording = useCallback(() => {
    if (isStoppingRef.current) return  // guard against double-fire (touch + synthetic mouse events)
    const mr = mediaRecorderRef.current
    if (!mr || mr.state === 'inactive') return
    isStoppingRef.current = true

    const duration = Date.now() - recordingStartRef.current
    const MIN_PTT_DURATION_MS = 2500

    if (duration < MIN_PTT_DURATION_MS) {
      // Too short — cancel recording, don't send
      cancelRecordingRef.current = true
      soundTooShort()
      setTooShortToast(true)
      setTimeout(() => setTooShortToast(false), 2000)
      updateStatus('idle')
      const captured = mr
      setTimeout(() => {
        if (captured.state !== 'inactive') captured.stop()
        isStoppingRef.current = false
      }, 100)
      return
    }

    updateStatus('waiting')
    soundRecordStop()
    const captured = mr
    setTimeout(() => {
      if (captured.state !== 'inactive') captured.stop()
      isStoppingRef.current = false
    }, 500)
  }, [updateStatus])

  const processRecording = useCallback(async () => {
    const duration = Date.now() - recordingStartRef.current
    const chunks = audioChunksRef.current
    if (chunks.length === 0 || duration < 800) {
      if (vadRef.current && vadEnabledRef.current) {
        vadRef.current.resume()
        updateStatus('listening')
        soundVadListening()
      } else {
        updateStatus('idle')
      }
      return
    }

    setRecordingCooldown(true)
    setTimeout(() => setRecordingCooldown(false), 500)

    const blob = new Blob(chunks, { type: getSupportedMimeType() })
    handleRecordingPipeline(blob)
  }, [updateStatus])

  const handleRecordingPipeline = useCallback(async (blob: Blob) => {
    try {
      // 1. Add user voice message to conversation
      const userAudioUrl = URL.createObjectURL(blob)
      addMessage({ role: 'user', text: '', audioUrl: userAudioUrl, timestamp: Date.now() })
      updateStatus('waiting')
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

      if (vadRef.current && vadEnabledRef.current) {
        vadRef.current.resume()
        updateStatus('listening')
        soundVadListening()
      } else {
        updateStatus('idle')
      }
    }
  }, [addMessage, updateStatus])

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
    const applyThresh = (clientX: number) => {
      const rect = wrap.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      const t = pct * THRESH_MAX
      if (vadRef.current) vadRef.current.setEffectiveThreshold(t)
      else setVadThreshold(t)
      handle.style.left = `${Math.min(100, pct * 100)}%`
      const saved = JSON.parse(localStorage.getItem('telegram-voice-calibration') || '{}')
      saved.manualThreshold = t
      localStorage.setItem('telegram-voice-calibration', JSON.stringify(saved))
    }

    // Click anywhere on the bar to jump threshold
    const onBarDown = (e: MouseEvent) => { dragging = true; applyThresh(e.clientX) }
    const onBarTouchStart = (e: TouchEvent) => { dragging = true; e.preventDefault(); applyThresh(e.touches[0].clientX) }
    wrap.addEventListener('mousedown', onBarDown)
    wrap.addEventListener('touchstart', onBarTouchStart, { passive: false })
    const onMove = (e: MouseEvent) => { if (dragging) applyThresh(e.clientX) }
    const onTouchMove = (e: TouchEvent) => { if (dragging) applyThresh(e.touches[0].clientX) }
    const onUp = () => { dragging = false }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('touchmove', onTouchMove, { passive: true })
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchend', onUp)

    return () => {
      wrap.removeEventListener('mousedown', onBarDown)
      wrap.removeEventListener('touchstart', onBarTouchStart)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchend', onUp)
    }
  }, [selectedChatId])

  // ─── Init: WebSocket (stable, runs once) ─────────────────────────────────
  useEffect(() => {
    connectWs()
    return () => {
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [connectWs])

  // ─── Init: Keyboard handler ────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !vadEnabled && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        if (statusRef.current === 'recording') stopManualRecording()
        else if (statusRef.current === 'idle' || statusRef.current === 'listening') startManualRecording()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [startManualRecording, stopManualRecording, vadEnabled])

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
  const chatTitle = dialogs.find((d) => d.id === selectedChatId)?.title || 'Bot'

  // Auth gate
  if (!authChecked) {
    return (
      <div className="app">
        <div className="auth-screen">
          <div className="spinner" />
        </div>
      </div>
    )
  }

  if (authRequired && !authenticated) {
    return (
      <div className="app">
        <div className="auth-screen">
          <div className="auth-box">
            <h2>OpenClaw Voice</h2>
            <p>Enter the password to continue</p>
            <form onSubmit={(e) => { e.preventDefault(); handleAuth() }}>
              <input
                type="password"
                className="auth-input"
                placeholder="Password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                autoFocus
              />
              <button type="submit" className="auth-submit">Enter</button>
            </form>
            {authError && <div className="auth-error">{authError}</div>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      {tooShortToast && (
        <div className="toast-too-short">Hold longer to record (2.5s min)</div>
      )}
      <header>
        {/* Left: back button (returns to chat picker) */}
        <div className="header-left">
          {selectedChatId ? (
            <button
              className="header-back-btn"
              onClick={() => { setSelectedChatId(null); fetchDialogs(false) }}
              title="Switch chat"
            >
              ‹
              {audioQueueLen > 0 && <span className="back-badge">{audioQueueLen}</span>}
            </button>
          ) : (
            <div className="header-back-placeholder" />
          )}
        </div>

        {/* Center: title + subtitle */}
        <div className="header-center">
          <h1>{selectedChatId ? chatTitle : 'OpenClaw Voice'}</h1>
          <div className="subtitle">
            {!wsConnected
              ? 'connecting...'
              : !telegramConnected
                ? 'connecting to Telegram...'
                : selectedChatId
                  ? 'voice chat'
                  : 'select a chat to start'}
          </div>
        </div>

        {/* Right: avatar circle */}
        <div className="header-right">
          <div className="header-avatar">
            {selectedChatId ? chatTitle.charAt(0).toUpperCase() : '📱'}
            <span className={`online-dot ${wsConnected && telegramConnected ? 'online' : ''}`} />
          </div>
        </div>
      </header>

      {/* Chat picker — shown when Telegram is connected but no chat selected */}
      {telegramConnected && !selectedChatId && (
        <div className="chat-picker">
          <div className="chat-picker-header">
            <h2>Select a Chat</h2>
            <p>Choose which Telegram chat to use for voice messages</p>
            <input
              type="text"
              className="chat-search"
              placeholder="Search chats..."
              value={dialogSearch}
              onChange={(e) => setDialogSearch(e.target.value)}
            />
          </div>

          {dialogsLoading && (
            <div className="chat-picker-loading">
              <div className="spinner" />
              <span>Loading chats...</span>
            </div>
          )}

          {!dialogsLoading && (
            <div className="chat-list">
              {dialogs
                .filter((d) => !d.archived)
                .filter((d) => {
                  if (!dialogSearch) return true
                  const q = dialogSearch.toLowerCase()
                  return d.name.toLowerCase().includes(q) || d.title.toLowerCase().includes(q)
                })
                .map((d) => (
                  <button
                    key={d.id}
                    className={`chat-item ${d.pinned ? 'pinned' : ''}`}
                    onClick={() => selectChat(d.id)}
                  >
                    <div className="chat-item-icon">
                      {d.isUser ? '👤' : d.isChannel ? '📢' : '👥'}
                    </div>
                    <div className="chat-item-info">
                      <div className="chat-item-name">
                        {d.title || d.name}
                        {d.pinned && <span className="pin-badge">pinned</span>}
                      </div>
                      <div className="chat-item-preview">
                        {d.lastMessage || 'No messages'}
                      </div>
                    </div>
                    {d.unreadCount > 0 && (
                      <div className="chat-item-unread">{d.unreadCount}</div>
                    )}
                  </button>
                ))}
            </div>
          )}
        </div>
      )}

      {selectedChatId && (<>
      <div className="conversation" ref={conversationRef}>
        {messages.length === 0 && (
          historyLoading ? (
            <div className="empty-state">
              <div className="spinner" />
              <span>Loading chat history...</span>
            </div>
          ) : (
            <div className="empty-state">
              {micActivated
                ? 'Tap the mic button or enable VAD to start talking'
                : 'Tap 👂 to activate the microphone, then start talking'}
            </div>
          )
        )}

        {messages.map((m, i) => {
          const showSender = m.role === 'assistant' && (i === 0 || messages[i - 1].role !== 'assistant')
          const timeStr = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          return (
            <div key={i} className={`message ${m.role}${m.isError ? ' error' : ''}`}>
              <div className={`bubble${m.isError ? ' error-bubble' : ''}`}>
                {showSender && <div className="sender-name">{chatTitle}</div>}
                {m.quotedText && <div className="quote-inline">{m.quotedText.trim()}</div>}
                {m.text && (
                  <div className="msg-text">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                  </div>
                )}
                {m.audioUrl && (
                  <div className="audio-slot">
                    <audio controls src={m.audioUrl} preload="auto" />
                  </div>
                )}
                <span className="time">{timeStr}</span>
              </div>
            </div>
          )
        })}

        {(isWaiting || typingAction) && (
          <div className="message assistant">
            <div className="bubble typing-bubble">
              {typingAction ? (
                <div className="typing-indicator">
                  <div className="typing-dots"><span /><span /><span /></div>
                  <span>
                    {typingAction === 'SendMessageRecordAudioAction'
                      ? `${chatTitle} is recording audio`
                      : typingAction === 'SendMessageUploadAudioAction'
                        ? `${chatTitle} is sending audio`
                        : `${chatTitle} is typing`}
                  </span>
                </div>
              ) : (
                <div className="thinking">
                  <div className="spinner" />
                  <span>Waiting for audio...</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="controls">
        <div className="controls-row">
          {/* Left group: speed + silence only (grid col 1) */}
          <div className="controls-left">
            <div className="speed-controls">
              <span>Speed</span>
              {[1, 1.25, 1.5, 2].map((s) => (
                <button
                  key={s}
                  className={`speed-btn ${playbackSpeed === s ? 'active' : ''}`}
                  onClick={() => setPlaybackSpeed(s)}
                >
                  {s}x
                </button>
              ))}
            </div>
            <div className="speed-controls">
              <span>Silence</span>
              {[1.5, 2, 3, 5].map((s) => (
                <button
                  key={s}
                  className={`speed-btn ${vadSilenceMs === s * 1000 ? 'active' : ''}`}
                  onClick={() => setVadSilenceMs(s * 1000)}
                >
                  {s}s
                </button>
              ))}
            </div>
          </div>

          {/* Narrow-only left: status shown left of PTT in portrait (hidden on wide) */}
          <div className="narrow-left">
            <div className={`status-indicator ${status}`}>
              {STATUS_ICONS[status]} {STATUS_LABELS[status]}
            </div>
            {!micActivated && (
              <button
                className="btn"
                title="Activate microphone"
                onClick={() => { unlockAudio(); unlockAudioCtx(); startMeter() }}
              >
                👂
              </button>
            )}
          </div>

          {/* Hold-to-talk (grid col 2 — always centered) */}
          <button
            className={`ptt-btn ${isRecording ? 'recording' : ''}`}
            disabled={recordingCooldown || vadEnabled}
            onMouseDown={(e) => { if (touchActiveRef.current) return; e.preventDefault(); startManualRecording() }}
            onMouseUp={() => { if (touchActiveRef.current) return; if (isRecording) stopManualRecording() }}
            onMouseLeave={() => { if (touchActiveRef.current) return; if (isRecording) stopManualRecording() }}
            onTouchStart={(e) => { e.preventDefault(); touchActiveRef.current = true; startManualRecording() }}
            onTouchEnd={(e) => { e.preventDefault(); if (isRecording) stopManualRecording(); setTimeout(() => { touchActiveRef.current = false }, 1000) }}
            onContextMenu={(e) => e.preventDefault()}
            title="Hold to talk"
          >
            🎙️
          </button>

          {/* Right group: status + buttons (grid col 3) */}
          <div className="controls-right">
            <div className={`status-indicator ${status}`}>
              {STATUS_ICONS[status]} {STATUS_LABELS[status]}
            </div>
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
            <button
              className={`vad-btn ${vadEnabled ? 'active' : ''}`}
              onClick={toggleVad}
              title="Toggle Voice Activity Detection"
            >
              {vadEnabled ? '🔴' : '🎙️'}
            </button>

            <button
              className={`vad-btn ${isRecording ? 'active recording-toggle' : ''}`}
              disabled={recordingCooldown || vadEnabled}
              onClick={() => {
                if (isRecording) stopManualRecording()
                else startManualRecording()
              }}
              title="Toggle recording (or press Space)"
            >
              {isRecording ? '⏹' : '🎤'}
            </button>
          </div>
        </div>

        {/* Level meter + threshold handle */}
        <div className="threshold-bar-wrap" title="Drag to set VAD threshold">
          <div className="threshold-fill" id="threshFill" />
          <div className="threshold-handle" id="threshHandle" />
        </div>
      </div>
      </>)}
    </div>
  )
}
