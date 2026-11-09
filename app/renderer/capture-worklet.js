class DesktopCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // Two render quanta: 5.33 ms at 48 kHz instead of accumulating 20 ms.
    this.frames = 256;
    this.samples = new Float32Array(this.frames * 2);
    this.position = 0;
    this.peak = 0;
  }
  process(inputs, outputs) {
    const channels = inputs[0] || [],
      left = channels[0],
      right = channels[1] || left;
    // Keep the stream clock running when the Windows output becomes silent.
    const length = left?.length || outputs?.[0]?.[0]?.length || 128;
    for (let i = 0; i < length; i++) {
      const l = left?.[i] || 0,
        r = right?.[i] || 0;
      this.samples[this.position++] = l;
      this.samples[this.position++] = r;
      this.peak = Math.max(this.peak, Math.abs(l), Math.abs(r));
      if (this.position === this.samples.length) {
        this.port.postMessage(
          { buffer: this.samples.buffer, level: this.peak },
          [this.samples.buffer],
        );
        this.samples = new Float32Array(this.frames * 2);
        this.position = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}
registerProcessor("desktop-capture", DesktopCapture);
