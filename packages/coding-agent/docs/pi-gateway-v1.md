# Pi Gateway Contract v1

Status: implementable contract and reference primitives. No production HTTP/SSE gateway in this repository currently implements it.

The normative API description is [`pi-gateway-v1.openapi.yaml`](./pi-gateway-v1.openapi.yaml). The fixtures in `test/fixtures/gateway-v1/` and `test/gateway-contract.test.ts` are executable examples. A gateway MUST fail closed when a required capability is missing. It MUST NOT route a Pi Session request to stateless chat completions.

## Audited baseline

The 2026-10-13 audit found three distinct surfaces:

- `pi-mobile` locks `@mariozechner/pi-coding-agent` at `0.53.0`. It has unversioned `/api` repository, model, Session, command, takeover, release, state, and SSE routes. Its SSE records have no IDs or replay cursor; prompt commands are text-only; abort does not enforce controller ownership; its optional static token can be supplied in a URL. Its WebAuthn challenge endpoints persist credentials, but successful verification does not issue or bind an API authorization session, so it is not server-side API authentication.
- this repository is package version `1.1.0`, with Pi binary protocol version `8`. Its experimental services provide durable Sessions, model/thinking configuration, transcript snapshots, prompt/steer/follow-up/abort/compaction, inline image input, and multiple presentation attachments. The transport has no peer authentication, public HTTP/SSE adapter, controller lease, or durable event replay journal.
- `jonwork-server` publishes contract `1.2.0`. It provides iOS PKCE/device authentication, model discovery, and OpenAI-compatible chat SSE, but no Pi Session lifecycle, authoritative transcript, control ownership, tool events, replay, or takeover/release.

Combining those components is production work, not a compatibility assumption. Until it exists and passes this contract, production Pi Gateway availability is blocked.

## Version and capability discovery

`GET /.well-known/pi-gateway` is the only unauthenticated resource. It returns the contract ID, semantic API version, authentication metadata, limits, and capability flags. Clients reject an unsupported major version before obtaining a token.

The required production capability set is:

`repositories`, `models`, `thinking`, `sessions`, `commands`, `sse`, `authoritativeSnapshot`, `eventIds`, `replay`, `idempotency`, `singleWriter`, `takeover`, `release`, `abort`, `retry`, and `attachments`.

Each capability is explicit. An absent or false required capability produces `capability_unavailable`; no alternate chat API is selected. Optional attachment kinds are advertised separately.

## Authentication and authorization

All `/v1` resources require an OAuth 2 bearer access token. Native clients use authorization code with PKCE S256. Discovery publishes exact authorization and token endpoints. Tokens never appear in a URL, event payload, log, attachment metadata, or error detail. The gateway binds every repository and Session to the authenticated principal and checks authorization before resolving filesystem paths.

Access tokens are short-lived. Revocation must terminate active streams and in-flight mutations before acknowledging the revoke operation. TLS is required except for explicit loopback development profiles. Query-string bearer tokens are forbidden.

## Sessions and single-writer control

A Session is durable and identified by `sessionId`; clients never submit a server filesystem path. `POST /v1/sessions` creates a new Session. `POST /v1/sessions/{sessionId}/restore` starts or attaches the durable Session. `PATCH /v1/sessions/{sessionId}` renames it. List results distinguish durable existence from a running worker.

Every authoritative snapshot contains `revision`, `lastEventId`, transcript, model/thinking configuration, run state, controller lease, and attachment references. A snapshot replaces all client-local Session state.

At most one `clientId` is controller. Viewers may list, fetch snapshots, and consume events, but every mutation, including abort and retry, returns `not_controller`. Takeover is an explicit mutation and may return `session_busy` while a run is active. Release revokes the controller lease, aborts active work if required by policy, flushes durable state, retires the attachment, and emits `controller.changed` followed by `session.released`. It does not delete the Session.

Every mutation carries:

- `Idempotency-Key`: 8–128 opaque characters, scoped to authenticated principal and Session;
- `If-Match: \"<revision>\"`: the authoritative revision observed by the client;
- `clientId`: the presentation attempting the mutation.

The gateway serializes admitted mutations. Reusing a key with the same canonical request returns the original status/body and sets `Idempotency-Replayed: true`. Reusing it with a different request returns `idempotency_conflict`. Two different keys racing with the same revision yield one success and one `revision_conflict`. Failed commands are not recorded as successful idempotent results.

Successful idempotency records are retained for at least the discovery document's `idempotencyRetentionSeconds`, which is never less than 24 hours. They are scoped to the authenticated principal, Session, and `clientId` and must survive process restart for that window.

## Commands

`POST /v1/sessions/{sessionId}/commands` accepts a discriminated command:

- `prompt`, `steer`, and `follow_up` contain text plus zero or more uploaded attachment IDs;
- `set_model` and `set_thinking_level` change configuration;
- `abort` stops active and queued work without deleting durable history;
- `retry` names the settled `operationId` being retried and creates a new operation ID;
- `compact` requests durable context compaction.

Successful command admission returns `202` with an `operationId`, new Session revision, and the event cursor at or after which its lifecycle is observed. Admission is not completion. Unknown completion after a client timeout is resolved by repeating the same idempotency key, never by creating a new prompt automatically.

## Event stream, ordering, and recovery

`GET /v1/sessions/{sessionId}/events` is SSE. Each record has both an SSE `id:` line and the same decimal `id` in JSON. IDs increase monotonically within one Session and are never reused. `Last-Event-ID` is preferred; `after` is available for clients whose SSE API cannot set that header. Supplying both with different values is invalid.

