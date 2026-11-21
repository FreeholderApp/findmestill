# Local transport pilot results

Measured on 21 November 2026. Each experiment used synthetic identities and a private loopback network namespace. Public FindMeStill discovery continues to use its own signed contact records.

| Case | SimpleX | Nostr with Marmot |
| --- | --- | --- |
| Offline text | CLI 7.1.4.0 and SMP 6.5.0.17. The recipient process was stopped for three seconds, then restarted from its existing database and decrypted the message. The sender later restarted and decrypted the reply. | Marmot TypeScript 0.9.0 and a local Nostr wire fixture. The relay retained signed ciphertext. The recipient disconnected and reopened saved MLS state from disk after three seconds. It decrypted the message and returned a reply in the group. |
| Offline attachment | SMP carried the notification. XFTP 6.5.0.17 held 327,680 ciphertext bytes for the 262,144-byte sample. The restarted CLI recovered the original digest. | MLS encrypted-media v2 carried the reference. The local HTTPS fixture held 262,160 ciphertext bytes for the same sample. A reopened authorized endpoint retrieved and decrypted the original file. |
| Remove a collaborator | The third CLI identity received a group message before removal. It observed removal. The remaining customer received the next message and the former member received no copy during the observation window. | A distinct MLS member decrypted a pre-removal message. The admin removed that member. The remaining customer decrypted the next message. The former member could not decrypt it from the same relay. |
| Return to the address | The FindMeStill discovery suite separately verifies the saved contact, an unavailable primary, a previously shared backup, and the signed successor. | The same discovery suite applies. The contact address and the MLS group identity require an authenticated application binding. |

The common 256 KiB sample is SHAKE-256 of the UTF-8 bytes `FindMeStill transport pilot v1`, with a 262,144-byte output. Its SHA-256 is `a29a0f18ebb9cd38f6d205460c3ca702559400904c31884d785a9dc57f435555` for both decrypted copies. The table reports stored object sizes. The pilot did not record complete wire overhead. The private loopback timings do not estimate public service latency.

## Optional IPFS retrieval

The same 262,160-byte Marmot ciphertext was added as a CIDv1 to Kubo 0.43.1. A second independent Kubo data directory fetched and pinned it. After the original provider stopped, an empty third data directory connected to the second provider and fetched the exact bytes through its gateway. In this loopback run, the first response byte arrived in 24 ms. The authorized recipient decrypted the IPFS copy and recovered the sample SHA-256 above. All three Kubo nodes ran in an isolated network without public pinning.

To reproduce the provider transition, run three isolated Kubo repositories with distinct swarm, API and gateway ports. Add only the ciphertext to the first with `ipfs add --cid-version=1`. Connect the second to the first with `ipfs swarm connect` and pin the CID with `ipfs pin add`. Stop the first. Connect an empty third repository to the second and fetch the CID. Compare the bytes with the input ciphertext and decrypt using the authorized receiving group state. Run the HTTPS case with the same ciphertext and compare latency under equivalent conditions.

The HTTPS experiment used the Marmot TypeScript encrypted-media-v2 group policy, with an injected local TLS blob host. The IPFS experiment exercised retrieval of that ciphertext. An interoperable locator, client consent and a retention statement for optional IPFS delivery still need implementation.

## NIP-17 direct-message check

A separate local test used nostr-tools 2.26.1 and the NIP-17 direct-message format. Both synthetic peers carried a typed FindMeStill address update in a gift-wrapped message. The authorized recipient applied it once after two distinct wraps of the same message ID, and rejected the same signed card chain when the authenticated Nostr sender was a different actor. The test used the shared draft application fixtures. Independent NIP-17 app compatibility remains open.

## Qualification remaining

Test the same-account second device and native phones, the browser return journey for a private reply, a delivery receipt with a defined retention deadline and retry behavior, and live PWA–Freeholder messaging after a signed address move. Calling, scheduling and production IPFS gateways have separate acceptance. A delivery profile has yet to be selected.

[SimpleX Chat 7.1.4](https://github.com/simplex-chat/simplex-chat/releases/tag/v7.1.4) · [SimpleX SMP/XFTP 6.5.0](https://github.com/simplex-chat/simplexmq/releases/tag/v6.5.0) · [Marmot TypeScript](https://github.com/marmot-protocol/marmot-ts) · [Kubo 0.43.1](https://github.com/ipfs/kubo/releases/tag/v0.43.1) · [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md)
