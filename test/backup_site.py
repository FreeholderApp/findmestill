# SPDX-License-Identifier: Apache-2.0
"""Independent static contact-card host for the local interoperability test."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import ssl
import sys
from urllib.parse import urlsplit

certificate, key, fixture_path = sys.argv[1:]
fixture = json.loads(Path(fixture_path).read_text())
locations = {
    (url.netloc, url.path)
    for url in map(urlsplit, (fixture["backup"], fixture["movedPrimary"]))
}
body = json.dumps(fixture["moved"]).encode()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if (self.headers.get("Host"), self.path) not in locations:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    print(server.server_port, flush=True)
    server.serve_forever()
