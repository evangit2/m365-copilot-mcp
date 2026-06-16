/**
 * Simple async semaphore / request queue.
 * Used to keep concurrent M365 chat streams under the account ceiling.
 */
class Semaphore {
  constructor(maxConcurrency) {
    this.max = Math.max(1, maxConcurrency);
    this.running = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.running < this.max) {
      this.running++;
      return () => this.release();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    this.running--;
    if (this.queue.length > 0) {
      this.running++;
      const next = this.queue.shift();
      next(() => this.release());
    }
  }

  size() {
    return this.queue.length;
  }
}

module.exports = { Semaphore };
