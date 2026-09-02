/** A small deterministic PRNG suitable for repeatable simulations (not cryptography). */
export class SeededRandom {
  private state: number;

  constructor(seed: number | string = 1) {
    this.state = hashSeed(seed) || 0x6d2b79f5;
  }

  next(): number {
    // Mulberry32: compact, deterministic and stable across JS runtimes.
    let value = (this.state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  chance(probability: number): boolean {
    return this.next() < clamp(probability, 0, 1);
  }

  between(minimum: number, maximum: number): number {
    if (maximum <= minimum) return minimum;
    return minimum + (maximum - minimum) * this.next();
  }

  integer(minimum: number, maximumInclusive: number): number {
    if (maximumInclusive <= minimum) return minimum;
    return Math.floor(this.between(minimum, maximumInclusive + 1));
  }

  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[this.integer(0, items.length - 1)];
  }

  fork(label: string): SeededRandom {
    return new SeededRandom(`${this.state}:${label}`);
  }
}

export function hashSeed(seed: number | string): number {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  const text = String(seed);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
