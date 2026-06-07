export type AsyncState<T, E = Error> =
  | { status: "idle" }
  | { status: "loading"; previous?: T }
  | { status: "success"; data: T; updatedAt: string }
  | { status: "error"; error: E; previous?: T };

export function idleState<T, E = Error>(): AsyncState<T, E> {
  return { status: "idle" };
}

export function loadingState<T, E = Error>(previous?: T): AsyncState<T, E> {
  return previous === undefined ? { status: "loading" } : { status: "loading", previous };
}

export function successState<T, E = Error>(data: T, updatedAt = new Date().toISOString()): AsyncState<T, E> {
  return { status: "success", data, updatedAt };
}

export function errorState<T, E = Error>(error: E, previous?: T): AsyncState<T, E> {
  return previous === undefined ? { status: "error", error } : { status: "error", error, previous };
}

export function isSettledState<T, E = Error>(state: AsyncState<T, E>) {
  return state.status === "success" || state.status === "error";
}
