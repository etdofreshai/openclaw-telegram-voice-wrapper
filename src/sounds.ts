// Synthesized UI sounds using Web Audio API

// ─── Sound Settings ─────────────────────────────────────────────────────
export interface SoundSettings {
  recordStart: boolean
  recordStop: boolean
  sendSuccess: boolean
  responseReceived: boolean
  error: boolean
  thinking: boolean
  calibration: boolean
  vadSpeechStart: boolean
  vadListening: boolean
  tooShort: boolean
  cancel: boolean
}

const DEFAULT_SETTINGS: SoundSettings = {
  recordStart: true,
  recordStop: true,
  sendSuccess: true,
  responseReceived: true,
  error: true,
  thinking: true,
  calibration: true,
  vadSpeechStart: true,
  vadListening: true,
  tooShort: true,
  cancel: true,
}

export const SOUND_LABELS: Record<keyof SoundSettings, string> = {
  recordStart: 'Recording start',
  recordStop: 'Recording stop',
  sendSuccess: 'Send success',
  responseReceived: 'Response received',
  error: 'Error tone',
  thinking: 'Thinking loop',
  calibration: 'Calibration beep',
  vadSpeechStart: 'VAD speech detected',
  vadListening: 'VAD listening',
  tooShort: 'Too short warning',
  cancel: 'Cancel sound',
}

let soundSettings: SoundSettings = { ...DEFAULT_SETTINGS }

function loadSettings(): SoundSettings {
  try {
    const saved = localStorage.getItem('voice-sound-settings')
    if (saved) return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS }
}

soundSettings = loadSettings()

export function getSoundSettings(): SoundSettings { return { ...soundSettings } }

export function setSoundSettings(s: SoundSettings) {
  soundSettings = { ...s }
  localStorage.setItem('voice-sound-settings', JSON.stringify(s))
}

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  // Resume if suspended (mobile autoplay policy)
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/** Call on user gesture to unlock AudioContext for mobile */
export function unlockAudioCtx() {
  const ctx = getCtx();
  if (ctx.state === 'suspended') ctx.resume();
}

function playTone(freq: number, duration: number, type: OscillatorType = 'sine', volume = 0.15, startTime = 0) {
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, ctx.currentTime + startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime + startTime);
  osc.stop(ctx.currentTime + startTime + duration);
}

/** Short ascending boop — mic started */
export function soundRecordStart() {
  if (!soundSettings.recordStart) return;
  playTone(440, 0.08, 'sine', 0.35);
  playTone(587, 0.08, 'sine', 0.35, 0.07);
}

/** Short descending boop — mic stopped */
export function soundRecordStop() {
  if (!soundSettings.recordStop) return;
  playTone(587, 0.08, 'sine', 0.35);
  playTone(440, 0.08, 'sine', 0.35, 0.07);
}

/** Quick blip — sent successfully */
export function soundSendSuccess() {
  if (!soundSettings.sendSuccess) return;
  playTone(880, 0.06, 'sine', 0.3);
  playTone(1047, 0.08, 'sine', 0.3, 0.06);
}

/** Positive chime — response received */
export function soundResponseReceived() {
  if (!soundSettings.responseReceived) return;
  playTone(523, 0.1, 'sine', 0.35);
  playTone(659, 0.1, 'sine', 0.35, 0.1);
  playTone(784, 0.15, 'sine', 0.35, 0.2);
}

/** Error tone — request failed */
export function soundError() {
  if (!soundSettings.error) return;
  playTone(330, 0.15, 'square', 0.3);
  playTone(262, 0.25, 'square', 0.3, 0.15);
}

// --- Thinking loop (doot-doot-doot pattern) ---
let thinkingInterval: ReturnType<typeof setInterval> | null = null;
let thinkingStep = 0;

/** Start quiet repeating doot-doot pattern while thinking */
export function startThinkingSound() {
  if (!soundSettings.thinking) return;
  stopThinkingSound();
  thinkingStep = 0;
  playThinkingPattern();
  thinkingInterval = setInterval(playThinkingPattern, 2000);
}

function playThinkingPattern() {
  // Triple beep: beep-beep-beep, silence, repeat
  const vol = 0.12;
  const freq = 392; // G4
  playTone(freq, 0.06, 'sine', vol);
  playTone(freq, 0.06, 'sine', vol, 0.12);
  playTone(freq, 0.06, 'sine', vol, 0.24);
  thinkingStep++;
}

/** Stop thinking sound */
export function stopThinkingSound() {
  if (thinkingInterval) {
    clearInterval(thinkingInterval);
    thinkingInterval = null;
  }
  thinkingStep = 0;
}

/** Calibration beep — short high tone */
export function soundCalibrationBeep() {
  if (!soundSettings.calibration) return;
  playTone(1000, 0.15, 'sine', 0.2);
}

/** VAD speech detected — very subtle tick */
export function soundVadSpeechStart() {
  if (!soundSettings.vadSpeechStart) return;
  playTone(600, 0.04, 'sine', 0.06);
}

/** VAD listening resumed — gentle rising tone */
export function soundVadListening() {
  if (!soundSettings.vadListening) return;
  playTone(440, 0.06, 'sine', 0.08);
  playTone(550, 0.06, 'sine', 0.08, 0.06);
}

/** Recording too short — punchy error buzz */
export function soundTooShort() {
  if (!soundSettings.tooShort) return;
  playTone(370, 0.12, 'square', 0.25);
  playTone(280, 0.18, 'square', 0.25, 0.1);
}

export function soundCancel() {
  if (!soundSettings.cancel) return;
  playTone(440, 0.08, 'square', 0.2);
  playTone(330, 0.08, 'square', 0.2, 0.08);
  playTone(220, 0.12, 'square', 0.2, 0.16);
}
