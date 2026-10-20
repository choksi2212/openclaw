import { bindAbortRelay } from "../utils/fetch-timeout.js";
import { normalizeRequestInitHeadersForFetch } from "./fetch-headers.js";

type FetchWithPreconnect = typeof fetch & {
  preconnect: (url: string, init?: { credentials?: RequestCredentials }) => void;
};

type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

// Mark wrapped fetch functions so repeated resolver calls preserve identity and
// avoid stacking abort relays around the same implementation.
const wrapFetchWithAbortSignalMarker = Symbol.for("openclaw.fetch.abort-signal-wrapped");

type FetchWithAbortSignalMarker = typeof fetch & {
  [wrapFetchWithAbortSignalMarker]?: true;
};

// Stamp wrappers whose transport is the ambient global fetch. Dispatcher-aware
// callers use the stamp to avoid handing those wrappers request dispatchers
// from a foreign undici generation, which Node's built-in fetch rejects.
const wrapsAmbientGlobalFetchMarker = Symbol.for("openclaw.fetch.wraps-ambient-global-fetch");

type FetchWithAmbientGlobalFetchMarker = typeof fetch & {
  [wrapsAmbientGlobalFetchMarker]?: true;
};

/** Stamps a fetch wrapper as forwarding to the ambient global fetch. */
export function markWrapsAmbientGlobalFetch(fetchImpl: typeof fetch): void {
  Object.defineProperty(fetchImpl, wrapsAmbientGlobalFetchMarker, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

/** Returns true for wrappers known to forward to the ambient global fetch. */
export function isWrapperOfAmbientGlobalFetch(fetchImpl: typeof fetch | undefined): boolean {
  return (
    typeof fetchImpl === "function" &&
    (fetchImpl as FetchWithAmbientGlobalFetchMarker)[wrapsAmbientGlobalFetchMarker] === true
  );
}

/** Copies the ambient-global-fetch wrapper stamp onto a derived wrapper. */
export function forwardWrapsAmbientGlobalFetch<T extends typeof fetch>(
  source: typeof fetch | undefined,
  target: T,
): T {
  if (isWrapperOfAmbientGlobalFetch(source)) {
    markWrapsAmbientGlobalFetch(target);
  }
  return target;
}

function withDuplex(
  init: RequestInit | undefined,
  input: RequestInfo | URL,
): RequestInitWithDuplex | undefined {
  const hasInitBody = init?.body != null;
  const hasRequestBody =
    !hasInitBody &&
    typeof Request !== "undefined" &&
    input instanceof Request &&
    input.body != null;
  if (!hasInitBody && !hasRequestBody) {
    return init;
  }
  if (init && "duplex" in (init as Record<string, unknown>)) {
    return init;
  }
  // Node requires `duplex: "half"` for streaming request bodies; browsers ignore it.
  return { ...init, duplex: "half" };
}

/**
 * Wraps fetch so Node-compatible duplex bodies, normalized headers, and foreign
 * AbortSignal implementations work against runtimes expecting native signals.
 */
export function wrapFetchWithAbortSignal(fetchImpl: typeof fetch): typeof fetch {
  if ((fetchImpl as FetchWithAbortSignalMarker)[wrapFetchWithAbortSignalMarker]) {
    return fetchImpl;
  }

  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const patchedInit = normalizeRequestInitHeadersForFetch(withDuplex(init, input));
    const signal = patchedInit?.signal;
    if (
      !signal ||
      (typeof AbortSignal !== "undefined" && signal instanceof AbortSignal) ||
      typeof AbortController === "undefined" ||
      typeof signal.addEventListener !== "function"
    ) {
      return fetchImpl(input, patchedInit);
    }
    const controller = new AbortController();
    const onAbort = bindAbortRelay(controller);
    let listenerAttached = false;
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      listenerAttached = true;
    }
    const cleanup = () => {
      if (!listenerAttached || typeof signal.removeEventListener !== "function") {
        return;
      }
      listenerAttached = false;
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        // Foreign/custom AbortSignal implementations may throw here.
        // Never let cleanup mask the original fetch result/error.
      }
    };
    try {
      const response = fetchImpl(input, { ...patchedInit, signal: controller.signal });
      return response.finally(cleanup);
    } catch (error) {
      cleanup();
      throw error;
    }
  }) as FetchWithPreconnect;

  const wrappedFetch = Object.assign(wrapped, fetchImpl) as FetchWithPreconnect;
  const fetchWithPreconnect = fetchImpl as FetchWithPreconnect;
  wrappedFetch.preconnect =
    typeof fetchWithPreconnect.preconnect === "function"
      ? fetchWithPreconnect.preconnect.bind(fetchWithPreconnect)
      : () => {};

  Object.defineProperty(wrappedFetch, wrapFetchWithAbortSignalMarker, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  if (fetchImpl === globalThis.fetch) {
    markWrapsAmbientGlobalFetch(wrappedFetch);
  }

  return wrappedFetch;
}

export function resolveFetch(fetchImpl?: typeof fetch): typeof fetch | undefined {
  const resolved = fetchImpl ?? globalThis.fetch;
  if (!resolved) {
    return undefined;
  }
  return wrapFetchWithAbortSignal(resolved);
}
