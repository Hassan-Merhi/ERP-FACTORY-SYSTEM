import { describe, expect, it } from "vitest";
import { CHRISTMAS_JINGLE_DURATION_MS, christmasJingleNoteEvents } from "./christmasJingle";

describe("one-time Christmas login jingle", () => {
  it("is a bounded ten-second musical greeting", () => {
    expect(CHRISTMAS_JINGLE_DURATION_MS).toBe(10_000);
    const notes = christmasJingleNoteEvents();
    const phraseLength = notes.reduce((total, [, duration]) => total + duration, 0);
    expect(phraseLength).toBeGreaterThan(8.5);
    expect(phraseLength).toBeLessThan(9.9);
  });

  it("opens with the recognizable repeated E-note Jingle Bells chorus", () => {
    const notes = christmasJingleNoteEvents();
    expect(notes.slice(0, 3).map(([midi]) => midi)).toEqual([76, 76, 76]);
    expect(notes.slice(4, 7).map(([midi]) => midi)).toEqual([76, 76, 76]);
    expect(notes.filter(([midi]) => midi !== null).length).toBeGreaterThan(20);
  });

  it("includes brief rests for phrasing instead of one continuous tone", () => {
    expect(christmasJingleNoteEvents().some(([midi]) => midi === null)).toBe(true);
  });
});
