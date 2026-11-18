# Project lessons (Clawness memory)
<!-- Clawness retrieves from this file each prompt: `## Always` entries are
     injected every turn (keep to 3), `## Lessons` entries only when they match
     the prompt. Tell Claude "remember this: ..." or append a bullet yourself
     (one line, <=120 chars, newest at the bottom). Only lessons that would cost
     real rework if forgotten belong here — not a session log. See ENF-MEM-001. -->

## Always

## Lessons
- DO storage can't persist CryptoKey (DataCloneError on workerd); in-memory test storage hides it — see handshake/host.ts
- Unit-green ≠ runs: smoke new DO/queue/crypto paths under `wrangler dev --local` before calling them done
- certify() corpora (packages/verify/src/corpus/*) hard-code expected canonical; non-fixture samples fail 422
