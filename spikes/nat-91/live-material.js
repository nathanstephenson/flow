// Dev-only material study on the real Flow DOM. One shared light and grain scale;
// no image assets, no painted wave paths, and no production component changes.
const style = document.createElement('style');
style.textContent = `
  .nat91-control { isolation: isolate !important; border-radius: 3px !important; background: transparent !important; color: var(--foreground) !important; }
  .nat91-control-static { position: relative; }
  .nat91-control { border-color: transparent !important; }
  .nat91-control:focus-visible, .nat91-tab-surface:has(> [role="tab"]:focus-visible) { outline: 2px solid var(--ring); outline-offset: -2px; }
  .nat91-tab-surface > [role="tab"] { background: transparent !important; }
  .nat91-control[data-nat91-selected="true"] .text-muted-foreground { color: var(--foreground) !important; }
  .dark .nat91-control[data-nat91-selected="true"], .dark .nat91-tab-surface[data-nat91-selected="true"] > [role="tab"] { color: #edf2ff !important; }
  .dark .nat91-control[data-nat91-selected="true"] .text-muted-foreground { color: #d4e1f4 !important; }
  .dark .nat91-control[data-nat91-selected="true"] .bg-foreground { background-color: #edf2ff !important; }
  .nat91-control-texture { position: absolute; inset: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; border-radius: inherit; }
  .nat91-control:active { transform: none !important; translate: none !important; }
  [data-sidebar="menu-button"].nat91-control { border-radius: 0 !important; }
  [data-sidebar="header"] { padding: 0 !important; }
  [data-sidebar="header"] [data-slot="button"] { border-radius: 0 !important; min-height: 42px; padding-inline: 12px; }
  .nat91-tab-surface { border-radius: 0 !important; background: transparent !important; align-self: stretch; }
  .nat91-tab-rail { align-self: stretch; align-items: stretch !important; gap: 0 !important; min-height: 34px; }
  .nat91-tab-surface { padding-inline: 8px !important; gap: 2px !important; }
  .nat91-tab-surface > [role="tab"] { align-self: stretch; padding-inline: 4px; }
  .nat91-tab-surface > button:not([role="tab"]) { background: transparent !important; }
  .nat91-segmented-surface { width: 100% !important; padding: 0 !important; gap: 0 !important; border-radius: 0 !important; background: transparent !important; }
  .nat91-segmented-surface > [data-slot="tabs-trigger"] { flex: 1; height: 34px; box-shadow: none !important; }
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
note.textContent = 'DEV STUDY · shared brushed material / pointer-driven light';
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
  uniform vec2 uLight;
  uniform float uSelected;
  uniform float uHover;
  uniform float uLightTheme;
  uniform float uRadius;
  uniform float uDisabled;
  uniform vec3 uBackdrop;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec2 halfSize = uRect.zw * .5;
    vec2 q = abs((vUv - .5) * uRect.zw) - halfSize + uRadius;
    float shape = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
    if (shape > 0.0) discard;
    // Fine, elongated micro-scratches in page-space CSS pixels, not whole-row bands.
    float brushX = vPage.x / 24.0;
    float brushY = floor(vPage.y * 1.7);
    float line = mix(hash(vec2(floor(brushX), brushY)), hash(vec2(floor(brushX) + 1.0, brushY)), smoothstep(0.0, 1.0, fract(brushX)));
    float grain = (line - .5) * .028 + (hash(floor(vPage * 2.0)) - .5) * .006;
    // A shallow face produces directional reflections, not a blurred perimeter glow.
    vec3 normal = normalize(vec3(0.0, (vUv.y - .5) * .24 + (line - .5) * .032, 1.0));
    // The same area light follows the cursor across the whole UI. Only controls reflect it.
    vec2 toLight = (uLight - vPage) / vec2(300.0, 180.0);
    vec3 L = normalize(vec3(toLight, 1.15));
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float broad = exp(-dot(toLight / vec2(1.6, 1.2), toLight / vec2(1.6, 1.2)));
    // Anisotropic silver highlight: long along the grain, narrower across it.
    vec2 anisotropy = (H.xy - normal.xy) / vec2(.42, .12);
    float silver = exp(-dot(anisotropy, anisotropy));
    float tight = pow(max(dot(normal, H), 0.0), 100.0);
    vec3 steel = mix(vec3(.14, .16, .19), vec3(.77, .80, .85), uLightTheme);
    vec3 base = mix(uBackdrop, steel, .18);
    // Millimetre-like edge rolloff, not the previous 12px airbrushed halo.
    float face = smoothstep(0.0, 1.5, -shape);
    float fadeStart = mix(.32, .64, 1.0 - smoothstep(130.0, 240.0, uRect.z));
    float fadeRight = 1.0 - smoothstep(fadeStart, .99, vUv.x);
    float coverage = fadeRight * face;
    // Broad directional studio reflection: cobalt in shadow, steel-blue in the light.
    // It spans the control face; there is no cyan seam or local Gaussian light blob.
    float studio = smoothstep(.10, .38, vUv.y) - smoothstep(.40, .89, vUv.y);
    float reflectionY = .28 + clamp((uLight.y - (uRect.y + uRect.w * .5)) / 1200.0, -.08, .08);
    float polished = smoothstep(reflectionY - .018, reflectionY, vUv.y)
      * (1.0 - smoothstep(reflectionY + .014, reflectionY + .11, vUv.y));
    polished *= (.65 + broad * .35) * (.78 + line * .34);
    vec3 cobalt = vec3(.025, .085, .22) + vec3(.035, .13, .32) * studio;
    vec3 activeDark = base + cobalt + vec3(.11, .15, .19) * silver + vec3(.18, .20, .24) * polished;
    vec3 activeLight = mix(vec3(.62, .76, .90), vec3(.43, .66, .91), studio) + vec3(.045) * polished;
    vec3 active = mix(activeDark, activeLight, uLightTheme);
    vec3 color = mix(base, active, coverage * uSelected);
    float sheen = silver * uHover * .20 * face;
    color += mix(vec3(.20, .24, .30), vec3(.035), uLightTheme) * sheen;
    color += vec3(.04, .06, .09) * tight * uSelected * coverage;
    color += vec3(grain * (.55 + coverage * uSelected * 1.3 + uHover * .30)) * face;
    // Cap the dark-theme silver catch so it doesn't wash out the labels crossing it.
    color = min(color, mix(vec3(.32, .42, .76), vec3(1.0), uLightTheme));
    color = mix(color, base, uDisabled * .85);
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
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
const uniforms = Object.fromEntries(['uViewport', 'uRect', 'uLight', 'uSelected', 'uHover', 'uLightTheme', 'uRadius', 'uDisabled', 'uBackdrop'].map(name => [name, gl.getUniformLocation(program, name)]));
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let pointer = { x: innerWidth * .56, y: innerHeight * .3 };
let surfaces = [];
let frame;
let revision = 0;
const swatch = document.createElement('canvas');
swatch.width = swatch.height = 1;
const sampler = swatch.getContext('2d', { willReadFrequently: true });
const colorCache = new Map();
function backdropOf(target, rect) {
  // Absolute controls can sit over a sibling region (the mobile rail trigger sits
  // over the header, but belongs to main). Sample the visual underlay, not just
  // the DOM parent, so their material doesn't turn into a mismatched dark square.
  const underlay = document.elementsFromPoint(rect.left + rect.width * .5, rect.top + rect.height * .5)
    .find(element => element instanceof HTMLElement && !target.contains(element) && !element.closest('.nat91-control'));
  const layers = [];
  for (let parent = underlay ?? target.parentElement; parent; parent = parent.parentElement) {
    const css = getComputedStyle(parent).backgroundColor;
    let rgba = colorCache.get(css);
    if (!rgba) {
      sampler.clearRect(0, 0, 1, 1);
      sampler.fillStyle = css;
      sampler.fillRect(0, 0, 1, 1);
      rgba = [...sampler.getImageData(0, 0, 1, 1).data].map(channel => channel / 255);
      colorCache.set(css, rgba);
    }
    if (rgba[3]) layers.push(rgba);
    if (rgba[3] === 1) break;
  }
  let color = document.documentElement.classList.contains('dark') ? [.035, .035, .035] : [1, 1, 1];
  for (const rgba of layers.reverse()) color = color.map((value, index) => value * (1 - rgba[3]) + rgba[index] * rgba[3]);
  return color;
}

function collect() {
  const nodes = document.querySelectorAll('#root button, [data-sidebar="menu-button"], [data-sidebar="menu-action"], [data-slot="tabs-trigger"], [role="tab"], [data-slot="select-trigger"], [data-slot="combobox-trigger"]');
  const targets = new Map();
  nodes.forEach(node => {
    const segmented = node.closest('[data-slot="tabs-list"]');
    if (segmented && !segmented.classList.contains('nat91-segmented-surface')) segmented.classList.add('nat91-segmented-surface');
    const tabRail = node.closest('[role="tablist"]:not([data-slot="tabs-list"])');
    if (tabRail && !tabRail.classList.contains('nat91-tab-rail')) tabRail.classList.add('nat91-tab-rail');
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
    const rect = target.getBoundingClientRect();
    const computed = getComputedStyle(target);
    if (!rect.width || !rect.height || computed.visibility === 'hidden' || Number(computed.opacity) === 0) return;
    if (rect.bottom < 0 || rect.top > innerHeight) return;
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
    const selected = node.getAttribute('aria-selected') === 'true' || node.hasAttribute('aria-current') || node.getAttribute('data-active') === 'true' || node.getAttribute('data-state') === 'active' || node.getAttribute('aria-pressed') === 'true';
    if (target.dataset.nat91Selected !== String(selected)) target.dataset.nat91Selected = String(selected);
    surfaces.push({ node, target, rect, selected, texture, backdrop: backdropOf(target, rect) });
  });
}
function draw() {
  frame = undefined;
  collect();
  const scale = Math.min(devicePixelRatio || 1, 1.5);
  const width = Math.round(innerWidth * scale), height = Math.round(innerHeight * scale);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform2f(uniforms.uViewport, innerWidth, innerHeight);
  gl.uniform2f(uniforms.uLight, pointer.x, pointer.y);
  gl.uniform1f(uniforms.uLightTheme, document.documentElement.classList.contains('dark') ? 0 : 1);
  surfaces.forEach(({ node, target, rect, selected, backdrop }) => {
    gl.uniform3f(uniforms.uBackdrop, ...backdrop);
    gl.uniform4f(uniforms.uRect, rect.left, rect.top, rect.width, rect.height);
    gl.uniform1f(uniforms.uSelected, selected ? 1 : 0);
    gl.uniform1f(uniforms.uHover, target.matches(':hover') || target.contains(document.activeElement) ? 1 : 0);
    gl.uniform1f(uniforms.uDisabled, node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true' ? 1 : 0);
    gl.uniform1f(uniforms.uRadius, target.matches('[data-sidebar="menu-button"], .nat91-tab-surface') ? 0 : 3);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  });
  surfaces.forEach(({ rect, texture }) => {
    const w = Math.max(1, Math.round(rect.width * scale)), h = Math.max(1, Math.round(rect.height * scale));
    if (texture.width !== w || texture.height !== h) { texture.width = w; texture.height = h; }
    const context = texture.getContext('2d');
    context.clearRect(0, 0, w, h);
    context.drawImage(canvas, rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale, 0, 0, w, h);
  });
  revision++;
  canvas.dataset.revision = String(revision);
  canvas.dataset.surfaces = String(surfaces.length);
  document.body.dataset.materialReady = 'true';
}
function schedule() { if (!frame) frame = requestAnimationFrame(draw); }
window.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch' || reduced.matches) return;
  pointer = { x: event.clientX, y: event.clientY };
  schedule();
});
window.addEventListener('resize', schedule);
document.addEventListener('scroll', schedule, true);
document.addEventListener('focusin', schedule);
document.addEventListener('focusout', schedule);
document.addEventListener('pointerdown', schedule);
document.addEventListener('pointerup', schedule);
reduced.addEventListener('change', () => { pointer = { x: innerWidth * .56, y: innerHeight * .3 }; schedule(); });
new MutationObserver(records => {
  if (records.some(record => record.target !== canvas && record.target !== note)) schedule();
}).observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true });
new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
window.nat91Material = { canvas, redraw: schedule, getLight: () => ({ ...pointer }) };
schedule();
