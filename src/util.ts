export const MIN = 60_000;

/** Minutes as a number, or strings like "90", "5m", "30s", "2h". Returns ms or null. */
export function parseDuration(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v * MIN;
  if (typeof v !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  return n * (unit === 's' ? 1000 : unit === 'h' ? 60 * MIN : unit === 'd' ? 1440 * MIN : MIN);
}

/** Epoch ms number, or an ISO string. Returns ms or null. */
export function parseTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
