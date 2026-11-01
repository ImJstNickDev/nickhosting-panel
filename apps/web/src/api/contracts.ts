/** JSON boundary types: server Date values are serialized, never Date instances. */
export type Json<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;
export type Result<F extends (...args: never[]) => unknown> = Json<Awaited<ReturnType<F>>>;
