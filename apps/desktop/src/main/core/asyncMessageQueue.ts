/**
 * A minimal async queue used to feed a long-lived `query({ prompt: iter })`
 * call with live user turns.
 *
 * Shape
 * -----
 * `push(item)` is non-blocking: if the consumer is currently awaiting
 * `.next()`, the pending promise is resolved synchronously; otherwise
 * the item is buffered. `close()` drains buffered items (if any) and
 * then resolves subsequent `.next()` calls with `{ done: true }`, which
 * causes the SDK's child CLI process to exit cleanly.
 *
 * Why a custom queue (vs. a Node Readable or a package): the consumer
 * is a plain `for await` loop inside the agent SDK; the producer is the
 * Electron IPC handler. A two-line interface (`push`, `close`) is all
 * we need, and pulling in a dependency or a stream adapter would be
 * strictly more code and more failure modes than this.
 *
 * No error path: errors come from the SDK side (network, model, tool
 * crash) and surface through the iterator the SDK itself yields. This
 * queue only carries user-authored messages in one direction.
 */
export class AsyncMessageQueue<T> {
  private buffer: T[] = []
  private waiters: Array<(v: IteratorResult<T>) => void> = []
  private closed = false

  /**
   * Enqueue an item. Resolves a pending waiter if present; otherwise
   * buffers the item for the next call to `.next()`. A no-op after
   * `close()`.
   */
  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value: item, done: false })
      return
    }
    this.buffer.push(item)
  }

  /**
   * Mark the queue as closed. Any future `.next()` call resolves to
   * `{ done: true }` once the buffer is drained. Pending waiters are
   * immediately resolved with `{ done: true }`. Idempotent.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) {
      w({ value: undefined as unknown as T, done: true })
    }
  }

  /** Number of items currently buffered (pre-consumed). */
  get size(): number {
    return this.buffer.length
  }

  /** Whether `close()` has been called. */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * The AsyncIterable the agent SDK will consume as its streaming prompt.
   * `return()` is implemented so that a consumer's `break` inside
   * `for await` also closes the queue, preventing the producer from
   * pushing into an iterator nobody is draining.
   */
  iterable(): AsyncIterable<T> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            if (self.buffer.length > 0) {
              const value = self.buffer.shift() as T
              return Promise.resolve({ value, done: false })
            }
            if (self.closed) {
              return Promise.resolve({
                value: undefined as unknown as T,
                done: true
              })
            }
            return new Promise<IteratorResult<T>>((resolve) => {
              self.waiters.push(resolve)
            })
          },
          return(): Promise<IteratorResult<T>> {
            self.close()
            return Promise.resolve({
              value: undefined as unknown as T,
              done: true
            })
          }
        }
      }
    }
  }
}
