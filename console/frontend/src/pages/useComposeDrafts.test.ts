// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
/**
 * Compose's drafts (useComposeDrafts.ts): a change is saved a second after
 * the last one, naming the version the previous save returned; opening one
 * saves nothing; a rename moves the draft; a save someone else beat stops
 * saving until keepMine.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, deleteDraft, listDrafts, saveDraft, type StoredDraft } from "../api";
import type { Draft } from "../compose";
import { useComposeDrafts } from "./useComposeDrafts";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listDrafts: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));

const draft = (name: string, displayName = ""): Draft => ({ team: "web", name, displayName, description: "", steps: [] });
const stored = (d: Draft, version: number): StoredDraft => ({ team: d.team, name: d.name, body: { ...d }, version, updatedBy: "a@x", updatedAt: null });

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(listDrafts).mockResolvedValue([]);
  vi.mocked(saveDraft).mockImplementation((input) => Promise.resolve(stored(input.body as unknown as Draft, input.version + 1)));
  vi.mocked(deleteDraft).mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function settle(ms = 1000): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useComposeDrafts", () => {
  it("saves a second after the last change, each save naming the version before it", async () => {
    const { result, rerender } = renderHook(({ d }) => useComposeDrafts(d), { initialProps: { d: draft("mine") } });
    await settle();
    expect(saveDraft).not.toHaveBeenCalled(); // nothing changed yet

    act(() => { result.current.edited(); });
    rerender({ d: draft("mine", "M") });
    await settle(500);
    act(() => { result.current.edited(); });
    rerender({ d: draft("mine", "Mine") });
    await settle();
    expect(vi.mocked(saveDraft).mock.calls.map(([c]) => [c.body["displayName"], c.version])).toEqual([["Mine", 0]]);

    act(() => { result.current.edited(); });
    rerender({ d: draft("mine", "Mine!") });
    await settle();
    expect(vi.mocked(saveDraft).mock.calls.map(([c]) => c.version)).toEqual([0, 1]);
    expect(result.current.status).toBe("saved");
    await settle(5000);
    expect(saveDraft).toHaveBeenCalledTimes(2); // saved, so not again
  });

  it("moves a renamed draft, and saves nothing for a name its file couldn't have", async () => {
    const { result, rerender } = renderHook(({ d }) => useComposeDrafts(d), { initialProps: { d: draft("old") } });
    act(() => { result.current.opened(draft("old")); result.current.edited(); });
    rerender({ d: draft("new-") });
    await settle();
    expect(saveDraft).not.toHaveBeenCalled();
    act(() => { result.current.edited(); });
    rerender({ d: draft("new") });
    await settle();
    expect(vi.mocked(saveDraft).mock.calls[0]?.[0].name).toBe("new");
    expect(deleteDraft).toHaveBeenCalledWith("web", "old");
  });

  it("stops at a save someone else beat, until keepMine saves over theirs", async () => {
    vi.mocked(saveDraft).mockRejectedValueOnce(new ApiError(412, "Someone saved it since.", "DRAFT_CHANGED", { version: 4 }));
    const { result, rerender } = renderHook(({ d }) => useComposeDrafts(d), { initialProps: { d: draft("shared") } });
    act(() => { result.current.edited(); });
    rerender({ d: draft("shared", "Mine") });
    await settle();
    expect(result.current.status).toBe("conflict");
    await settle(5000);
    expect(saveDraft).toHaveBeenCalledTimes(1);

    act(() => { result.current.keepMine(); });
    await settle(0);
    expect(vi.mocked(saveDraft).mock.calls[1]?.[0].version).toBe(4);
    expect(result.current.status).toBe("saved");
  });

  it("never saves over someone else's draft of the same name it didn't open", async () => {
    // A teammate's draft is listed; this page starts a new one by that name.
    const theirs = draft("my-template", "Theirs");
    vi.mocked(listDrafts).mockResolvedValue([stored(theirs, 3)]);
    const { result, rerender } = renderHook(({ d }) => useComposeDrafts(d), { initialProps: { d: draft("my-template") } });
    await settle(0);
    act(() => { result.current.edited(); });
    rerender({ d: draft("my-template", "Mine") });
    await settle();
    // Saved as new (version 0), which the server refuses as a conflict, not as an update of theirs.
    expect(vi.mocked(saveDraft).mock.calls.map(([c]) => c.version)).toEqual([0]);

    // Opened (a fresh page), it's this page's to save over.
    vi.mocked(saveDraft).mockClear();
    const opened = renderHook(({ d }) => useComposeDrafts(d), { initialProps: { d: theirs } });
    await settle(0);
    act(() => { opened.result.current.opened(theirs); opened.result.current.edited(); });
    opened.rerender({ d: draft("my-template", "Edited") });
    await settle();
    expect(vi.mocked(saveDraft).mock.calls.map(([c]) => c.version)).toEqual([3]);
  });
});
