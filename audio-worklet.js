/**
 * Microphone capture, off the main thread.
 *
 * The old path used a ScriptProcessorNode, whose callback runs on the main
 * thread — the same thread that re-renders streaming markdown, lays out the
 * conversation and handles every click. Whenever that thread was busy the audio
 * callback was late, buffers were dropped, and the recording came back with
 * holes in it. A model handed a clip full of holes reasonably often answers
 * "<noise>".
 *
 * An AudioWorklet runs on the audio rendering thread instead, which nothing in
 * the UI can block.
 *
 * Frames arrive 128 samples at a time; posting each one would mean ~375 messages
 * a second, so they are batched. `flush` asks for the remainder when recording
 * stops, so the last fraction of a second is not lost.
 */

class NexoraCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const size = (options && options.processorOptions && options.processorOptions.batchSize) || 2048;
    this.batch = new Float32Array(size);
    this.filled = 0;

    this.port.onmessage = (event) => {
      if (event.data === 'flush') this.flush();
    };
  }

  flush() {
    if (!this.filled) return;
    this.port.postMessage(this.batch.slice(0, this.filled));
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || !channel.length) return true;

    for (let i = 0; i < channel.length; i++) {
      this.batch[this.filled++] = channel[i];
      if (this.filled === this.batch.length) {
        this.port.postMessage(this.batch.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('nexora-capture', NexoraCaptureProcessor);
