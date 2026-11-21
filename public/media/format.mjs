// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
export const maxMediaBytes = 8 * 1024 * 1024;
export const supported = ["audio/wav", "video/mp4", "video/webm"];

const matches = (bytes, offset, text) => [...text].every((ch, i) => bytes[offset + i] === ch.charCodeAt(0));

export function wavInfo(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 46 || bytes.length > maxMediaBytes) throw Error("Invalid WAV length");
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = d.getUint16(22, true);
  const rate = d.getUint32(24, true);
  const align = channels * 2;
  if (!matches(bytes, 0, "RIFF") || !matches(bytes, 8, "WAVEfmt ") || !matches(bytes, 36, "data")
    || d.getUint32(4, true) !== bytes.length - 8 || d.getUint32(16, true) !== 16
    || d.getUint16(20, true) !== 1 || ![1, 2].includes(channels)
    || ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(rate)
    || d.getUint32(28, true) !== rate * align || d.getUint16(32, true) !== align || d.getUint16(34, true) !== 16
    || d.getUint32(40, true) !== bytes.length - 44 || (bytes.length - 44) % align !== 0) {
    throw Error("Only standard PCM16 WAV is supported");
  }
  return { channels, rate, seconds: (bytes.length - 44) / (rate * align) };
}

export function checkMedia(mime, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16 || bytes.length > maxMediaBytes) throw Error("Media is outside the supported size");
  if (mime === "audio/wav") return wavInfo(bytes);
  if (mime === "video/mp4" && matches(bytes, 4, "ftyp")) {
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
    if (boxSize >= 16 && boxSize <= Math.min(bytes.length, 4096)) return;
  }
  if (mime === "video/webm" && bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) return;
  throw Error("Choose a supported WAV, MP4 or WebM file");
}

export function wav16(pcm, rate = 16000) {
  if (!(pcm instanceof Uint8Array) || pcm.length < 2 || pcm.length % 2 || pcm.length > maxMediaBytes - 44) throw Error("Invalid PCM audio");
  const result = new Uint8Array(44 + pcm.length);
  const d = new DataView(result.buffer);
  const write = (offset, text) => result.set(new TextEncoder().encode(text), offset);
  write(0, "RIFF"); write(8, "WAVEfmt "); write(36, "data");
  d.setUint32(4, result.length - 8, true); d.setUint32(16, 16, true);
  d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, rate, true);
  d.setUint32(28, rate * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
  d.setUint32(40, pcm.length, true); result.set(pcm, 44);
  wavInfo(result);
  return result;
}
