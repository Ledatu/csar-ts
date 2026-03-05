import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sleep } from "../src/sleep.js";

describe("sleep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the specified delay", async () => {
    const p = sleep(500);
    vi.advanceTimersByTime(500);
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects immediately if signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(1000, ac.signal)).rejects.toThrow("aborted");
  });

  it("rejects when signal aborts during wait", async () => {
    const ac = new AbortController();
    const p = sleep(5000, ac.signal);

    // Abort after 100ms (simulated)
    vi.advanceTimersByTime(100);
    ac.abort();

    await expect(p).rejects.toThrow("aborted");
  });

  it("clears timer on abort (no memory leak)", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const ac = new AbortController();
    const p = sleep(5000, ac.signal);

    ac.abort();

    await expect(p).rejects.toThrow();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("removes abort listener after normal completion", async () => {
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");

    const p = sleep(100, ac.signal);
    vi.advanceTimersByTime(100);
    await p;

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    removeSpy.mockRestore();
  });
});
