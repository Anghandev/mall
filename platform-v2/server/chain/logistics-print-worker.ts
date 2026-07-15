export interface PrintJobDispatcher {
  dispatchNextPrintJob(): Promise<unknown | undefined>;
}

export class LogisticsPrintWorker {
  readonly #dispatcher: PrintJobDispatcher;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #active: Promise<unknown> | undefined;

  constructor(input: { dispatcher: PrintJobDispatcher; intervalMs?: number }) {
    this.#dispatcher = input.dispatcher;
    this.#intervalMs = input.intervalMs ?? 5_000;
  }

  pollOnce() {
    if (this.#active) return this.#active;
    this.#active = this.#dispatcher.dispatchNextPrintJob().finally(() => {
      this.#active = undefined;
    });
    return this.#active;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.pollOnce().catch(() => undefined), this.#intervalMs);
    this.#timer.unref?.();
  }

  async stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#active?.catch(() => undefined);
  }
}
