export type ActivityItem = {
  hash: string;
  kind: string;
  summary: string;
  at: number;
};

const KEY = "blazarswap.activity.v1";

export function readActivity(): ActivityItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ActivityItem[]) : [];
  } catch {
    return [];
  }
}

export function pushActivity(item: ActivityItem) {
  const next = [item, ...readActivity()].slice(0, 40);
  window.localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new Event("blazar-activity"));
  return next;
}
