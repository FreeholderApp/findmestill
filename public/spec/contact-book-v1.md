# Contact book recovery

Each export uses a fresh Web Crypto random 256-bit key and 96-bit nonce.
The recovery code is the literal prefix `fmsbook1-` followed by canonical
unpadded base64url of the 32 key bytes. Save the code separately from the file.
Possession of both reveals the contact list. Each backup is a snapshot.

The file starts with ASCII `findmestill.contact-book.v1` and one LF, followed
by the raw 12-byte nonce, AES-256-GCM ciphertext, and 16-byte authentication
tag. Authenticate the whole ASCII prefix including LF as additional data.
The UTF-8 plaintext is a JSON array of pairs of the exact stable ID and its
saved compact JWS. Limit a file to 8 MiB and 1–2,048 unique contacts.
Authenticate the file and verify every card signature and ID before importing
any entries. Expired pins can anchor a subsequent signed move. Restore adds
missing contacts under their IDs. It preserves existing local pins and reports
when an imported version differs. A repeated restore can finish an interrupted
import. Neither export nor restore requires a network request.

[Public Python-issued interoperability vector](../fixtures/contact-book-v1.json)

## Security and continuity

| Event | Expected result |
| --- | --- |
| The old primary disappears | A previously trusted backup can serve a continuous signed successor. |
| All saved hosts disappear | A new introduction from the contact can supply the chain. Without any surviving channel the receiver has no way to learn a new address. |
| A browser profile or app domain disappears | A previously exported file and its recovery code restore the list at another trusted app origin. |
| A replica returns an older head | Retain the live local pin. State whether a host corroborated it. |
| A signed predecessor conflicts with the saved pin | Report the conflict and preserve the pin even when the shorter chain is expired. |
| Someone obtains a backup file | A uniformly random secret is required for offline decryption. File size and possession remain observable. |
| Someone obtains an issuer root, or controls the app processing a recovery code | They can sign records as that issuer, or read the restored list, respectively. Protect offline root custody and the integrity of the app distribution. |

Ed25519 targets about 128 bits of classical security. A sufficiently capable
fault-tolerant quantum computer would undermine its signatures and therefore
signed move authorization. The AES-256 backup format does not change this
dependency. Discovery v0.1 accepts one signature algorithm. A post-quantum
successor needs a versioned identity and record format, an authenticated
migration before the old key is vulnerable, independent implementations and
downgrade tests. ML-DSA is a standardized signature family to evaluate.
[RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html#section-8.5) ·
[NIST FIPS 204](https://csrc.nist.gov/pubs/fips/204/final)

The separate private media pilot uses a shared random pairing secret.
A copied secret gives its holder pair access. The pilot has no forward
secrecy. Local Freeholder session revocation and player sandboxing protect
their respective boundaries. The discovery launch contains no private relay.
