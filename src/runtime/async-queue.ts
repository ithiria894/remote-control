type QueueResult<T> =
  | { done: false; value: T }
  | { done: true; value: undefined };

export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: QueueResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.items.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ done: true, value: undefined });
    }
  }

  async next(): Promise<QueueResult<T>> {
    const nextItem = this.items.shift();
    if (nextItem !== undefined) {
      return { done: false, value: nextItem };
    }

    if (this.closed) {
      return { done: true, value: undefined };
    }

    return new Promise<QueueResult<T>>(resolve => {
      this.waiters.push(resolve);
    });
  }
}
