/**
 * FROZEN — one-at-a-time task queue for payment schemes that keep local state.
 *
 * Lives in its own file because it is load-bearing and was once lost in a
 * refactor: a batch-settlement channel signs every voucher against a running
 * total held in client-side storage, so two payments in flight at the same time
 * sign the same claim and the gateway rejects one of them (a bare 402,
 * `invalid_batch_settlement_evm_channel_busy`) — which ends the agent run.
 * Anything that can move the channel's state goes through one serializer.
 */

/**
 * Returns `serialize(task)`: runs tasks strictly one after another, in call
 * order, and resolves/rejects with the task's own outcome. A rejecting task does
 * not poison the queue for the tasks behind it.
 */
export function createSerializer() {
  let queue = Promise.resolve()
  return function serialize(task) {
    // `.then(task, task)` — the second handler is what keeps a failed
    // predecessor from skipping this task.
    const result = queue.then(task, task)
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
