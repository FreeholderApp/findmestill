# SPDX-License-Identifier: Apache-2.0
"""Generate a deterministic contact-book interoperability vector. All bytes are public test data."""
import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

fixtures = Path(__file__).resolve().parents[1] / "public" / "fixtures"
cards = json.loads((fixtures / "discovery-predecessor-v0.1.json").read_text())
key = bytes(range(32))
nonce = bytes(range(12))
prefix = b"findmestill.contact-book.v1\n"
entries = [[cards["contactId"], cards["pin"]]]
payload = json.dumps(entries, separators=(",", ":")).encode()
file = prefix + nonce + AESGCM(key).encrypt(nonce, payload, prefix)
vector = {
    "purpose": "Public synthetic interoperability fixture only",
    "code": "fmsbook1-" + base64.urlsafe_b64encode(key).rstrip(b"=").decode(),
    "base64": base64.b64encode(file).decode(),
}
print(json.dumps(vector, indent=2))
