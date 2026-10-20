// Covers dispatcher routing around wrappers of the ambient global fetch.
// Node's built-in fetch rejects a bundled-undici dispatcher whenever the two
// undici generations disagree ("invalid onRequestStart method" on Node 24),
// so guarded hops must not hand those wrappers a dispatcher.
import type { Dispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard, type GuardedFetchOptions } from "./fetch-guard.js";
import type { DispatcherAwareRequestInit } from "./runtime-fetch.js";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const { agentCtor, envHttpProxyAgentCtor, proxyAgentCtor } = vi.hoisted(() => {
  function createMockDispatcher(
    this: { options: unknown; dispatch: Dispatcher["dispatch"] },
    options: unknown,
  ) {
    this.options = options;
    this.dispatch = vi.fn(() => true);
  }
  return {
    agentCtor: vi.fn(createMockDispatcher),
    envHttpProxyAgentCtor: vi.fn(createMockDispatcher),
    proxyAgentCtor: vi.fn(createMockDispatcher),
  };
});

const publicUrl = "https://public.example/resource";
const publicAddress = { address: "93.184.216.34", family: 4 };
const createPublicLookup = () => vi.fn(async () => [publicAddress]);
const okResponse = () => new Response("ok");

function installRuntime(fetch: NonNullable<GuardedFetchOptions["fetchImpl"]>) {
  Reflect.set(globalThis, TEST_UNDICI_RUNTIME_DEPS_KEY, {
    Agent: agentCtor,
    EnvHttpProxyAgent: envHttpProxyAgentCtor,
    ProxyAgent: proxyAgentCtor,
    fetch,
  });
}

function dispatchAttached(input: RequestInfo | URL, init?: DispatcherAwareRequestInit) {
  if (!init?.dispatcher) {
    throw new Error("expected attached dispatcher");
  }
  const url = new URL(input instanceof Request ? input.url : input.toString());
  init.dispatcher.dispatch(
    { origin: url.origin, path: url.pathname + url.search, method: "GET" },
    {},
  );
  return okResponse();
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, TEST_UNDICI_RUNTIME_DEPS_KEY);
});

describe("fetchWithSsrFGuard dispatcher compatibility", () => {
  it("routes dispatcher-attached hops around wrappers of the ambient global fetch", async () => {
    const runtimeFetch = vi.fn(
      async (input: RequestInfo | URL, init?: DispatcherAwareRequestInit) =>
        dispatchAttached(input, init),
    );
    installRuntime(runtimeFetch);
    const wrapperCalls: Array<[unknown, unknown]> = [];
    const markedWrapper = ((input, init) => {
      wrapperCalls.push([input, init]);
      throw new TypeError("fetch failed", {
        cause: new Error("invalid onRequestStart method"),
      });
    }) as typeof fetch;
    // The same stamp wrapFetchWithAbortSignal sets for wrappers of the ambient
    // global fetch; applied directly so this control exercises guard routing
    // rather than the marking helper itself.
    Object.defineProperty(markedWrapper, Symbol.for("openclaw.fetch.wraps-ambient-global-fetch"), {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    const { response } = await fetchWithSsrFGuard({
      url: publicUrl,
      lookupFn: createPublicLookup(),
      fetchImpl: markedWrapper,
    });

    expect(response.ok).toBe(true);
    expect(wrapperCalls).toHaveLength(0);
    expect(runtimeFetch).toHaveBeenCalledOnce();
    const dispatcherInstance = agentCtor.mock.instances[0] as
      | { dispatch: ReturnType<typeof vi.fn> }
      | undefined;
    expect(dispatcherInstance?.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        origin: "https://public.example",
        path: "/resource",
        method: "GET",
      }),
      {},
    );
  });

  it("keeps dispatcher init for unmarked caller fetch implementations", async () => {
    installRuntime(vi.fn(async () => okResponse()));
    const observed: Array<[unknown, DispatcherAwareRequestInit | undefined]> = [];
    const unmarkedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      observed.push([input, init as DispatcherAwareRequestInit | undefined]);
      return okResponse();
    }) as typeof fetch;

    const { response } = await fetchWithSsrFGuard({
      url: publicUrl,
      lookupFn: createPublicLookup(),
      fetchImpl: unmarkedFetch,
    });

    expect(response.ok).toBe(true);
    expect(observed).toHaveLength(1);
    expect(observed[0][1]?.dispatcher).toBeDefined();
  });

  it("keeps test-installed fetch mocks ahead of the bundled dispatcher runtime", async () => {
    installRuntime(
      vi.fn(async () => {
        throw new Error("runtime fetch must not be used for mocks");
      }) as unknown as typeof fetch,
    );
    const mockFetch = vi.fn(async () => okResponse());

    const { response } = await fetchWithSsrFGuard({
      url: publicUrl,
      fetchImpl: mockFetch,
    });

    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
