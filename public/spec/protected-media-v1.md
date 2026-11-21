# FindMeStill protected media pilot v1

The pilot lets two independently running clients exchange encrypted text, voice notes, and video using a relay. A recipient can return later, open a message in the app, and choose to play the media or share it with a separately paired listening agent. The deployment uses an explicit admission key and a dedicated player site. Public Discovery v0.1 and its signed address updates are independent profiles.

## Reading and playing

A mailbox listing exposes opaque message IDs and storage times. The client fetches and decrypts a message when the recipient chooses **Open message**. It renders text as text nodes. HTML, SVG, scripts, executables and archives have no media type in this profile. Received files have no automatic preview or open-in-system behavior. The supported formats are standard PCM16 WAV, MP4, and WebM, with an 8 MiB content limit. A filename and MIME declaration alone cannot qualify a file. The player screens the binary container marker or verifies the complete supported WAV header before handing accepted bytes to the browser decoder.

After **Open protected player**, the app transfers one bounded buffer to a dedicated, cookie-free player site via a fresh MessagePort. The iframe uses sandbox permissions for its trusted player script and an opaque origin. App CSP pins the exact separate-site frame origin. Player response CSP permits embedded playback only under its exact configured app origin. The player validates both the parent window and the exact parent origin before accepting the transferred port. The app waits for the ready acknowledgement before transferring media. No key, grant, filename, session credential or message history crosses the port. A fresh player runs for each opened clip. The frame's CSP restricts media to its local Blob URLs and blocks network connections. Playback requires a click. Closing the message or changing conversation removes the frame and releases the media. Decrypted media stays out of the service worker and HTTP caches.

The sandbox limits the impact of decoder bugs. Browser decoder and process isolation vary by platform, and a media sandbox cannot eliminate every decoder vulnerability. Use a current browser. The player site is a dedicated, separately registered site in production. A sibling subdomain, an iframe path on the app site, a redirecting player URL, or a host serving untrusted content is outside the deployment contract. The loopback tests use distinct hostnames.

## Agent access

Create a separate pair for the listening agent. Keep that pairing code private and provision it to the agent through standard input. The client can select that agent for a specific person conversation. It can share one opened clip through an explicit action. Automatic forwarding is off by default and requires a separate saved setting for that conversation. The browser checks new media while the authorized conversation is open. The agent receives forwarded items in its own inbox. The person conversation key remains on the original endpoints. Turning off forwarding controls future sends, and earlier deliveries remain readable until the agent and its relay retention expire.

The Linux reference agent can list its inbox, listen to a selected message, return normalized WAV on explicit request, or run an opt-in watcher. It processes media in a network-disabled Bubblewrap container with a read-only runtime, an isolated temporary mount, bounded input and output and a deadline. FFmpeg decodes an audio track and emits bounded PCM. A temporary in-sandbox seek buffer supports MP4 metadata at the end of the clip. Input is capped before any buffering. The built-in offline English transcription uses the system PocketSphinx model on normalized PCM. Text and transcripts are inert output. They grant no access or action permissions. Operators can hand the normalized audio to an authorized agent through a private pipe. A deployment that forwards audio or transcript to a cloud AI needs separate authorization and disclosure of what leaves the device.

## Pair and wire

Use the invitation text `findmestill.media-pair.v1 <origin> <pair-id> <pair-secret>` with single spaces. The origin is a canonical HTTPS origin, with HTTP allowed on loopback for testing. The initiator has role 0 and its peer role 1. Generate the pair ID as 16 random bytes and the secret as 32 random bytes. Use unpadded, canonical base64url. Transfer the invitation over an already trusted channel. Possession authorizes this pilot pair, and both participants can derive both lanes. This profile offers no forward secrecy, independent verified person binding, or per-device cryptographic revocation. Start a new pair after a secret exposure.

For each lane `N` (0 or 1), perform HKDF-SHA-256 with the raw secret and pair ID as salt. The UTF-8 info is `findmestill.media-pair.v1/N/PURPOSE`. Use `mailbox` for a 16-byte mailbox, `read` and `write` for 32-byte relay tokens, and `encryption` for a 32-byte AES key. Send on the lane matching the sender's role and receive on the other lane.

