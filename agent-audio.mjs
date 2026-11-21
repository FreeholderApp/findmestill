// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { checkMedia, wav16, wavInfo } from "./public/media/format.mjs";

const maxSeconds = 120;
const targetRate = 16000;
const maxPcm = maxSeconds * targetRate * 2;
const model = "/usr/share/pocketsphinx/model/en-us";
const multiarch = { x64: "x86_64-linux-gnu", arm64: "aarch64-linux-gnu" }[process.arch];

function isolatedFFmpeg(args, payload, maxOutput, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/bwrap", [
      "--unshare-net", "--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session",
      "--clearenv", "--setenv", "PATH", "/usr/bin", "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache",
      "--setenv", "LD_LIBRARY_PATH", `/usr/lib/${multiarch}/blas:/usr/lib/${multiarch}/lapack`,
      "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--chdir", "/tmp",
      "/usr/bin/prlimit", "--as=1073741824", "--cpu=25", "--",
      "/usr/bin/ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
      "-max_alloc", "67108864", "-threads", "1", "-filter_threads", "1", ...args,
    ], { stdio: ["pipe", "pipe", "ignore"] });
    let size = 0;
    let stopped;
    const chunks = [];
    function stop(message) {
      stopped ??= Error(message);
      child.kill("SIGKILL");
    }
    const timer = setTimeout(() => stop("Isolated media processing timed out"), timeout);
    child.on("error", () => { clearTimeout(timer); reject(Error("The isolated media runtime is unavailable")); });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") stop("Could not pass media to the isolated runtime"); });
    child.stdout.on("data", data => {
      size += data.length;
      if (size > maxOutput) stop("Isolated media output exceeds its limit");
      if (!stopped) chunks.push(data);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (stopped || code !== 0) reject(stopped ?? Error("Isolated media processing failed"));
      else resolve(Buffer.concat(chunks, size));
    });
    child.stdin.end(payload);
  });
}

export async function normalizeAudio({ mime, content }) {
  checkMedia(mime, content);
  let args;
  let input;
  let source;
  if (mime === "audio/wav") {
    const { channels, rate, seconds } = wavInfo(content);
    if (seconds > maxSeconds) throw Error("The agent can listen for up to two minutes");
    args = ["-f", "s16le", "-ac", String(channels), "-ar", String(rate)];
    input = content.subarray(44);
    source = "pipe:0";
  } else {
    args = ["-read_ahead_limit", "-1", "-f", mime === "video/mp4" ? "mov" : "matroska"];
    input = content;
    source = "cache:pipe:0";
  }
  const normalized = await isolatedFFmpeg([
    "-protocol_whitelist", "pipe,cache", ...args, "-i", source, "-map", "0:a:0",
    "-vn", "-sn", "-dn", "-t", String(maxSeconds), "-ac", "1", "-ar", String(targetRate),
    "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
  ], input, maxPcm, 15000);
  return wav16(normalized, targetRate);
}

export async function transcribeOffline(wav) {
  const { channels, rate, seconds } = wavInfo(wav);
  if (channels !== 1 || rate !== targetRate || seconds > maxSeconds) throw Error("Normalized audio is required");
  const raw = await isolatedFFmpeg([
    "-protocol_whitelist", "pipe", "-f", "s16le", "-ac", "1", "-ar", String(targetRate), "-i", "pipe:0",
    "-af", `apad=pad_dur=1.5,asr=hmm=${model}/en-us:dict=${model}/cmudict-en-us.dict:lm=${model}/en-us.lm.bin,ametadata=mode=print:key=lavfi.asr.text:file=-`,
    "-f", "null", "/dev/null",
  ], wav.subarray(44), 32768, 45000);
  return raw.toString("utf8").split("\n").filter(line => line.startsWith("lavfi.asr.text="))
    .map(line => line.slice("lavfi.asr.text=".length)).join(" ").trim();
}
