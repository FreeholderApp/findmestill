// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import { appOrigin } from "/player-config.mjs";
import { checkMedia } from "/media/format.mjs";

const status = document.querySelector("#status");
const play = document.querySelector("#play");
let url;
let media;
function cleanup() {
  if (media) {
    media.pause();
    media.removeAttribute("src");
    media.load();
    media.remove();
    media = undefined;
  }
  if (url) URL.revokeObjectURL(url);
  url = undefined;
}

function connect(event) {
  if (event.source !== parent || event.origin !== appOrigin || event.data !== "fms.player.connect.v1"
    || event.ports.length !== 1) return;
  window.removeEventListener("message", connect);
  const [port] = event.ports;
  port.addEventListener("message", ({ data }) => {
    try {
      if (data?.type !== "fms.player.media.v1" || !(data.bytes instanceof ArrayBuffer)) throw Error();
      checkMedia(data.mime, new Uint8Array(data.bytes));
      media = document.createElement(data.mime === "audio/wav" ? "audio" : "video");
      media.controls = true;
      media.preload = "none";
      media.disablePictureInPicture = true;
      media.disableRemotePlayback = true;
      media.setAttribute("controlslist", "nodownload noremoteplayback");
      media.setAttribute("playsinline", "");
      media.addEventListener("error", () => {
        status.textContent = "Playback is unavailable for this media";
        play.hidden = true;
      });
      url = URL.createObjectURL(new Blob([data.bytes], { type: data.mime }));
      media.src = url;
      document.querySelector("main").append(media);
      play.hidden = false;
      play.onclick = () => {
        media.play().then(() => {
          status.textContent = "Playing";
          play.hidden = true;
        }, () => { status.textContent = "Playback is unavailable for this media"; });
      };
      status.textContent = "Ready to play";
      port.postMessage("fms.player.loaded.v1");
    } catch {
      cleanup();
      status.textContent = "This file is outside the protected player’s supported formats";
      port.postMessage("fms.player.failed.v1");
    }
    port.close();
  }, { once: true });
  port.start();
  port.postMessage("fms.player.ready.v1");
}
window.addEventListener("message", connect);
window.addEventListener("pagehide", cleanup, { once: true });
