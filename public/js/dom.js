// DOM helpers, icons and formatters. Text is always inserted as text
// nodes, never as HTML, so recorded content cannot inject markup.

/** Creates an element. Children may be strings, numbers, nodes, arrays or null. */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'className') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'checked' || key === 'disabled' || key === 'open') el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, child) {
  if (child == null || child === false) return;
  if (Array.isArray(child)) child.forEach((c) => append(el, c));
  else el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

/** Replaces the content of an element. */
export function mount(target, ...children) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  el.textContent = '';
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  po: 'M9 4h6M9 4a2 2 0 0 0-2 2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-1a2 2 0 0 0-2-2M8 12h8M8 16h5',
  dev: 'M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14',
  qa: 'M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3zM9 12l2 2 4-4',
  system: 'M12 8v4l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  request: 'M4 5h16v11H8l-4 4V5z',
  analysis: 'M4 6h16M4 12h10M4 18h7M17 15l2 2 3-4',
  handoff: 'M5 12h14M13 6l6 6-6 6',
  implementation: 'M8 8l-4 4 4 4M16 8l4 4-4 4',
  file: 'M7 3h7l5 5v13H7V3zM14 3v5h5',
  command: 'M4 5h16v14H4V5zM8 10l2 2-2 2M12 15h4',
  test: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3',
  defect: 'M12 7a4 4 0 0 1 4 4v3a4 4 0 0 1-8 0v-3a4 4 0 0 1 4-4zM12 7V4M8 12H4M20 12h-4M5 7l3 2M19 7l-3 2M5 18l3-2M19 18l-3-2',
  correction: 'M14 6a4 4 0 0 0 5 5l-9 9a2 2 0 0 1-3-3l9-9a4 4 0 0 0-2-2z',
  review: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  config: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
  git: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 12h6M15 12h6',
  completion: 'M5 21V4M5 4h11l-2 4 2 4H5',
  workflow: 'M5 6h4v4H5zM15 14h4v4h-4zM9 8h4a2 2 0 0 1 2 2v4',
  error: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  home: 'M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z',
  team: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14a6.5 6.5 0 0 1 3.5 6',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  preview: 'M3 5h18v12H3V5zM8 21h8M12 17v4',
  repository: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  send: 'M5 12h14M13 6l6 6-6 6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  chevron: 'M9 6l6 6-6 6',
  chat: 'M4 5h16v11H9l-5 4V5zM8 10h8M8 13h5',
  local: 'M4 5h16v10H4V5zM2 19h20',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  analytics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  ai: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z',
};

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.system);
  svg.appendChild(path);
  return svg;
}

export function time(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}

export function shortTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

export function dateTime(iso) {
  return iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

export function duration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}

export function bytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function last(list) {
  return list.length ? list[list.length - 1] : undefined;
}
