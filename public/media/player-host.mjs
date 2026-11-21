// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import { maxMediaBytes, supported } from "./format.mjs";
import { relayOrigin } from "./pair.mjs";

export function attachPlayer(container, origin, { mime, content }, onState = () => {}) {
  const trusted = relayOrigin(origin);
  if (new URL(trusted).hostname === location.hostname || !supported.includes(mime)
    || !(content instanceof Uint8Array) || content.length === 0 || content.length > maxMediaBytes) {
    throw Error("Protected player configuration or media is invalid");
  }
  const frame = document.createElement("iframe");
  frame.title = "Protected media player";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.referrerPolicy = "no-referrer";
  frame.src = new URL("/", trusted).href;
  const channel = new MessageChannel();
  const controller = new AbortController();
  let loaded = false;
  let sent = false;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timeout);
    controller.abort();
    channel.port1.close();
    if (!loaded) channel.port2.close();
    frame.remove();
  };
  const timeout = setTimeout(() => {
    dispose();
    onState("Protected player unavailable", "unavailable");
  }, 8000);
  channel.port1.onmessage = ({ data }) => {
    if (disposed) return;
    if (!sent && data === "fms.player.ready.v1") {
      sent = true;
      const bytes = content.slice().buffer;
      channel.port1.postMessage({ type: "fms.player.media.v1", mime, bytes }, [bytes]);
    } else if (sent && ["fms.player.loaded.v1", "fms.player.failed.v1"].includes(data)) {
      clearTimeout(timeout);
      if (data === "fms.player.loaded.v1") onState("Protected player ready", "ready");
      else onState("This browser could not open the media", "rejected");
    }
  };
  frame.addEventListener("load", () => {
    if (loaded) {
      dispose();
      onState("Protected player closed", "closed");
      return;
    }
    loaded = true;
    // A restrictive frame-src and a dedicated player site pin the frame document.
    // Its opaque origin requires "*" only to transfer the port. Media uses the port.
    frame.contentWindow.postMessage("fms.player.connect.v1", "*", [channel.port2]);
  }, { signal: controller.signal });
  container.replaceChildren(frame);
  return dispose;
}
