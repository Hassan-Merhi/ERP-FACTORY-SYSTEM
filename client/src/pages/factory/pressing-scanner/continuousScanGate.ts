/**
 * Anti-flooding gate for a continuous camera stream.
 * Suppresses identical consecutive frames and brief re-entry glitches without
 * blocking the next DIFFERENT bale's barcode.
 *
 * This is UI throttling, never a substitute for the server's lifetime
 * unique active confirmation index.
 */
export class ContinuousScanGate {
  private visible: string | null = null;
  private missed = 0;
  private readonly recent = new Map<string, number>();

  constructor(
    private readonly repeatCooldownMs = 3500,
    private readonly missingFramesToRearm = 3,
  ) {}

  frame(value: string | null | undefined, atMs: number): string | null {
    const barcode = value?.trim() || null;
    if (!barcode) {
      this.missed += 1;
      if (this.missed >= this.missingFramesToRearm) this.visible = null;
      return null;
    }
    this.missed = 0;
    if (barcode === this.visible) return null;
    this.visible = barcode;
    const last = this.recent.get(barcode);
    if (last !== undefined && atMs - last < this.repeatCooldownMs) return null;
    this.note(barcode, atMs);
    return barcode;
  }

  manual(value: string, atMs: number): string | null {
    const barcode = value.trim();
    if (!barcode) return null;
    const last = this.recent.get(barcode);
    if (last !== undefined && atMs - last < this.repeatCooldownMs) return null;
    this.visible = barcode;
    this.missed = 0;
    this.note(barcode, atMs);
    return barcode;
  }

  reset(): void {
    this.visible = null;
    this.missed = 0;
    this.recent.clear();
  }

  private note(value: string, atMs: number): void {
    this.recent.set(value, atMs);
    if (this.recent.size <= 64) return;
    const oldest = this.recent.keys().next().value;
    if (oldest !== undefined) this.recent.delete(oldest);
  }
}
