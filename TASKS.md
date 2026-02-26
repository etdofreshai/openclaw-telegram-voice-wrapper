# Tasks & Roadmap

_(All pending tasks completed!)_

## Completed (Feb 26)
- ✅ Fixed VAD timeout (30s → 120s → 300s / 5 minutes)
- ✅ Increased minimum duration check for push-to-talk (2.5 seconds)
- ✅ Added audio feedback beep for rejected short recordings
- ✅ Implemented swipe-to-cancel gesture for PTT
- ✅ Documented VAD interruption state machine (`VAD-INTERRUPTION-LOGIC.md`)
- ✅ Added minimum duration check for VAD auto-record (2.5 seconds, same as PTT)
- ✅ Fixed swipe-to-cancel triggering prematurely on Windows mouse drag
- ✅ Auto-mark individual messages as read when received
- ✅ Mark all messages in channel as read when channel is selected
- ✅ Fixed recording UI overlap — aligned recording status to top of PTT button
- ✅ Context-aware PTT bottom bar — controls fade during recording/waiting, status messages show progress
- ✅ Context-aware VAD bottom bar — pulsing indicators, progressive UI showing only relevant controls per state
- ✅ Fixed "typing" indicator persistence — added suppression window to prevent late typing events from re-activating
