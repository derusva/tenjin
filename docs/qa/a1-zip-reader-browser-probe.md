# A1 ZIP Reader Browser Probe

Status: implementation ready; runtime evidence pending the committed-SHA offline run.

This probe is a QA-only build and is not a production PWA entry point. It must
be run once from a fresh browser profile after the page reaches `READY` and
after DevTools Network has been switched to Offline.

## Required procedure

1. Build with `TENJIN_COMMIT_SHA` set to the exact commit under test.
2. Start the dedicated Vite preview and open DevTools Network.
3. Enable Preserve log and Disable cache.
4. Confirm the page says `READY` and `probeCalls` has not run.
5. Switch Network to Offline, then click `Run offline probe` once.
6. Save the JSON result, Worker constructor URLs, Network log summary, browser
   version, and built-file inventory below.

## Evidence

- Commit: pending
- Browser / version: pending
- Command transcript: pending
- Built-file inventory: pending
- Worker URLs: pending
- Network log summary: pending
- Raw JSON result: pending
- Verdict: pending
