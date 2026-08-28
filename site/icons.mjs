/** Decorative, dependency-free line icons. Visible text supplies every label. */
const paths = {
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/>',
  champions: '<path d="m12 3 8 3v6c0 4.3-3.5 7.5-8 9-4.5-1.5-8-4.7-8-9V6z"/><path d="m8.5 11 2.3 2.3 4.7-4.7"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="m12 12 7-7"/><circle cx="12" cy="12" r="1"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5zm-9 9 9 5 9-5m-18 5 9 5 9-5"/>',
  chart: '<path d="M4 3v17h17M8 16v-4m5 4V8m5 8V5"/>',
  help: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/><path d="M10 8a2.1 2.1 0 0 1 4 1c0 1.4-2 1.8-2 3m0 3h.01"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
  play: '<path d="m9 5 11 7-11 7z"/>',
  arrowUpRight: '<path d="M6 18 18 6M6 6h12v12"/>',
  arrowDown: '<path d="M12 3v18m-7-7 7 7 7-7"/>',
  pause: '<path d="M8 5v14m8-14v14"/>',
  monitor: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5M7 7h4m-4 4h8"/>',
  target: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/><circle cx="12" cy="12" r="2"/>',
  matchup: '<path d="m4 3 8 8m8-8-8 8M4 3v5m0-5h5m11 0v5m0-5h-5M3 16l5 5m-3-2 6-6m5 8 5-5m-2 3-6-6"/>',
  overlay: '<rect x="3" y="4" width="18" height="15" rx="2"/><path d="M3 9h18m-6 0v10m3-6h.01m-.01 3h.01"/>',
};

export function icon(name) {
  if (!Object.hasOwn(paths, name)) throw new Error(`Unknown AllMid icon: ${name}`);
  return `<svg class="am-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}
