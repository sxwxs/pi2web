# Project review issues

Review date: 2026-07-23

This document records the findings from the July 2026 project review and their implementation status.

## Fixed

### WebSocket malformed-message handling

- **Severity:** High
- **Area:** Server
- **Problem:** The Agent WebSocket handler parsed a malformed payload again from its error handler. Invalid JSON therefore produced an unhandled promise rejection and could terminate the Node.js process.
- **Resolution:** Parse each payload once, return a safe `BAD_REQUEST` command result, and only send while the socket is open.
- **Regression coverage:** `test/websocket-errors.test.ts`.

### Web server switching could mix two server connections

- **Severity:** Medium
- **Area:** Web UI
- **Problem:** The pairing flow replaced the active base URL and token before validating the candidate server. A failed attempt could leave the old WebSocket active while subsequent HTTP calls targeted the new server.
- **Resolution:** Validate candidate credentials with local values first. Only after validation succeeds are the old sockets closed and the active connection state replaced.

### Exited terminals were retained without a bound

- **Severity:** Medium/low
- **Area:** Server terminal lifecycle
- **Problem:** Only running terminals were limited. Exited terminal records and PTY listener closures could accumulate for the lifetime of the server.
- **Resolution:** PTY subscriptions are now disposed on exit/close, and only the 50 most recently exited terminals are retained by default.
- **Regression coverage:** `test/terminal-lifecycle.test.ts`.

### File paging loaded the complete file and accepted invalid ranges

- **Severity:** Low
- **Area:** Workspace file API
- **Problem:** Every page request read the entire file into memory. Negative, zero, fractional, or unsafe range parameters were not rejected consistently.
- **Resolution:** File pages now use positional `FileHandle.read()` calls and require a non-negative safe-integer offset and a positive safe-integer limit.
- **Regression coverage:** `test/core.test.ts`.

### CI was missing

- **Severity:** Maintenance
- **Area:** Repository automation
- **Resolution:** Added `.github/workflows/ci.yml` to build and test the Node.js server and run Android unit tests with Java 17.

## Deferred: Android

The following findings are intentionally recorded but not fixed in this change, as requested. They should be handled together with Android lifecycle and concurrency tests.

### Agent selection race can mix conversations

- **Severity:** High
- **Location:** `android/app/src/main/java/com/remotepi/app/ui/RemotePiViewModel.kt`
- **Problem:** Rapidly opening Agent A and then Agent B starts independent asynchronous loads. A late response for A can overwrite B's messages/capabilities/session and install an A WebSocket while B remains selected.
- **Recommended fix:** Cancel the previous load or attach a generation ID to each request, and verify the selected Agent before every state update and socket installation. Apply the same pattern to profile connection, browsing, and file loading.

### Notification cursor can skip replay events

- **Severity:** High
- **Location:** `android/app/src/main/java/com/remotepi/app/network/AgentNotificationMonitor.kt`
- **Problem:** The monitor persists `currentSequence` when it receives `subscribed`, before replay events have been processed. If the connection drops at that point, those events will not be requested again and completion notifications can be lost.
- **Recommended fix:** Persist the cursor only after each event or snapshot is processed. Handle first-time `fromNow` subscriptions separately.

### Login eagerly loads every full Agent session

- **Severity:** Medium
- **Location:** `android/app/src/main/java/com/remotepi/app/ui/RemotePiViewModel.kt`
- **Problem:** Login calls the full `/session` endpoint sequentially for every Agent just to retrieve its name. This loads SDK backends/extensions and transfers complete session trees.
- **Recommended fix:** Use the `sessionName` already returned by the Agent list, or add a client method for `/session?summary=true`. Avoid loading sessions that do not need additional metadata.

## Remaining maintenance notes

- `src/server.ts` still combines HTTP routing, WebSocket handling, static assets, and session indexing in one class. Future feature work should split these responsibilities before the route surface grows further.
- The repository still has no dedicated lint/format command. Adding one should be coordinated with a formatting-only change because several existing source and test files are intentionally compressed into very long lines.
- Browser behavior is currently covered indirectly through server tests rather than DOM-level Web UI tests. A lightweight browser test suite would be useful for pairing, reconnect, and message replay flows.
