/**
 * Coroutine plumbing for actions.
 *
 * Every action is a generator that yields once per simulation tick; the value
 * delivered back is `dt` in seconds. That keeps action code linear and readable
 * (`yield*` composes sequences) while remaining fully deterministic and
 * step-driven, which is what both the headless runner and the future
 * fixed-timestep server loop need.
 */

export interface TaskOk {
  ok: true;
  message: string;
  data?: Record<string, unknown>;
}

export interface TaskFail {
  ok: false;
  code: string;
  message: string;
}

export type TaskResult = TaskOk | TaskFail;

/** Generator shape for a sub-step that yields nothing meaningful. */
export type Sub = Generator<void, void, number>;
/** Generator shape for a full action. */
export type TaskGen = Generator<void, TaskResult, number>;

export class ActionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ActionError";
    this.code = code;
  }
}

export function ok(message: string, data?: Record<string, unknown>): TaskOk {
  return data ? { ok: true, message, data } : { ok: true, message };
}

export function fail(code: string, message: string): TaskFail {
  return { ok: false, code, message };
}

/** Yields for `seconds` of simulated time. */
export function* advance(seconds: number): Sub {
  let t = 0;
  while (t < seconds) t += yield;
}

/**
 * Yields until `cond()` is true. Throws `ActionError("TIMEOUT", ...)` after
 * `limitSeconds` so a stuck action reports a reason instead of hanging.
 */
export function* until(cond: () => boolean, limitSeconds: number, what: string): Sub {
  let t = 0;
  while (!cond()) {
    t += yield;
    if (t > limitSeconds) {
      throw new ActionError("TIMEOUT", `等待超时（${limitSeconds}s）：${what}`);
    }
  }
}

/** Runs a generator one tick at a time and captures its result. */
export class TaskRunner {
  private readonly gen: TaskGen;
  private result: TaskResult | null = null;
  private error: unknown = null;
  started = false;

  constructor(gen: TaskGen) {
    this.gen = gen;
  }

  get done(): boolean {
    return this.result !== null || this.error !== null;
  }

  get outcome(): TaskResult | null {
    return this.result;
  }

  get failure(): unknown {
    return this.error;
  }

  step(dt: number): void {
    if (this.done) return;
    try {
      const r = this.gen.next(this.started ? dt : 0);
      this.started = true;
      if (r.done) {
        this.result = r.value ?? fail("NO_RESULT", "动作没有返回结果");
      }
    } catch (err) {
      if (err instanceof ActionError) {
        this.result = fail(err.code, err.message);
      } else {
        this.error = err;
      }
    }
  }

  /** Interrupts the action by throwing into the generator, running its `finally` blocks. */
  abort(reason = "急停"): void {
    if (this.done) return;
    try {
      const r = this.gen.throw(new ActionError("ABORTED", reason));
      if (r.done) this.result = r.value ?? fail("ABORTED", reason);
    } catch (err) {
      if (err instanceof ActionError) {
        this.result = fail(err.code, err.message);
      } else {
        this.error = err;
      }
    }
    if (this.result === null && this.error === null) {
      this.result = fail("ABORTED", reason);
    }
  }
}
