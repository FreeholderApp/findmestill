# FindMeStill

FindMeStill is an open protocol for portable contact addresses. Discovery v0.1 lets an independent client verify a signed contact card, save the identity, and resolve a signed move through a previously known backup.

- [Discovery draft](public/spec/discovery-v0.1.md)
- [Signed conformance vectors](public/fixtures/discovery-v0.1.json)
- [Compatibility evidence](public/interop.json)

## Run the reference site

Use Node.js 24, Python 3 and OpenSSL 3. The reference server and client have no npm dependencies.

```sh
npm ci
npm test
npm run build
npm start
```

Open <http://127.0.0.1:8080> and select **Try a sample move**. To test saving and refreshing with real contact data, paste a canonical HTTPS card URL whose fragment is its FindMeStill ID. Use conforming card hosts with public browser CORS headers. The browser contact verifier stores public signed records locally for use after a reload. To open a contact in the app, put its URL-encoded share link in the app URL fragment as `/#contact=ENCODED_LINK`. The app fills the field for review without making a network request. Browsers with native QR detection can also read an image or camera snapshot. The text field remains available for pasted and keyboard-entered links.

After verifying a contact, select **Share contact link** to copy its current locator and stable ID. When the old hosts are unavailable, paste a fresh introduction for the same ID and choose **Verify and save**. The client checks continuity against your saved signature and reports whether a host confirmed the selected revision.

Use the browser’s install or add-to-home-screen action where available. Open the app online once to cache its public shell. You can then reopen it offline and view saved public contact records with their expiry. The app checks the recorded addresses when the browser reconnects. Saved records are local to this browser profile and origin. Clearing site data removes them. The app does not import or store private keys, and the service worker only caches the listed static public files.

A clean commit build includes a source archive and puts its exact revision in `dist/release.json`. In a release build, set `FINDMESTILL_REVISION` to the expected commit. The server serves the built site from the loopback interface, for development or deployment behind a TLS frontend. It also serves locally published card documents beneath `/cards/` or `/contact/`. Use ordinary HTTPS static hosting for either primary or backup.

## Issue, publish and resolve a card

Generate and retain the authority key offline. Publish only the signed JSON produced by `issue`. The example addresses are placeholders for DNS names you control.

```sh
node client.mjs keygen root.pem
node client.mjs issue root.pem https://studio.example/cards/desk.json 2592000 - \
  https://backup.example/cards/desk.json > initial.json
node client.mjs issue root.pem https://moved.example/cards/desk.json 2592000 initial.json \
  https://backup.example/cards/desk.json > moved.json
```

Keep the original card document. For a move, publish `moved.json` to the previously shared backup and new primary. The CLI prints the shareable link on stderr when issuing a card. Use output files distinct from the input file.

```sh
node client.mjs resolve 'https://studio.example/cards/desk.json#fms1-CONTACT_ID' > saved.json
node client.mjs refresh saved.json > refreshed.json
```

The interoperability test uses the Python issuer's published fixtures, an independent Python HTTPS host and a Node reference HTTPS host. To regenerate the public fixture, install `cryptography` in an isolated Python environment and run `python3 test/issue_vectors.py`. Never use the public conformance keys for real identities.

## Status

This is the discovery slice. Private delivery, storage receipts, reply retrieval, operational credentials, calls and scheduling are under development. The SimpleX and Nostr/Marmot pilot will compare the delivery profiles before one is selected. Freeholder integration proceeds on its own release track.

[Apache License 2.0](LICENSE).

### Keep contacts after losing a domain or device

Each person saves the other's signed contact. Publish each card at a primary and
at least one previously shared backup hosted independently. After a move, put
the new signed history on the backup and the new primary. The recipient can
then check for a move even after the old domain expires. If every known host
is gone, exchange a fresh locator through a surviving channel and check it
against the saved ID. At least one source of the new signed history must survive.

Use **Back up or restore contacts** on each device before losing access to the
app origin. Download the encrypted file and store its separately displayed
random recovery code somewhere you can access later. Restore both in the
trusted app on another origin or device, including offline once the public
shell is installed. Existing local pins take precedence on restore. The book
contains only saved public signed contact records. Keep issuer keys and any
private messaging recovery material separately. The offline issuer root is
needed to sign a move. A copied contact book cannot sign one.

[Contact book format and security review](public/spec/contact-book-v1.md)

[Publish a searchable contact page](public/spec/searchable-page.md)

To repeat the two-person recovery exercise, build the site and run
`node checks/discovery-recovery-browser.mjs` with local Playwright and its
Chrome channel. `FMS_PLAYWRIGHT_MODULE` can point to an existing Playwright
installation. The check uses disposable profiles and synthetic .test contacts.
