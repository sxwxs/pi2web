// AudioWorklet: forward microphone frames as mono float32 PCM without recording or re-encoding.
class VoicePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(4096);
    this.offset = 0;
    this.finished = false;
    this.port.onmessage = event => {
      if (event.data?.type !== 'flush' || this.finished) return;
      this.finished = true;
      if (this.offset) {
        const tail = this.samples.slice(0, this.offset).buffer;
        this.port.postMessage(tail, [tail]);
        this.offset = 0;
      }
      this.port.postMessage({type: 'flushed'});
    };
  }
  process(inputs) {
    if (this.finished) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      this.samples[this.offset++] = sample;
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
        this.samples = new Float32Array(4096);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-pcm', VoicePcmProcessor);
