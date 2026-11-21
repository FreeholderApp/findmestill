# FindMeStill discovery v0.1

Experimental profile. It defines contact discovery and signed relocation. A contact's identity survives a change of web host if the root signing key and at least one usable way to distribute the signed move survive.

## Identity and first contact

The identifier is `fms1-` followed by the SHA-256 [JWK thumbprint](https://www.rfc-editor.org/rfc/rfc7638.html) of an Ed25519 public key. Hash exactly the UTF-8 text `{"crv":"Ed25519","kty":"OKP","x":"KEY"}`, replacing `KEY` with the 32-byte raw Ed25519 public key in unpadded base64url. Encode the 32-byte hash in unpadded base64url. Identifiers are case sensitive. Every base64url value used here must round trip to the identical unpadded representation.

A recipient accepts an identifier and locator from a trusted introduction. An HTTPS URL with the contact ID as its entire fragment is a shareable representation suitable for a QR code. Strip the fragment before fetching. The signature proves control of the key behind that ID. A recipient checks the introduction independently when they need to trust a name or business affiliation. A URL alone is insufficient to pin a FindMeStill identity.

## Signed record

Use compact [JWS](https://www.rfc-editor.org/rfc/rfc7515.html) with the exact UTF-8 protected header `{"alg":"Ed25519","typ":"findmestill-card-v0.1"}`. Use pure Ed25519 as specified by [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html) and the algorithm identifier in [RFC 9864](https://www.rfc-editor.org/rfc/rfc9864.html#section-2.2). A record is three base64url segments separated by ASCII dots, with a 64-byte signature over the ASCII header segment, dot and payload segment. Its digest is unpadded base64url of SHA-256 over the **entire exact ASCII compact JWS**. A compact record may be at most 4,090 bytes.

The payload is a UTF-8 JSON array of nine values in order. Serialize without whitespace, escape sequences, exponent notation, or a BOM. Integers are ordinary base-ten digits. The allowed field values fit ASCII, so no JSON string escapes are needed.

| Index | Field | Requirements |
| --- | --- | --- |
| 0 | Profile | Literal `findmestill-card-v0.1` |
| 1 | Contact ID | The identifier defined above |
| 2 | Root key | Unpadded base64url of the 32-byte Ed25519 public key |
| 3 | Revision | Integer 1 to 9,007,199,254,740,991. Genesis is 1. Each successor increments by 1 |
| 4 | Previous digest | JSON null for genesis. Otherwise the exact preceding record's digest |
| 5 | Issued at | Positive integer UTC Unix seconds, at most 9,007,199,254,740,991. Nondecreasing across revisions and at most 300 seconds ahead of the verifier |
| 6 | Expires at | Same integer format. Strictly after issuance and no more than 366 days later |
| 7 | Primary locator | Canonical HTTPS URL serving the public card document |
| 8 | Backup locators | JSON array of zero to two distinct canonical HTTPS URLs, each different from the primary |

A locator has a lowercase DNS hostname with at least two labels and total length at most 253. Each label consists of ASCII lowercase letters, digits or interior hyphens, with a maximum of 63 characters. The last label starts with a letter. Exclude the `.localhost` suffix. Use an optional canonical decimal port from 1 to 65535, omitting 443. Include a slash and an optional case-sensitive path with only ASCII letters, digits, underscore, tilde, hyphen, period and slash. Reject consecutive path slashes and dot segments. Exclude a trailing hostname dot, credentials, IP literals, query strings and fragments. The entire locator is at most 768 ASCII characters. It must round trip unchanged through the WHATWG URL serializer.

Every revision is signed directly by the same root. Keep its private key outside the web hosts and reserve it for issuing records. Move or renew by publishing a successor signed by that root. If the root is lost or compromised, this profile requires a new identity and another trusted introduction. A valid signature authorized by a stolen root cannot by itself reveal the compromise.

## Document retrieval and selection

Serve each card at its advertised URLs by HTTPS GET, without redirects. Return HTTP 200 with `Content-Type: application/json` and a JSON array of compact JWS strings ordered from genesis through the newest published revision. Each document contains 1 to 64 records and at most 262,144 bytes. This bounded full-history format is for the first pilot. For browser interoperability serve these publicly intended bytes with `Access-Control-Allow-Origin: *`. Clients send no credentials or referrer.

1. On first contact, fetch the locator from the introduction. Check each entry's format, signature, expected contact ID, derived contact ID, issuance, revision number and digest link. Ignore documents that fail any check. If the first contact resolves, save the selected card's exact JWS under the ID.
2. On refresh, verify the saved pin and try its primary and all signed backups concurrently. Treat a network or content failure as an unavailable document. Follow no redirects. An offline client can also evaluate a document supplied directly.
3. Compare all individually valid chains with one another and with the saved pin. If any observed pair gives different digests for the same revision, report a conflict and keep the saved pin. This includes disagreements in expired history. An update newer than the pin consequently must contain that exact pin.
4. Choose the highest revision seen, counting the pin. An older valid record cannot roll back a saved one. The highest revision is usable only when its expiry is strictly greater than the current UTC Unix second. Expired predecessors can still prove continuity. An expired highest revision fails closed even if a lower revision is still live.
5. Replace the persisted pin atomically on success. A cache of trusted pins must treat an identity as its storage key even when the primary locator changes. A locator that serves the same older revision, or cannot be reached, proves nothing about whether a more recent revision exists.

The reference client fetches locators from the browser or a local operator CLI. Server integrations must not turn a submitted or signed locator into an unrestricted outbound request. A server-side adapter must enforce address restrictions on resolution and connection, reject redirects, and bound time and bytes.

A move should publish the full signed chain at a previously shared backup and the new primary. A backup holds public records. Clients only know that a move happened when one reaches them. Choose backups with failure modes independent of the primary. Stale responses, suppression and split views remain possible. A client detects a fork only when it observes both sides or one conflicts with a retained pin. A printed introduction without a surviving locator may require another way to obtain the signed chain.

## Compatibility material

The public vectors use the published [RFC 8032 test key](https://www.rfc-editor.org/rfc/rfc8032.html#section-7.1). The seed is public and suitable only for conformance. Use the fixture's supplied clock when evaluating the records. The independent issuer in this project implements the wire description in Python. The browser and Node reference verifier use the platform Web Crypto API.

The profile carries public routing metadata. Delivery, idempotent storage receipts, private reply recovery, rotating operational credentials, calls and scheduling depend on subsequent profiles. The comparative SimpleX and Nostr/Marmot pilot will inform those profiles.
