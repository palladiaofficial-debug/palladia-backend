'use strict';
/**
 * lib/concurrencyLimit.js
 * Semaforo in-process per limitare operazioni concorrenti costose (AI, PDF, OCR).
 * Previene OOM e saturazione CPU quando molti utenti generano documenti contemporaneamente.
 */

class Semaphore {
  constructor(max) {
    this._max = max;
    this._running = 0;
    this._queue = [];
  }

  get running()  { return this._running; }
  get waiting()  { return this._queue.length; }

  acquire() {
    return new Promise(resolve => {
      if (this._running < this._max) {
        this._running++;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._running--;
    }
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const AI_CONCURRENCY  = Number(process.env.AI_CONCURRENCY)  || 3;
const PDF_CONCURRENCY = Number(process.env.PDF_CONCURRENCY) || 4;

const aiSemaphore  = new Semaphore(AI_CONCURRENCY);
const pdfSemaphore = new Semaphore(PDF_CONCURRENCY);

function withAiLimit(fn)  { return aiSemaphore.run(fn); }
function withPdfLimit(fn) { return pdfSemaphore.run(fn); }

function concurrencyStats() {
  return {
    ai:  { running: aiSemaphore.running,  waiting: aiSemaphore.waiting,  max: AI_CONCURRENCY },
    pdf: { running: pdfSemaphore.running, waiting: pdfSemaphore.waiting, max: PDF_CONCURRENCY },
  };
}

module.exports = { withAiLimit, withPdfLimit, concurrencyStats, Semaphore, aiSemaphore, pdfSemaphore };
