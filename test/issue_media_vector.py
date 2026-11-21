# Copyright (C) 2026 Tony Aly
# SPDX-License-Identifier: Apache-2.0
"""Emit a public synthetic Media Pair v1 vector using Python cryptography."""
import base64
import json
import struct
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

salt = bytes(range(16))
secret = bytes(range(32))
message_id = bytes(range(16, 32))
iv = bytes(range(32, 44))
profile = "findmestill.media-pair.v1"


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def derive(purpose, length):
    return HKDF(
        algorithm=SHA256(), length=length, salt=salt,
        info=f"{profile}/0/{purpose}".encode("ascii"),
    ).derive(secret)


mailbox = derive("mailbox", 16)
key = derive("encryption", 32)
prefix = b"\x01" + message_id + iv
text = "Independently issued binary message."
header = b'["text/plain",""]'
plain = struct.pack(">H", len(header)) + header + text.encode("utf8")
wire = prefix + AESGCM(key).encrypt(iv, plain, mailbox + prefix)
print(json.dumps({
    "invitation": f"{profile} https://relay.example {b64(salt)} {b64(secret)}",
    "id": b64(message_id),
    "mailbox": b64(mailbox),
    "read": b64(derive("read", 32)),
    "write": b64(derive("write", 32)),
    "wire": b64(wire),
    "plaintext": text,
}, indent=2))
