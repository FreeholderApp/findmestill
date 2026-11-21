// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
class PCMInput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new ArrayBuffer(4096);
    this.view = new DataView(this.buffer);
    this.offset = 0;
    this.port.onmessage = () => {
      this.flush();
      this.port.postMessage("stopped");
      this.ended = true;
    };
  }
  flush() {
    if (!this.offset) return;
    const data = this.buffer.slice(0, this.offset);
    this.port.postMessage(data, [data]);
    this.offset = 0;
  }
  process(inputs) {
    if (this.ended) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      this.view.setInt16(this.offset, Math.max(-32768, Math.min(32767, sample * 32768)), true);
      this.offset += 2;
      if (this.offset === this.buffer.byteLength) this.flush();
    }
    return true;
  }
}
registerProcessor("findmestill-pcm", PCMInput);
