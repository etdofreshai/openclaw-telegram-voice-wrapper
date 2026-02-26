# Tasks & Roadmap

## 1. Fix Recording UI Overlap with Swipe-to-Cancel
**Priority:** High  
**Status:** Pending

Move the recording status message from its current position (middle/bottom) to the **top of the container** so it doesn't overlap with the swipe-to-cancel zone.

**Details:**
- Recording status should appear at the top
- Should not interfere with the left cancel area or PTT button zone
- Clean, minimal layout

---

## 2. Context-Aware Bottom Bar - Push-to-Talk Mode
**Priority:** High  
**Status:** Pending

Make the bottom control bar context-sensitive during push-to-talk:

**During recording (holding PTT):**
- Show ONLY the PTT button and the left cancel area
- Fade out all other controls, buttons, options
- Keep it minimal and focused

**After release (waiting for response):**
- Keep controls hidden/faded while waiting for transcription + response
- Show status message of what's happening
- Once ready for next input, fade controls back in

**Goal:** Clean, distraction-free UX while recording and waiting.

---

## 3. Context-Aware Bottom Bar - VAD / Auto-Record Mode
**Priority:** High  
**Status:** Pending

Make the bottom control bar context-sensitive during VAD (auto-record) mode:

**When entering VAD:**
- Main center button becomes the "Cancel Auto-Record" button
- Show recording/listening status (if applicable)

**While actively recording:**
- Only show the cancel auto-record button
- Fade other controls

**While waiting for response (transcribing or waiting for reply):**
- Hide the cancel button
- Show clear status message: "Waiting for answer...", "Processing audio...", etc.
- This gives visual feedback without clutter

**When ready for next utterance:**
- Cancel button reappears
- Status indicators come back if needed
- Return to normal listening state UI

**Goal:** Clear, progressive UI that shows only what matters at each stage. User always knows what's happening without looking at text.

---

## 4. Fix "OpenClaw is typing" Indicator Not Clearing
**Priority:** Medium  
**Status:** Pending

The Telegram "is typing" indicator stays active even after the audio response has been received and played. This was supposedly fixed before but has regressed.

**Details:**
- Response arrives and audio plays
- "OpenClaw is typing..." still shows in the chat
- Should clear as soon as audio starts playing or response is complete

**Root cause:** Likely the typing state isn't being cleared after the TTS response completes. May need to hook into the audio player's `onended` event or the response handler.

---

## Completed
- ✅ Fixed VAD timeout (30s → 120s → 300s / 5 minutes)
- ✅ Increased minimum duration check for push-to-talk (2.5 seconds)
- ✅ Added audio feedback beep for rejected short recordings
- ✅ Implemented swipe-to-cancel gesture for PTT
- ✅ Documented VAD interruption state machine (`VAD-INTERRUPTION-LOGIC.md`)
- ✅ Added minimum duration check for VAD auto-record (2.5 seconds, same as PTT)
- ✅ Fixed swipe-to-cancel triggering prematurely on Windows mouse drag
- ✅ Auto-mark individual messages as read when received
- ✅ Mark all messages in channel as read when channel is selected
