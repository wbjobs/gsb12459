// 跨标签页时钟对齐：利用心跳消息估计对端墙钟与本机墙钟的偏移，
// 取滑动窗口中位数平滑，抵抗时钟漂移与偶发抖动。
export class ClockSync {
  constructor(windowSize = 21) {
    this.windowSize = windowSize;
    this.samples = [];
    this.offset = 0;
  }

  // sample = 消息发送方墙钟 - 本机收到时的墙钟（含极小传输延迟，同机可忽略）
  addSample(sample) {
    if (!Number.isFinite(sample)) return;
    this.samples.push(sample);
    if (this.samples.length > this.windowSize) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    this.offset = sorted[Math.floor(sorted.length / 2)];
  }

  // “全局一致”的墙钟：本机墙钟 + 估计偏移
  now() {
    return Date.now() + this.offset;
  }
}
