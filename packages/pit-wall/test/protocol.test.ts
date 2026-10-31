import { describe, expect, it } from "vitest";
import {
  BUG_FAMILIES,
  initialState,
  parseClientFrame,
  parseServerFrame,
} from "../src/protocol.js";

describe("phone protocol", () => {
  it("accepts exactly six hint enums and rejects text or extra trust fields", () => {
    for (const family of BUG_FAMILIES)
      expect(
        parseClientFrame({
          type: "action",
          id: "1",
          roundId: "r",
          action: "hint",
          family,
        }),
      ).not.toBeNull();
    for (const bad of ["please fix gravity", "", {}, null])
      expect(
        parseClientFrame({
          type: "action",
          id: "1",
          roundId: "r",
          action: "hint",
          family: bad,
        }),
      ).toBeNull();
    expect(
      parseClientFrame({
        type: "action",
        id: "1",
        roundId: "r",
        action: "veto",
        authorized: true,
      }),
    ).toBeNull();
    expect(
      parseClientFrame({ type: "action", id: "1", action: "veto" }),
    ).toBeNull();
    expect(
      parseClientFrame({ type: "pair", code: "123456", token: "twitch" }),
    ).toBeNull();
  });
  it("validates snapshots and selects only phone fields", () => {
    const frame = {
      type: "state",
      sequence: 1,
      serverTimeMs: 100,
      state: { ...initialState(), secret: "never-forward" },
    };
    expect(parseServerFrame(frame)).toEqual({
      ...frame,
      state: initialState(),
    });
    for (const bad of [-1, NaN, Infinity, "3"])
      expect(
        parseServerFrame({
          ...frame,
          state: { ...initialState(), deaths: bad },
        }),
      ).toBeNull();
    expect(parseServerFrame({ ...frame, sequence: -1 })).toBeNull();
    expect(
      parseServerFrame({
        ...frame,
        state: { ...initialState(), phase: "pretend" },
      }),
    ).toBeNull();
  });
});
