// Dev-only reference-led chrome study on the real Flow DOM. A shared reflected
// environment on remaining selected controls; tabs and dropdowns keep native
// fills/ink. The rail uses status-coloured edge lines,
// a selected-only flowing tint, and cursor-local gloss. No repeated fade masks.
// No source artwork or production component changes.
const style = document.createElement('style');
style.dataset.nat91Material = 'true';
style.textContent = `
  .nat91-control { isolation: isolate !important; }
  .nat91-control-static { position: relative; }
  /* Keep the native trigger/popup radii and fills in every open/closed state. */
  .nat91-gloss { position: absolute; inset: 0; z-index: -1; overflow: hidden; border-radius: inherit; pointer-events: none; opacity: 0; }
  .nat91-gloss-spot { position: absolute; left: -50%; top: -50%; width: 200%; height: 200%; background: radial-gradient(ellipse at center, rgb(255 255 255 / .09), transparent 55%); }
  :root:not(.dark) .nat91-gloss-spot { background: radial-gradient(ellipse at center, rgb(0 0 0 / .055), transparent 55%); }
  .nat91-control:focus-visible, .nat91-tab-surface:has(> [role="tab"]:focus-visible) { outline: 2px solid var(--ring); outline-offset: -2px; }
  :root { --nat91-chrome-ink: var(--background); }
  .dark { --nat91-chrome-ink: var(--foreground); }
  .nat91-control[data-nat91-chrome="true"] { color: var(--nat91-chrome-ink) !important; }
  .nat91-control[data-nat91-chrome="true"] .text-muted-foreground, .nat91-control[data-nat91-chrome="true"] .text-foreground { color: var(--nat91-chrome-ink) !important; opacity: 1; }
  .nat91-control[data-nat91-chrome="true"] .bg-foreground { background-color: var(--nat91-chrome-ink) !important; }
  .nat91-control[data-nat91-chrome="true"].nat91-adaptive-ink,
  .nat91-control[data-nat91-chrome="true"] .nat91-adaptive-ink {
    color: transparent !important;
    background-image: var(--nat91-type-image) !important;
    background-clip: text !important; -webkit-background-clip: text !important;
    background-origin: border-box !important; background-repeat: no-repeat !important;
    background-size: var(--nat91-type-size) !important;
    background-position: var(--nat91-type-position) !important;
  }
  .nat91-control[data-nat91-chrome="true"].nat91-adaptive-root::after {
    content: attr(data-nat91-type-text) / ""; position: absolute; inset: 0; z-index: 1;
    display: flex; align-items: center; justify-content: inherit; pointer-events: none;
    color: transparent; background-image: var(--nat91-type-image);
    background-clip: text; -webkit-background-clip: text; background-origin: border-box;
    background-size: var(--nat91-type-size); background-position: var(--nat91-type-position);
    background-repeat: no-repeat;
  }
  .nat91-control[data-nat91-chrome="true"]:focus-visible { outline-color: var(--nat91-chrome-ink); }
  .nat91-control-texture { position: absolute; inset: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; border-radius: inherit; }
  .nat91-control:active { transform: none !important; translate: none !important; }
  [data-sidebar="menu-button"].nat91-control { border-radius: 0 !important; background: var(--sidebar) !important; --nat91-chrome-ink: var(--sidebar-foreground); }
  [data-sidebar="menu-button"].nat91-control[data-nat91-activity] { border-left-color: var(--nat91-activity) !important; }
  .nat91-activity-dot { display: none !important; }
  /* Keep Band ordering/list names, but let the status edges carry visual state. */
  .nat91-session-band > [data-sidebar="group-label"] { display: none !important; }
  /* Native Dormant is a foreground-coloured hollow ring. With shape removed,
     give that indicator a muted grey so it remains distinct from filled Idle. */
  [aria-hidden].size-2.rounded-full.text-foreground.border-current { color: var(--muted-foreground) !important; }
  [data-sidebar="menu-button"].nat91-control[data-nat91-selected="true"] { background: var(--sidebar-accent) !important; }
  [data-sidebar="menu-button"].nat91-control[data-nat91-selected="true"] > span.flex-1 .text-muted-foreground { color: color-mix(in srgb, var(--sidebar-foreground) 80%, var(--sidebar-accent)) !important; }
  [data-sidebar="menu-button"].nat91-control[data-nat91-activity][data-nat91-selected="true"]::before {
    content: ""; position: absolute; inset: 0; z-index: -2; pointer-events: none;
    background-image: linear-gradient(90deg, transparent 0% 10%, color-mix(in srgb, var(--nat91-activity) 16%, transparent) 22%, transparent 46%, color-mix(in srgb, var(--nat91-activity) 8%, transparent) 72%, transparent 90% 100%);
    background-size: 200% 100%; background-repeat: repeat-x;
    animation: nat91-rail-flow 7s linear infinite;
  }
  /* A 200%-wide image moves RIGHT as percentage positioning decreases. */
  @keyframes nat91-rail-flow { from { background-position: 0% 50%; } to { background-position: -200% 50%; } }
  @media (prefers-reduced-motion: reduce) {
    [data-sidebar="menu-button"].nat91-control[data-nat91-activity][data-nat91-selected="true"]::before { animation: none; background-position: 50% 50%; }
  }
  [data-sidebar="menu-action"] { background: transparent !important; color: var(--sidebar-foreground) !important; }
  [data-sidebar="header"] { padding: 0 !important; }
  [data-sidebar="header"] [data-slot="button"] { border-radius: 0 !important; min-height: 42px; padding-inline: 12px; }
  /* A dedicated rail action occupies its whole row, not an inset pill. Keep
     compact mixed footers (Settings icon + live status) in their native layout. */
  .nat91-action-footer { padding: 0 !important; gap: 0 !important; }
  .nat91-action-footer > form { display: flex; width: 100%; margin: 0; }
  .nat91-action-footer > [data-slot="button"],
  .nat91-action-footer > form > [data-slot="button"] {
    width: 100%; height: 42px; min-height: 42px; border-radius: 0 !important;
    justify-content: flex-start; padding-inline: 12px;
  }
  .nat91-dock-strip { padding-inline: 0 !important; gap: 0 !important; }
  .nat91-dock-strip > button { align-self: stretch; width: 34px; height: auto; border-radius: 0 !important; }
  .nat91-tab-surface { border-radius: 0 !important; align-self: stretch; flex: 1 1 0; min-width: 80px; justify-content: space-between; padding-inline: 10px !important; gap: 2px !important; }
  .nat91-tab-rail { align-self: stretch; align-items: stretch !important; gap: 0 !important; min-height: 34px; }
  .nat91-tab-rail > [role="tab"] { flex: 1 1 0; }
  .nat91-tab-surface > [role="tab"] { align-self: stretch; min-width: 0; flex: 1; text-align: left; padding-inline: 0; }
  .nat91-segmented-surface { width: 100% !important; padding: 0 !important; gap: 0 !important; border-radius: 0 !important; }
  .nat91-segmented-surface > [data-slot="tabs-trigger"] { flex: 1; height: 36px; border-radius: 0 !important; }
  .nat91-view-strip { margin: -16px -16px 0; padding: 0 !important; }
  .nat91-action-strip { display: grid !important; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 !important; background: var(--card); }
  .nat91-action-strip > strong { grid-column: 1 / -1; padding-bottom: 10px; background: var(--background); }
  .nat91-action-strip > button { width: 100%; height: 34px; min-width: 0; border-radius: 0 !important; background: var(--card) !important; box-shadow: none !important; }
  @media (max-width: 640px) {
    .nat91-subagent-notice { display: grid; grid-template-columns: 8px 12px minmax(0, 1fr) auto; gap: 4px 8px; }
    .nat91-subagent-notice > .font-mono.text-sm { grid-column: 3; grid-row: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nat91-subagent-notice > .font-mono.text-xs { grid-column: 3 / -1; grid-row: 2; }
    .nat91-subagent-notice > span:last-child { grid-column: 4; grid-row: 1; }
  }
  .nat91-material-canvas { display: none; }
  @media (max-width: 640px) { .nat91-note { display: none; } }
  .nat91-note { position: fixed; bottom: 8px; right: 12px; z-index: 50; font: 9px/1.5 Inter, sans-serif; color: var(--muted-foreground); pointer-events: none; background: var(--background); padding: 3px 7px; }
`;
document.head.append(style);
const canvas = document.createElement('canvas');
canvas.className = 'nat91-material-canvas';
canvas.setAttribute('aria-hidden', 'true');
document.body.append(canvas);
const note = document.createElement('div');
note.className = 'nat91-note';
note.textContent = 'DEV STUDY · status edges / selected flow / cursor-local gloss';
document.body.append(note);
const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
if (!gl) throw new Error('This dev material study requires WebGL.');
const vertex = `
  attribute vec2 aPosition;
  uniform vec2 uViewport;
  uniform vec4 uRect;
  varying vec2 vUv;
  varying vec2 vPage;
  void main() {
    vUv = aPosition;
    vPage = uRect.xy + aPosition * uRect.zw;
    gl_Position = vec4(vPage.x / uViewport.x * 2.0 - 1.0, 1.0 - vPage.y / uViewport.y * 2.0, 0.0, 1.0);
  }
`;
const fragment = `
  precision highp float;
  varying vec2 vUv;
  varying vec2 vPage;
  uniform vec4 uRect;
  uniform vec4 uSurface;
  uniform vec2 uLight;
  uniform float uSelected;
  uniform float uRail;
  uniform float uHover;
  uniform float uLightTheme;
  uniform float uRadius;
  uniform float uDisabled;
  uniform vec3 uBackdrop;
  uniform vec3 uBlue;
  uniform vec3 uPurple;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec2 halfSize = uRect.zw * .5;
    vec2 q = abs((vUv - .5) * uRect.zw) - halfSize + uRadius;
    float shape = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
    if (shape > 0.0) discard;
    float brushX = vPage.x / 18.0;
    float brushY = floor(vPage.y * 1.8);
    float brush = mix(hash(vec2(floor(brushX), brushY)), hash(vec2(floor(brushX) + 1.0, brushY)), smoothstep(0.0, 1.0, fract(brushX))) - .5;
    float grain = brush * .008 + (hash(floor(vPage * 2.0)) - .5) * .003;

    // Reflect one common studio environment. A rail is one surface, not repeated
    // left-to-right masks on every child. Shallow face curvature rolls the reflected
    // silver, chromatic fields and black troughs at the surface's shoulders.
    float groupX = (vPage.x - uSurface.x) / max(uSurface.z, 1.0);
    float azimuth = (groupX - .5) * .45 + sin(uSurface.x * .002 + uSurface.y * .001) * .22;
    float y = (vUv.y - .5) * 2.0;
    vec3 normal = normalize(vec3(azimuth, sign(y) * pow(abs(y), 3.0) * .55 + brush * .006, 1.0));
    vec3 reflection = reflect(vec3(0.0, 0.0, -1.0), normal);
    // Off-axis reflected windows cross the curved face, not twin edge rules.
    float room = reflection.x * .85 + reflection.y * .60 + sin(uSurface.x * .0015) * .12;
    float whiteCatch = smoothstep(.23, .28, room) * (1.0 - smoothstep(.34, .40, room));
    float blackTrough = smoothstep(-.28, -.23, room) * (1.0 - smoothstep(-.13, -.08, room));
    float phase = .5 + .5 * sin(vPage.x * .004 + uSurface.y * .003);
    vec3 spectral = mix(pow(uBlue, vec3(6.0)), pow(uPurple, vec3(4.0)), phase * .16);
    float field = .72 + .16 * sin(reflection.x * 4.0 + reflection.y * 1.2);
    vec3 steel = mix(uBackdrop, vec3(.14, .17, .21), .8);
    vec3 chrome = mix(steel, spectral, field);
    chrome = mix(chrome, uBackdrop * mix(.24, .035, uLightTheme), blackTrough * .94);
    chrome = mix(chrome, vec3(.95) + mix(uBlue, uPurple, phase) * .035, whiteCatch);
    chrome += vec3(grain * (1.0 + whiteCatch));

    vec3 base = uBackdrop + mix(vec3(.003), vec3(-.006), uLightTheme);
    // Subdued, cursor-local button gloss. Moving over one button does not relight
    // every selection elsewhere in the interface.
    vec2 localLight = clamp((uLight - uRect.xy) / uRect.zw, 0.0, 1.0);
    vec2 delta = (vUv - localLight) / vec2(.65, .48);
    float gloss = exp(-dot(delta, delta));
    vec3 hover = mix(vec3(.08), vec3(-.05), uLightTheme) * gloss;
    hover += (mix(uBlue, uPurple, phase) - vec3(.5)) * gloss * .07;
    // A low-alpha sheen preserves the flowing CSS tint beneath the pointer,
    // rather than replacing it with a solid patch. Settle owns no canvas.
    if (uRail > .5) {
      vec3 sheen = mix(vec3(1.0), vec3(0.0), uLightTheme);
      sheen += (mix(uBlue, uPurple, phase) - vec3(.5)) * .07;
      gl_FragColor = vec4(clamp(sheen, 0.0, 1.0), gloss * uHover * mix(.09, .055, uLightTheme) * (1.0 - uDisabled));
      return;
    }
    vec3 color = mix(chrome, base, uDisabled * .95);
    // Inactive controls retain their actual native fill, including popup items.
    // The moving gloss is a separate compositor layer, never a GPU readback.
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), uSelected * (1.0 - uDisabled));
  }
`;
function shader(type, source) {
  const result = gl.createShader(type);
  gl.shaderSource(result, source);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result));
  return result;
}
const program = gl.createProgram();
gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
gl.useProgram(program);
const buffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
const attribute = gl.getAttribLocation(program, 'aPosition');
gl.enableVertexAttribArray(attribute);
gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
const uniforms = Object.fromEntries(['uViewport', 'uRect', 'uSurface', 'uLight', 'uSelected', 'uRail', 'uHover', 'uLightTheme', 'uRadius', 'uDisabled', 'uBackdrop', 'uBlue', 'uPurple'].map(name => [name, gl.getUniformLocation(program, name)]));
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let pointer = { x: innerWidth * .56, y: innerHeight * .3 };
let surfaces = [];
let frame;
let revision = 0;
const swatch = document.createElement('canvas');
swatch.width = swatch.height = 1;
const sampler = swatch.getContext('2d', { willReadFrequently: true });
const colorCache = new Map();
function rgbaOf(css) {
  let rgba = colorCache.get(css);
  if (!rgba) {
    sampler.clearRect(0, 0, 1, 1);
    sampler.fillStyle = css;
    sampler.fillRect(0, 0, 1, 1);
    rgba = [...sampler.getImageData(0, 0, 1, 1).data].map(channel => channel / 255);
    colorCache.set(css, rgba);
  }
  return rgba;
}
function backdropOf(target) {
  // A portal/backdrop over this control must never become its material input.
  // Native inactive fills remain visible; selected chrome uses its DOM surface.
  const layers = [];
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    const rgba = rgbaOf(getComputedStyle(parent).backgroundColor);
    if (rgba[3]) layers.push(rgba);
    if (rgba[3] === 1) break;
  }
  let color = document.documentElement.classList.contains('dark') ? [.035, .035, .035] : [1, 1, 1];
  for (const rgba of layers.reverse()) color = color.map((value, index) => value * (1 - rgba[3]) + rgba[index] * rgba[3]);
  return color;
}

