/** Tiny DOM helpers. Text always goes in as textContent: repo names and descriptions are untrusted. */

type Child = Node | string | number | null | undefined | false;
type Handlers = Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
type AttrValue = string | number | boolean | undefined | null;
type Attrs = { on?: Handlers; [key: string]: AttrValue | Handlers };

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'on' || value === undefined || value === null || value === false || typeof value === 'object') continue;
    element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const [event, handler] of Object.entries(attrs.on ?? {})) element.addEventListener(event, handler as EventListener);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

/** An external link that cannot reach back into this page. */
export const extLink = (href: string, text: string, className = 'ext') =>
  el('a', { href, target: '_blank', rel: 'noopener noreferrer', class: className }, text);

const numberFormat = new Intl.NumberFormat();
export const formatNumber = (n: number) => numberFormat.format(n);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = (Date.parse(iso) - now) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of steps)
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  return 'just now';
}

/** Drop the holes left by conditional children. */
export const compact = <T>(items: readonly (T | null | undefined | false)[]): T[] =>
  items.filter((item): item is T => item !== null && item !== undefined && item !== false);