Every JSON envelope contains `contract: "pi-gateway/1.0"`, decimal `id`, `sessionId`, `sessionRevision`, `occurredAt`, discriminating `type`, and the exact corresponding `data` variant. Unknown contract majors, event types, or fields fail closed.

Stable entity identities and ordering are:

| Event | Stable IDs | Ordering and terminal rule |
|---|---|---|
| `operation.accepted` | `operationId`, optional `retryOfOperationId` | First event for an operation. A retry source must already be settled. |
| `user.message` | `operationId`, `messageId`, attachment IDs | Once per durable user message, after admission and before its turn. |
| `turn.started` | `operationId`, `turnId` | Opens one turn for an active operation. |
| `assistant.message.started` | `operationId`, `turnId`, `messageId` | Opens the assistant entity before deltas or tools. |
| `assistant.text.delta` | operation, turn, and message IDs | Only while that assistant message is active. |
| `assistant.reasoning.delta` | operation, turn, and message IDs | Separate ordered reasoning channel; never folded into text. |
| `tool.started` | operation, turn, message, `toolCallId`, nullable `parentCallId` | `toolCallId` is globally stable in the Session. A non-null parent must be active. |
| `tool.updated` | same tool identity plus `updateSequence` | Updates start at 1 and are contiguous for that tool. |
| `tool.completed` | same tool identity | Exactly once, `success` XOR `failure`; a parent cannot complete before active children. |
| `assistant.message.completed` | operation, turn, and message IDs | Exactly once after every tool owned by the message is terminal. |
| `turn.completed` | `operationId`, `turnId` | Exactly once after active messages are terminal. |
| `abort.requested` | `operationId`, requesting `clientId` | At most once while the operation is active. |
| `operation.settled` | `operationId`, optional `retryOfOperationId` | Exactly once after turns settle; terminal status is completed, aborted, or failed. |
| `gateway.error` | optional `operationId`, structured error | Reports a safe operational error; it does not itself settle an operation. |
| `controller.changed` | previous/current `clientId` | Emitted for takeover, release, disconnect, or lease expiry. |
| `session.released` | releasing `clientId` | Follows `controller.changed` to null for an explicit release. |

Within one connection, bytes, SSE records, and event IDs are ordered. The minimum generation lifecycle is:

1. `operation.accepted`
2. `user.message` when the operation submitted new user input
3. `turn.started`
4. `assistant.message.started`
5. zero or more assistant deltas and tool lifecycles
6. `assistant.message.completed`
7. `turn.completed`
8. `operation.settled`

A tool lifecycle is `tool.started`, zero or more `tool.updated`, then exactly one `tool.completed`. Deltas for a message occur after its start and before its completion. Abort produces `abort.requested`, terminal message/tool events where applicable, then `operation.settled` with `aborted`. Retry is a new operation whose accepted and settled events both carry the same `retryOfOperationId`; it never rewrites old events.

Clients may discard an exact transport duplicate before reduction, but the strict reducer rejects a duplicate ID as `duplicate_event`, a decreasing ID as `out_of_order_event`, and a skipped ID as `event_gap`; all three trigger snapshot recovery. A valid next ID with an illegal entity lifecycle is `invalid_event_lifecycle`. The gateway must reject those same conditions before publication. Stable entity IDs make a pre-reducer deduplication layer deterministic, but do not permit applying one semantic terminal twice.

Reconnect algorithm:

1. fetch `GET /v1/sessions/{sessionId}` and atomically replace local state;
2. open SSE with the snapshot's `lastEventId`;
3. apply only contiguous newer events;
4. on `replay_cursor_expired`, repeat from step 1.

The gateway retains at least the duration and count advertised by discovery. A cursor ahead of the journal is `invalid_replay_cursor`; an evicted cursor is `replay_cursor_expired`. A server restart cannot reset IDs for an existing Session. If durable cursor continuity cannot be guaranteed, the gateway must reject replay and force an authoritative snapshot rather than silently omitting events.

## Attachments

`POST /v1/attachments` uploads one binary body with `Content-Type`, `Content-Length`, `X-File-Name`, and an idempotency key. The default contract limits are four attachments per prompt, 10 MiB per attachment, 20 MiB total per prompt, a 30-second upload deadline, and a 255-byte UTF-8 filename. Discovery may lower, never silently raise, these limits for a client profile.

The gateway validates declared length, streamed byte count, media signature where applicable, authorized repository scope, and capability before persistence. Incomplete, oversized, timed-out, unsupported, or quarantined uploads are not attachable. Attachment IDs are opaque, principal-scoped, expire if unused, and are consumed by reference; prompt JSON never embeds unbounded base64. Image support and general file support have independent capability flags.

## Errors and timeouts

Errors use `{ error: { code, message, requestId, retryable, details? } }`. Stable codes are defined in the OpenAPI document and reference module. Messages are safe for users and contain no paths, credentials, prompts, tool output, or upstream response bodies.

Default deadlines are 10 seconds for reads, 30 seconds for mutation admission and uploads, and 15 seconds for initial SSE headers. Model execution has no generic HTTP response deadline after admission; its operation is observed through events and may be aborted. Rate-limited responses use `429` and `Retry-After`. Gateway shutdown rejects new writes, settles or aborts admitted work according to policy, flushes its journal, and then closes streams.

## Implementation boundary

`src/experimental/gateway-contract.ts` implements bounded event replay and serialized controller mutation/idempotency primitives. They are intentionally storage-neutral. A production adapter must persist equivalent event IDs, snapshots, controller state, revisions, and idempotency records transactionally with durable Session mutations. Passing unit tests for the in-memory primitives does not constitute production gateway evidence.
