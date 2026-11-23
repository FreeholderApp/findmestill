# SPDX-License-Identifier: Apache-2.0
"""Independent issuer implementing discovery v0.1 with Python cryptography."""
import base64
import hashlib
import json
import sys

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def encode(raw):
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def compact(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("ascii")


def digest(raw):
    return encode(hashlib.sha256(raw).digest())


# Public RFC 8032 §7.1 test 1 and test 2 seeds.
root = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
))
foreign = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(
    "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"
))
VERSION = "findmestill-card-v0.1"
HEADER = encode(compact({"alg": "Ed25519", "typ": VERSION}))
PRIMARY = "https://studio.example/contact/bookings.json"
BACKUP = "https://directory.example/cards/studio.json"
MOVED = "https://studio-moved.example/contact/bookings.json"
NOW = 1800000000


def issue(key, revision, prior, issued, expiry, primary, backups, contact=None, signer=None):
    pub = encode(key.public_key().public_bytes_raw())
    identifier = "fms1-" + digest(compact({"crv": "Ed25519", "kty": "OKP", "x": pub}))
    payload = [VERSION, contact or identifier, pub, revision,
               digest(prior.encode("ascii")) if prior else None, issued, expiry, primary, backups]
    data = f"{HEADER}.{encode(compact(payload))}"
    return identifier, f"{data}.{encode((signer or key).sign(data.encode('ascii')))}"


if __name__ == "__main__":
    contact_id, genesis = issue(root, 1, None, NOW - 60, NOW + 60, PRIMARY, [BACKUP])
    _, moved = issue(root, 2, genesis, NOW + 60, NOW + 600, MOVED, [BACKUP])
    _, forked = issue(root, 2, genesis, NOW + 60, NOW + 600, "https://fork.example/desk", [BACKUP])
    _, skipped = issue(root, 3, genesis, NOW + 60, NOW + 600, MOVED, [BACKUP])
    _, forged = issue(root, 2, genesis, NOW + 60, NOW + 600, MOVED, [BACKUP], signer=foreign)
    _, wrong_key = issue(foreign, 2, genesis, NOW + 60, NOW + 600, MOVED, [BACKUP], contact=contact_id)
    _, future = issue(root, 2, genesis, NOW + 400, NOW + 600, MOVED, [BACKUP])
    _, expired = issue(root, 2, genesis, NOW, NOW + 10, MOVED, [BACKUP])
    vectors = dict(contactId=contact_id, initialTime=NOW, movedTime=NOW + 61,
                   primary=PRIMARY, backup=BACKUP, movedPrimary=MOVED, initial=[genesis],
                   moved=[genesis, moved], conflict=[genesis, forked], skipped=[genesis, skipped],
                   forged=[genesis, forged], wrongKey=[genesis, wrong_key],
                   future=[genesis, future], expired=[genesis, expired])
    if sys.argv[1:] == ["--predecessor"]:
        _, third = issue(root, 3, moved, NOW + 61, NOW + 1200, MOVED, [BACKUP])
        vectors = dict(contactId=contact_id, now=NOW + 61, pin=third,
                       current=[genesis, moved, third], predecessor=[genesis, moved],
                       conflicting=[genesis, forked], expiredConflict=[genesis, expired])
    json.dump(vectors, sys.stdout, indent=2)
    print()