Every binary envelope starts with `0x01`, a 16-byte random message ID, and a random 12-byte IV. The plaintext starts with a two-byte unsigned big-endian header length, then the canonical UTF-8 compact JSON array `[mime,name]`, then the content bytes. Header length is at most 768. Use a 16-byte AES-256-GCM tag and authenticate the raw mailbox ID concatenated with the 29-byte envelope prefix as additional data. Text uses `text/plain`, an empty name, and at most 16,384 UTF-8 bytes. Attachments have a bounded display name and use `audio/wav`, `video/mp4`, or `video/webm`. The recipient rejects tag, ID, lane or media mismatches.

The [synthetic interoperability vector](/fixtures/media-pair-v1.json) uses public test-only secrets. An independent Python implementation generated it.

## Relay and receipts

The pilot relay lives under `/v1/media-relay/<mailbox>`. A relay operator issues a separate 32-byte admission key for setup. `PUT` to the mailbox takes the admission bearer and JSON `[reader,writer]`. It creates the mailbox or accepts byte-equivalent credentials. The recipient uses the read bearer to list `GET /messages` or fetch `GET /messages/<id>`. The sender uses its write bearer to `PUT /messages/<id>` with `application/octet-stream`. The receipt has the message ID, SHA-256 of the exact encrypted wire in base64url, and millisecond `storedAt` and `expiresAt` timestamps. The list returns `{messages:[receipt,...]}` where each receipt uses fields `id`, `digest`, `storedAt`, and `expiresAt`. A retry must reuse exactly the same encrypted envelope. An exact replay before expiry returns the original receipt. A different ciphertext for the same live ID is a conflict. A receipt records relay retention, not a read or playback acknowledgement.

The receiver can leave while the relay retains ciphertext. The reference relay uses a bounded SQLite store, a default 24-hour receipt window, and explicit application-origin CORS. It receives ciphertext, mailbox timing, byte sizes and access tokens. The encryption secret is kept at the paired endpoints. The browser stores pairing secrets in origin-private IndexedDB and queues only encrypted outgoing message bodies. Browser-profile compromise or clearing site data affects those local keys. The admission-gated relay is a single-instance pilot. A production deployment needs shared storage and proper operational provisioning.

### Same-origin gateway and resumable reads

The app may relay the existing paths through its own origin. It only forwards
to one operator-configured origin, which must match the relay origin in the
pairing code. Never derive an upstream destination from a request or invite.
Forward the scoped bearer, media request headers and encrypted envelope. Never
forward application cookies, an `Origin` header, or redirects. Both browser
endpoints can use their own app origin with the same relay and pairing code.
The dedicated player still receives the selected bytes over its MessagePort.

An authenticated message GET may return `Accept-Ranges: bytes` and a strong
`ETag` equal to the receipt digest enclosed in quotes. A client can send a
single `Range: bytes=<start>-<end>` plus `If-Match` with that ETag. An accepting
relay returns `206` with the same ETag and `Content-Range: bytes <start>-<end>/<total>`.
Bounds are inclusive and refer to the exact encrypted envelope. A mismatched
ETag returns `412`. An unsupported or unsatisfiable range returns `416` with
`Content-Range: bytes */<total>`. A legacy full `200` remains usable after
validating the full receipt digest. See [HTTP Range Requests](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests).

The reference client requests 256 KiB at a time and keeps only complete
ciphertext ranges as checkpoints. It binds them to the relay, local pair role,
message ID and receipt digest, and retains them until completion or expiry.
Local checkpoints are capped at 64 MiB per app origin. A resumed client must
check every returned offset and total and verify the assembled SHA-256 and
authenticated encryption before revealing metadata or sending bytes to the
player. Partial payloads never reach a decoder or an agent.

[Web Crypto](https://www.w3.org/TR/webcrypto-2/) · [HKDF, RFC 5869](https://www.rfc-editor.org/rfc/rfc5869) · [HTML sandbox](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox)