const typeSurfaces = new WeakMap();
const materialCache = new WeakMap();
const stats = { draws: 0, lastDrawMs: 0, pointerFrames: 0, lastPointerMs: 0, inkBuilds: 0, materialBuilds: 0 };
function adaptiveInk(target, rect, texture) {
  // Preserve real DOM text / shaping / accessibility. Its foreground samples the
  // material at the black/white contrast crossover. No label-shaped dark patches.
  let surface = typeSurfaces.get(target);
  if (!surface) {
    const canvas = document.createElement('canvas');
    surface = { canvas, context: canvas.getContext('2d') };
    typeSurfaces.set(target, surface);
  }
  stats.inkBuilds++;
  const pixels = texture.getContext('2d').getImageData(0, 0, texture.width, texture.height);
  const linear = value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const luma = linear(pixels.data[i] / 255) * .2126 + linear(pixels.data[i + 1] / 255) * .7152 + linear(pixels.data[i + 2] / 255) * .0722;
    const ink = luma > .179 ? 0 : 255;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = ink;
    pixels.data[i + 3] = 255;
  }
  surface.canvas.width = texture.width; surface.canvas.height = texture.height;
  surface.context.putImageData(pixels, 0, 0);
  const image = `url("${surface.canvas.toDataURL()}")`;
  const nodes = new Set();
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (walker.currentNode.textContent.trim()) nodes.add(walker.currentNode.parentElement);
  }
  nodes.forEach(node => {
    const bounds = node.getBoundingClientRect();
    if (!node.classList.contains('nat91-adaptive-ink')) node.classList.add('nat91-adaptive-ink');
    if (node === target) {
      if (!node.classList.contains('nat91-adaptive-root')) node.classList.add('nat91-adaptive-root');
      node.dataset.nat91TypeText = [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('');
    }
    node.style.setProperty('--nat91-type-image', image);
    node.style.setProperty('--nat91-type-size', `${rect.width}px ${rect.height}px`);
    node.style.setProperty('--nat91-type-position', `${rect.left - bounds.left}px ${rect.top - bounds.top}px`);
  });
  target.querySelectorAll('svg, .bg-current.text-foreground, .border-current.text-foreground').forEach(node => {
    const bounds = node.getBoundingClientRect();
    const x = Math.max(0, Math.min(texture.width - 1, Math.floor((bounds.left + bounds.width * .5 - rect.left) / rect.width * texture.width)));
    const y = Math.max(0, Math.min(texture.height - 1, Math.floor((bounds.top + bounds.height * .5 - rect.top) / rect.height * texture.height)));
    node.style.setProperty('color', pixels.data[(y * texture.width + x) * 4] ? '#fff' : '#000', 'important');
    node.dataset.nat91InkIcon = 'true';
  });
}
function collect() {
  const settingsMenu = document.querySelector('[data-sidebar="menu"][aria-label="Settings sections"]');
  const actionFooter = settingsMenu?.closest('[data-sidebar="sidebar"]')?.querySelector('[data-sidebar="footer"]');
  if (actionFooter && !actionFooter.classList.contains('nat91-action-footer')) actionFooter.classList.add('nat91-action-footer');
  // Scope this to Agent Session menus, never the Settings navigation. The native
  // disclosure, count, keyboard handling and cursor protection stay untouched.
  for (const menu of document.querySelectorAll('[data-sidebar="menu"][aria-label$="Agent Sessions"]')) {
    const group = menu.closest('[data-sidebar="group"]');
    if (group && !group.classList.contains('nat91-session-band')) group.classList.add('nat91-session-band');
    if (menu.getAttribute('aria-label') === 'Filed away Agent Sessions') menu.setAttribute('aria-label', 'Settled Agent Sessions');
    const summary = group?.querySelector(':scope > details > summary');
    for (const text of summary?.childNodes ?? []) {
      if (text.nodeType === Node.TEXT_NODE && text.nodeValue.includes('Filed away')) text.nodeValue = text.nodeValue.replace('Filed away', 'Settled');
    }
  }
  const nodes = document.querySelectorAll('#root button, .nat91-action-footer [data-slot="button"], [data-sidebar="menu-button"], [data-sidebar="menu-action"], [data-slot="tabs-trigger"], [role="tab"], [data-slot="select-trigger"], [data-slot="combobox-trigger"], [data-slot="select-item"], [data-slot="combobox-item"], [data-slot="dropdown-menu-item"], [data-slot="dropdown-menu-checkbox-item"], [data-slot="dropdown-menu-radio-item"], [data-slot="dropdown-menu-sub-trigger"]');
  const targets = new Map();
  nodes.forEach(node => {
    // The overlaid Settle action must reveal its row, not repaint the sidebar.
    if (node.matches('[data-sidebar="menu-action"]')) return;
    const segmented = node.closest('[data-slot="tabs-list"]');
    if (segmented && !segmented.classList.contains('nat91-segmented-surface')) segmented.classList.add('nat91-segmented-surface');
    if (segmented?.getAttribute('aria-label') === 'Git views' && !segmented.parentElement.classList.contains('nat91-view-strip')) segmented.parentElement.classList.add('nat91-view-strip');
    const tabRail = node.closest('[role="tablist"]:not([data-slot="tabs-list"])');
    if (tabRail && !tabRail.classList.contains('nat91-tab-rail')) tabRail.classList.add('nat91-tab-rail');
    if (tabRail && !tabRail.parentElement.classList.contains('nat91-dock-strip')) tabRail.parentElement.classList.add('nat91-dock-strip');
    if (node.parentElement?.querySelector(':scope > strong') && node.closest('[data-slot="tabs-content"]') && !node.parentElement.classList.contains('nat91-action-strip')) node.parentElement.classList.add('nat91-action-strip');
    if ([...node.querySelectorAll(':scope > span')].some(span => span.textContent === '⤷') && !node.classList.contains('nat91-subagent-notice')) node.classList.add('nat91-subagent-notice');
    // Dock tabs include their close action in a single material region.
    const parent = node.parentElement;
    const target = node.getAttribute('role') === 'tab' && parent?.querySelectorAll('[role="tab"]').length === 1 && parent.querySelector('[data-slot="button"]') ? parent : node;
    if (target !== node && !target.classList.contains('nat91-tab-surface')) target.classList.add('nat91-tab-surface');
    const container = node.closest('.nat91-tab-surface');
    if (container && container !== target) return;
    targets.set(target, node);
  });
  surfaces = [];
  targets.forEach((node, target) => {
    // Closed details may still expose cached child rects (content-visibility).
    // Only their native summary is a visible surface until expanded.
    const closed = target.closest('details:not([open])');
    if (closed && !closed.querySelector(':scope > summary')?.contains(target)) return;
    const rect = target.getBoundingClientRect();
    const computed = getComputedStyle(target);
    if (!rect.width || !rect.height || computed.visibility === 'hidden' || Number(computed.opacity) === 0) return;
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) return;
    if (computed.position === 'static' && !target.classList.contains('nat91-control-static')) target.classList.add('nat91-control-static');
    if (!target.classList.contains('nat91-control')) target.classList.add('nat91-control');
    // A single GPU material atlas supplies local canvas layers. This respects each
    // control's stacking context without wrapping or replacing React's text nodes.
    let texture = target.querySelector(':scope > .nat91-control-texture');
    if (!texture) {
      texture = document.createElement('canvas');
      texture.className = 'nat91-control-texture';
      texture.setAttribute('aria-hidden', 'true');
      target.prepend(texture);
    }
    let gloss = target.querySelector(':scope > .nat91-gloss');
    if (!gloss) {
      gloss = document.createElement('span');
      gloss.className = 'nat91-gloss';
      gloss.setAttribute('aria-hidden', 'true');
      const spot = document.createElement('span');
      spot.className = 'nat91-gloss-spot';
      gloss.append(spot);
      texture.after(gloss);
    }
    const current = node.getAttribute('aria-current');
    const selected = node.getAttribute('aria-selected') === 'true' || (!!current && current !== 'false') || node.getAttribute('data-active') === 'true' || node.getAttribute('data-state') === 'active' || node.getAttribute('aria-pressed') === 'true' || (node.hasAttribute('data-selected') && node.getAttribute('data-selected') !== 'false') || node.getAttribute('data-state') === 'checked' || node.getAttribute('aria-checked') === 'true';
    if (target.dataset.nat91Selected !== String(selected)) target.dataset.nat91Selected = String(selected);
    const group = target.closest('[role="tablist"], .nat91-action-strip, [data-sidebar="menu"]');
    const rail = target.matches('[data-sidebar="menu-button"]');
    if (rail) {
      // Reuse the indicator's presentation mapping, including working and theme
      // changes, plus the preview's Dormant-grey override. One colour drives
      // both the solid edge and selected gradient; no separate animation palette.
      const dot = target.querySelector(':scope > span[aria-hidden].size-2.rounded-full');
      if (dot) {
        if (!dot.classList.contains('nat91-activity-dot')) dot.classList.add('nat91-activity-dot');
        const color = getComputedStyle(dot).color;
        if (target.style.getPropertyValue('--nat91-activity') !== color) target.style.setProperty('--nat91-activity', color);
        if (!target.hasAttribute('data-nat91-activity')) target.dataset.nat91Activity = 'true';
      }
    }
    const tab = node.matches('[role="tab"], [data-slot="tabs-trigger"]');
    // Native focus/highlight and checkmarks own dropdown selection, not the
    // reflected environment. Include triggers, popup items and nested controls.
    const dropdown = !!node.closest('[data-slot^="select-"], [data-slot^="combobox-"], [data-slot^="dropdown-menu-"]');
    surfaces.push({ node, target, rect, groupRect: group?.getBoundingClientRect() ?? rect, selected, rail, tab, dropdown, texture, gloss, radius: parseFloat(computed.borderTopLeftRadius) || 0, backdrop: backdropOf(target) });
  });
}
// Sidebar drawers live in body portals on narrow layouts. Their status changes
// need the same updates as desktop rows; draw() isolates all material-owned writes.
const observationRoot = document.body;
const observerOptions = { subtree: true, childList: true, attributes: true, characterData: true };
function cachedOwnerOf(node) {
  for (let owner = node; owner; owner = owner.parentElement) if (materialCache.has(owner)) return owner;
}
let domObserver;
function draw() {
  frame = undefined;
  const started = performance.now();
  domObserver?.disconnect();
  try {
    collect();
    const scale = Math.min(devicePixelRatio || 1, 1.5);
    const width = Math.round(innerWidth * scale), height = Math.round(innerHeight * scale);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(uniforms.uViewport, innerWidth, innerHeight);
    const dark = document.documentElement.classList.contains('dark');
    gl.uniform1f(uniforms.uLightTheme, dark ? 0 : 1);
    const theme = getComputedStyle(document.documentElement);
    const blue = theme.getPropertyValue('--trigger-command').trim(), purple = theme.getPropertyValue('--trigger-skill').trim();
    gl.uniform3f(uniforms.uBlue, ...rgbaOf(blue).slice(0, 3));
    gl.uniform3f(uniforms.uPurple, ...rgbaOf(purple).slice(0, 3));
    gl.enable(gl.SCISSOR_TEST);
    surfaces.forEach(({ node, target, rect, groupRect, selected, rail, tab, dropdown, backdrop, texture, radius }) => {
      const disabled = node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true';
      const chrome = selected && !rail && !tab && !dropdown && !disabled;
      if (target.dataset.nat91Chrome !== String(chrome)) target.dataset.nat91Chrome = String(chrome);
      const signature = JSON.stringify([scale, dark, blue, purple, rect.x, rect.y, rect.width, rect.height, groupRect.x, groupRect.y, groupRect.width, groupRect.height, selected, rail, tab, dropdown, backdrop, radius, disabled, target.textContent, getComputedStyle(target).font]);
      if (materialCache.get(target) === signature) return;
      materialCache.set(target, signature);
      const w = Math.max(1, Math.round(rect.width * scale)), h = Math.max(1, Math.round(rect.height * scale));
      if (texture.width !== w || texture.height !== h) { texture.width = w; texture.height = h; }
      const context = texture.getContext('2d');
      context.clearRect(0, 0, w, h);
      if (chrome) {
        gl.uniform2f(uniforms.uLight, rect.left + rect.width * .5, rect.top + rect.height * .5);
        gl.uniform3f(uniforms.uBackdrop, ...backdrop);
        gl.uniform4f(uniforms.uRect, rect.left, rect.top, rect.width, rect.height);
        gl.uniform4f(uniforms.uSurface, groupRect.left, groupRect.top, groupRect.width, groupRect.height);
        gl.uniform1f(uniforms.uSelected, 1);
        gl.uniform1f(uniforms.uRail, 0);
        gl.uniform1f(uniforms.uHover, 0);
        gl.uniform1f(uniforms.uDisabled, 0);
        gl.uniform1f(uniforms.uRadius, Math.min(radius, rect.width / 2, rect.height / 2));
        const x = Math.max(0, Math.floor(rect.left * scale)), y = Math.max(0, Math.floor((innerHeight - rect.bottom) * scale));
        gl.scissor(x, y, Math.max(0, Math.min(width, Math.ceil(rect.right * scale)) - x), Math.max(0, Math.min(height, Math.ceil((innerHeight - rect.top) * scale)) - y));
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        context.drawImage(canvas, rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale, 0, 0, w, h);
        stats.materialBuilds++;
        texture.dataset.revision = String(stats.materialBuilds);
        adaptiveInk(target, rect, texture);
      } else {
        for (const text of [target, ...target.querySelectorAll('.nat91-adaptive-ink, .nat91-adaptive-root')]) text.classList.remove('nat91-adaptive-ink', 'nat91-adaptive-root');
        target.querySelectorAll('[data-nat91-ink-icon]').forEach(icon => { icon.style.removeProperty('color'); delete icon.dataset.nat91InkIcon; });
      }
    });
    gl.disable(gl.SCISSOR_TEST);
    revision++;
    stats.draws = revision;
    canvas.dataset.revision = String(revision);
    canvas.dataset.surfaces = String(surfaces.length);
    document.body.dataset.materialReady = 'true';
  } finally {
    stats.lastDrawMs = performance.now() - started;
    domObserver?.observe(observationRoot, observerOptions);
  }
  scheduleGloss();
}
function schedule() { if (!frame) frame = requestAnimationFrame(draw); }
let glossFrame, hoveredTarget, activeGloss;
function scheduleGloss() { if (!glossFrame) glossFrame = requestAnimationFrame(moveGloss); }
function moveGloss() {
  glossFrame = undefined;
  const started = performance.now();
  const hoverRegion = hoveredTarget?.matches('[data-sidebar="menu-button"]') ? hoveredTarget.closest('[data-sidebar="menu-item"]') : hoveredTarget;
  const target = hoveredTarget?.isConnected && hoverRegion?.matches(':hover') ? hoveredTarget : null;
  const gloss = target?.querySelector(':scope > .nat91-gloss');
  if (activeGloss && activeGloss !== gloss) {
    activeGloss.style.opacity = '0';
    activeGloss.firstElementChild.style.willChange = 'auto';
  }
  activeGloss = gloss;
  if (gloss) {
    const rect = target.getBoundingClientRect();
    const disabled = target.matches(':disabled, [aria-disabled="true"]');
    const light = reduced.matches ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : pointer;
    const spot = gloss.firstElementChild;
    spot.style.willChange = 'transform';
    spot.style.transform = `translate3d(${Math.max(0, Math.min(rect.width, light.x - rect.left)) - rect.width / 2}px, ${Math.max(0, Math.min(rect.height, light.y - rect.top)) - rect.height / 2}px, 0)`;
    gloss.style.opacity = disabled ? '0' : target.dataset.nat91Selected === 'true' && !target.matches('[data-sidebar="menu-button"]') ? '.2' : '1';
  }
  stats.pointerFrames++;
  stats.lastPointerMs = performance.now() - started;
}
window.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch') return;
  if (!reduced.matches) pointer = { x: event.clientX, y: event.clientY };
  const hit = event.target instanceof Element ? event.target : null;
  const action = hit?.closest('[data-sidebar="menu-action"]');
  hoveredTarget = action ? action.closest('[data-sidebar="menu-item"]')?.querySelector('[data-sidebar="menu-button"]') : hit?.closest('.nat91-control');
  // Pointer frames perform one local rect read and compositor transform only.
  // No collection, underlay sampling, GPU copy, pixel loop or PNG encoding.
  scheduleGloss();
});
document.documentElement.addEventListener('pointerleave', () => { hoveredTarget = null; scheduleGloss(); });
function invalidateMaterials() { surfaces.forEach(({ target }) => materialCache.delete(target)); schedule(); }
document.fonts.addEventListener('loadingdone', invalidateMaterials);
window.addEventListener('resize', schedule);
document.fonts.ready.then(schedule);
document.addEventListener('scroll', schedule, true);
document.addEventListener('focusin', schedule);
document.addEventListener('focusout', schedule);
reduced.addEventListener('change', () => { pointer = { x: innerWidth * .56, y: innerHeight * .3 }; scheduleGloss(); });
domObserver = new MutationObserver(records => {
  const meaningful = records.filter(record => record.target !== canvas && record.target !== note && !record.target.closest?.('.nat91-gloss') && !['data-highlighted', 'aria-activedescendant'].includes(record.attributeName) && (record.type !== 'characterData' || cachedOwnerOf(record.target) || record.target.parentElement?.closest('.nat91-session-band summary')));
  // A native re-render can replace a label/canvas or reset its classes while
  // leaving the outer rect/text unchanged. Invalidate only that control; ARIA
  // and selection changes are already covered by the material signature.
  for (const record of meaningful) {
    if (record.type === 'attributes' && !['class', 'style'].includes(record.attributeName)) continue;
    const owner = cachedOwnerOf(record.target);
    if (owner) materialCache.delete(owner);
  }
  if (meaningful.length) schedule();
});
domObserver.observe(observationRoot, observerOptions);
new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
window.nat91Material = { canvas, redraw: invalidateMaterials, getLight: () => ({ ...pointer }), getStats: () => ({ ...stats }) };
schedule();
