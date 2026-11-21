// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import { wav16 } from "./format.mjs";

const rate = 16000;
const byteLimit = rate * 2 * 120;
export async function recordVoice() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
  const context = new AudioContext({ sampleRate: rate });
  try {
    if (context.sampleRate !== rate) throw Error("This device cannot record the supported voice format");
    await context.audioWorklet.addModule("/media/pcm-worklet.mjs");
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "findmestill-pcm");
    const gain = context.createGain();
    gain.gain.value = 0;
    source.connect(worklet).connect(gain).connect(context.destination);
    const chunks = [];
    let length = 0;
    let stopping = false;
    let end;
    const done = new Promise(resolve => { end = resolve; });
    const stop = () => {
      if (!stopping) {
        stopping = true;
        worklet.port.postMessage("stop");
      }
      return done;
    };
    const watchdog = setTimeout(stop, 120000);
    const endTrack = () => stop();
    stream.getAudioTracks().forEach(track => track.addEventListener("ended", endTrack, { once: true }));
    worklet.port.onmessage = ({ data }) => {
      if (data === "stopped") {
        clearTimeout(watchdog);
        worklet.port.close();
        stream.getTracks().forEach(track => track.stop());
        context.close().catch(() => {});
        const result = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        end(length ? wav16(result) : null);
        return;
      }
      const bytes = new Uint8Array(data, 0, Math.min(data.byteLength, byteLimit - length));
      if (bytes.length) chunks.push(bytes);
      length += bytes.length;
      if (length >= byteLimit) stop();
    };
    worklet.onprocessorerror = () => {
      clearTimeout(watchdog);
      worklet.port.close();
      stream.getTracks().forEach(track => track.stop());
      context.close().catch(() => {});
      end(null);
    };
    await context.resume();
    return { stop, done };
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    await context.close();
    throw error;
  }
}
