import type {Issue} from './types.js';

const words = (value: string) =>
  new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/)
      .filter(token => token.length > 1)
  );
/** Rough 0..1 score used to suggest possible duplicate findings. */
export function similarity(a: Issue, b: Issue) {
  const overlapping =
    a.location.path === b.location.path &&
    (a.location.startLine === undefined ||
      b.location.startLine === undefined ||
      Math.max(a.location.startLine, b.location.startLine) <=
        Math.min(a.location.endLine ?? a.location.startLine, b.location.endLine ?? b.location.startLine));
  const left = words(`${a.title} ${a.suggestion ?? ''}`),
    right = words(`${b.title} ${b.suggestion ?? ''}`);
  const shared = [...left].filter(token => right.has(token)).length,
    union = new Set([...left, ...right]).size;
  return (overlapping ? 0.5 : 0) + (union ? 0.5 * (shared / union) : 0);
}
