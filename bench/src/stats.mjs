export function summarize(samples) {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0],
    median: q(0.5),
    p95: q(0.95),
    max: s[s.length - 1],
    mean: sum / s.length,
  };
}
