# Transfer telemetry

Dashboard: https://us.posthog.com/project/532781/dashboard/2109244

Version 1 covers all stored item categories: `file` (including images, audio,
video and documents), `text`, `code`, and `link`. `unknown` is used until an
incoming manifest can be decrypted. The schema is shared by web, Android, iOS,
and the agent. Classification reads content locally; only the category leaves
the client.

| Platform | Stored sends | Stored reads | Direct / fallback |
| --- | --- | --- | --- |
| Web | Files and encrypted text/code/link manifests | File downloads, previews, exports; initial manifest opening | Both |
| Android | Upload worker files; immediate and queued notes/code/links | File downloads, previews, exports; initial manifest opening | Not implemented by the app |
| iOS | Legacy and storage-v2 files; text/code/link pipeline | File downloads, previews, exports; initial manifest opening | Not implemented by the app |
| Agent | File and note/code/link tools | Explicit item retrieval, including text/code/links | Both |

The iOS Share Extension uses the same analytics adapter and shared consent
preference as the main app. Setup and capture run in the background; dismissal
never triggers or waits for a flush.
Analytics consent remains required.
Mobile and agent instrumentation reaches users only with an updated release.
iOS changes require validation on macOS/Xcode; this Windows workspace cannot
run the native build. Android has a tested debug APK, not a store release.

Public secret-bearing routes and anonymous sessions retain the existing
analytics exclusion. No session replay, autocapture, or resource URL collection
is enabled.

## Events

- `transfer.started`: emitted when an attempt begins, before upload thumbnail
  preparation or download authorization. Upload queue waiting time is excluded.
- `transfer.stage_started`: first entry into each stage, at most once per stage.
- `transfer.slow`: once if the attempt is still pending after 30 seconds.
  This is elapsed time, not a stall detector; large transfers can be healthy.
- `transfer.phase_timing`: one aggregate per visited stage at completion.
- `transfer.finished`: one success, failure, or cancellation with elapsed time,
  progress, last observed stage, and a closed error category.

Each attempt gets a newly generated random UUID `transfer_id`. It is not the
upload job, object, channel, share, or content ID; retries create new attempts.
The UUID is used for matching events, not high-cardinality chart breakdowns.
Existing `upload.phase_timing` events remain for compatibility.

Properties also include direction, purpose (`send`, `download`, `preview`,
`export`), `item_kind`, `transport` (`storage`, `manifest`, `direct`, `fallback`),
size and bucket, platform and telemetry version. Scope and online/foreground
state are included when known; absent values must not be treated as personal,
online, or foreground. Agent receipt replays have `cache_hit=true` and are
excluded from latency comparisons. SDK browser/device/session properties
remain subject to the existing sanitization. No names, content, secrets,
storage URLs, raw error messages, or network addresses are added.

## Interpreting timings

`transfer.finished.duration_ms` is elapsed time for the instrumented attempt.
Manifest reads measure local decryption/opening after a snapshot arrives, **not
network delivery or sender-to-recipient latency**. Unchanged snapshots are
suppressed using a bounded cache of encrypted prefixes; missing keys are not
counted as decryption attempts. File/manifest timings must remain separate.
Direct includes waiting for the peer; its slow signal is not necessarily a
network stall. iOS and agent send timing begins at the pipeline/tool boundary;
web and Android can also include earlier preparation.
An upload finishes when committed, without waiting for the channel feed refresh.
A download finishes when bytes are decrypted and assembled as a Blob, before
the browser saves it to disk. Cached previews may avoid a transfer entirely.

Upload stages describe the sequential UI pipeline. In a streaming upload,
later encryption and API work may occur within the uploading stage; it is not
a measurement of isolated encryption CPU time or raw network bandwidth.

Download stages split authorization (including token retrieval), storage fetch
and body read, decryption, and assembly. Multiple chunks overlap. Their
`timing_mode=cumulative_work` durations can exceed elapsed time and must not be
summed to estimate user wait. Failed attempts include only settled stage work.
Upload, manifest, Direct, and serial iOS/agent stage timings use `timing_mode=wall`.

Events are bounded by stages, not chunks or progress callbacks. They use the
existing batched PostHog transport on web/mobile. The agent holds no PostHog
key and sends bounded batches (maximum 32 events) to the authenticated Zas
relay, which attributes the events to the owner and sanitizes every event
before the existing durable analytics outbox. Its bounded queue dispatches on a later event-loop turn, never inline or on
completion; overflow is dropped. It never blocks the item result. No heartbeat stream is introduced. The
30-second signal is best effort and may be delayed in a background tab.

## Investigation

The dashboard shows outcomes and p50/p95 by size, stage costs, browser failures,
hour-of-day latency in Argentina, lifecycle volume, and starts older than ten
minutes with no matching finish. Unresolved attempts are **not confirmed
failures**: they may still be running, or the browser/connection may have ended.
Missing telemetry cannot be reconstructed, and SDK blocking can hide both ends.

For a report, filter by time, platform, item_kind, transport, direction, size, purpose, and account in PostHog.
Inspect the event stream for a single `transfer_id`. Compare stage costs and
sample counts before attributing latency to storage, encryption, or the API.
Native PostHog funnels can also hold `transfer_id` constant across steps;
ordinary user-level funnels alone can accidentally match different files.
See https://posthog.com/docs/product-analytics/funnels.

Saved SQL definitions are in `transfer-telemetry-insights.json`. Their windows
are explicitly seven days; dashboard date filters do not override that SQL.
The new events have no historical backfill. No email/Slack notifications or
arbitrary alert thresholds were enabled before a baseline exists.

Custom-property capture follows the existing SDK path:
https://posthog.com/docs/libraries/js/usage#setting-event-properties.
No analytics SDK settings were relaxed to collect this instrumentation.

## Fire-and-forget guarantee

Item operations never await telemetry. Web queues SDK work in later tasks
(maximum 256 pending snapshots, eight per task). Android uses a low-priority
single-thread executor with 256 slots and discard-on-overflow, never caller-runs.
iOS queues SDK setup, consent reads in the Share Extension, and capture on a
bounded utility queue; no item-completion flush is required. The agent defers
settings reads and delivery, caps each pending batch at 32, allows one telemetry
request in flight, drops failures, and aborts delivery after two seconds. It
uses cached auth only, never starts or invalidates a shared sign-in/refresh.

Small clock reads, counters, and snapshot/enqueue bookkeeping remain on the
caller. This is not a claim of literally zero CPU overhead. Slow, offline or
failed analytics does not become a dependency of item completion. Backpressure
and process exit can lose optional events; correctness and responsiveness take
priority over analytics delivery.
