/**
 * `Redacted<T>` — a secret wrapper whose value never leaks through string
 * coercion, `JSON.stringify`, `console.log`/`util.inspect`, or object-key
 * enumeration. The only way to read the real value is the explicit `.expose()`.
 *
 * Borrowed from Effect's `Redacted` pattern — the *pattern*, not the framework
 * (see issue: borrow the wrapper, don't adopt Effect). The value is held in a
 * module-private WeakMap, so it is not an instance property and cannot be
 * reached by reflection/serialization.
 */
const store = new WeakMap<Redacted<unknown>, unknown>();

const MASK = "<redacted>";

export class Redacted<T = string> {
  constructor(value: T) {
    store.set(this, value);
  }

  /** The only path to the underlying value. Call sites become grep-able. */
  expose(): T {
    return store.get(this) as T;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  // console.log / util.inspect
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return MASK;
  }
}

export function redacted<T>(value: T): Redacted<T> {
  return new Redacted<T>(value);
}

export function isRedacted(x: unknown): x is Redacted<unknown> {
  return x instanceof Redacted;
}
