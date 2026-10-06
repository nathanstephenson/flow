// Reflect a simple studio environment off a gently formed metal surface.
// There are no decorative SVG paths: highlights are reflected rectangular light
// sources, with anisotropic softness and fine horizontal brushing in the finish.
const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const fract = x => x - Math.floor(x);
const noise = (x, y) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453123);
function rectangle(x, y, left, right, bottom, top, softness) {
  return smooth(left - softness, left + softness, x) * (1 - smooth(right - softness, right + softness, x))
    * smooth(bottom - softness, bottom + softness, y) * (1 - smooth(top - softness, top + softness, y));
}
function mix(a, b, t) { return [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t]; }

function environment(rx, ry, rz, px, py, kind, light) {
  const lowKey = kind === 'graphite';
  const blue = kind === 'cobalt';
  // Studio floor/ceiling, seen at grazing angles around the bevel.
  let color = mix([.025, .03, .042], [.52, .55, .61], smooth(-.2, .9, ry));
  if (ry < -.18) {
    const floor = blue ? [.018, .07, .55] : lowKey ? [.06, .08, .12] : [.28, .32, .39];
    color = mix(color, floor, smooth(.18, .9, -ry));
  }
  if (rz <= .02) return color;
  // Ray/plane intersection with fixtures behind the viewer, at z = 4.
  const x = px + 4 * rx / rz;
  const y = py + 4 * ry / rz;
  color = lowKey ? [.025, .033, .048] : [.11, .13, .17];
  // A large reflected panel. Cobalt is the environment, not the metal's pigment.
  const panelLight = .22 + .78 * smooth(-5.5, .5, y);
  const panel = blue ? [.008 * panelLight, .05 * panelLight, .72 * panelLight]
    : lowKey ? [.07 * panelLight, .085 * panelLight, .12 * panelLight]
    : [.4 * panelLight, .44 * panelLight, .5 * panelLight];
  color = mix(color, panel, rectangle(x, y, -30, 30, -8, .35, .14));
  // Broad silver reflection, with a dark partition cutting through it.
  color = mix(color, lowKey ? [.36, .39, .46] : [.79, .83, .9], rectangle(x, y, -30, 30, .4 + light, 3.1 + light, .13));
  color = mix(color, [.008, .011, .017], rectangle(x, y, -30, 30, 1.12 + light, 1.42 + light, .05));
  // Concentrated strip lights: narrow white highlights, not broad white paint.
  color = mix(color, [.99, .99, 1], rectangle(x, y, -30, 30, 2.12 + light, 2.2 + light, .032));
  color = mix(color, [.94, .97, 1], rectangle(x, y, 3.1 + light, 3.16 + light, -4, 5.8, .065));
  // Black flag and another small softbox create discontinuities in the reflection.
  color = mix(color, [.012, .018, .03], rectangle(x, y, 4.1, 6.2, -.6, 2.1, .16));
  color = mix(color, [.87, .92, 1], rectangle(x, y, 4.4, 5.7, 2.4, 5.4, .07));
  return color;
}

function render(canvas, kind, light = 0, control = false) {
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * scale);
  const height = Math.round(rect.height * scale);
  if (!width || !height) return;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  for (let row = 0; row < height; row++) {
    const v = row / Math.max(1, height - 1);
    const py = (.5 - v) * 1.3;
    const brush = (noise(0, row * .61) - .5) * .045;
    for (let col = 0; col < width; col++) {
      const u = col / Math.max(1, width - 1);
      const px = (u - .5) * 4.8;
      // A nearly flat face with a shallow crown and a narrow formed edge.
      // Slight twist breaks up reflections without inventing ribbons on the face.
      const edgeX = smooth(.97, 1, Math.abs(u * 2 - 1));
      const edgeY = smooth(.93, 1, Math.abs(v * 2 - 1));
      let nx = .1 * px + .07 * py + edgeX * Math.sign(px) * .18;
      let ny = -.09 + .75 * py + .043 * px + edgeY * Math.sign(py) * .22;
      const length = Math.hypot(nx, ny, 1);
      nx /= length; ny /= length;
      const nz = 1 / length;
      const rx = 2 * nz * nx;
      const ry = 2 * nz * ny;
      const rz = 2 * nz * nz - 1;
      // Two anisotropic samples soften reflection edges along the brushing.
      const a = environment(rx - .006, ry - .003, rz, px, py, kind, light);
      const b = environment(rx + .006, ry + .003, rz, px, py, kind, light);
      const color = mix(a, b, .5);
      // Micro-scratches stay horizontal and much finer than the reflected fixtures.
      const striation = brush * (.75 + .25 * Math.sin(u * 8 + row * .03));
      const micro = (noise(col, row) - .5) * .009;
      const scratch = noise(1, row) > .976 ? -.028 * Math.pow(Math.sin(u * 5 + row), 2) : 0;
      const exposure = control ? .84 : 1;
      const i = (row * width + col) * 4;
      for (let channel = 0; channel < 3; channel++) {
        // Reflected radiance plus brushed-metal grain; keep near-black troughs.
        const linear = clamp(color[channel] * exposure + striation + micro + scratch);
        image.data[i + channel] = Math.round(255 * Math.pow(linear, .65));
      }
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

const params = new URLSearchParams(location.search);
if (params.get('material') && ['silver', 'cobalt', 'graphite'].includes(params.get('material'))) {
  document.body.dataset.view = 'single';
  document.querySelectorAll('.study').forEach(study => { study.hidden = study.dataset.material !== params.get('material'); });
  // `display:grid` must not override the HTML hidden state.
  document.querySelectorAll('.study[hidden]').forEach(study => { study.style.display = 'none'; });
}
const themeButton = document.querySelector('#theme-toggle');
function setTheme(light) {
  document.body.classList.toggle('light', light);
  themeButton.setAttribute('aria-pressed', String(light));
  themeButton.textContent = light ? 'Dark backdrop' : 'Light backdrop';
  const url = new URL(location.href);
  if (light) url.searchParams.set('theme', 'light'); else url.searchParams.delete('theme');
  history.replaceState(null, '', url);
}
themeButton.addEventListener('click', () => setTheme(!document.body.classList.contains('light')));
setTheme(params.get('theme') === 'light');

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let resizeTimer;
function renderAll() {
  document.querySelectorAll('.study:not([hidden])').forEach(study => {
    const kind = study.dataset.material;
    render(study.querySelector('.swatch'), kind);
    study.querySelectorAll('button canvas').forEach(canvas => render(canvas, kind, 0, true));
  });
  document.body.dataset.rendered = 'true';
}
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderAll, 100);
});
document.querySelectorAll('.hover-control').forEach(button => {
  let frame;
  button.addEventListener('pointermove', event => {
    if (reducedMotion.matches || event.pointerType === 'touch') return;
    const rect = button.getBoundingClientRect();
    const light = ((event.clientX - rect.left) / rect.width - .5) * .85;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      render(button.querySelector('canvas'), button.closest('.study').dataset.material, light, true);
      button.dataset.light = String(light);
    });
  });
  const reset = () => {
    cancelAnimationFrame(frame);
    delete button.dataset.light;
    render(button.querySelector('canvas'), button.closest('.study').dataset.material, 0, true);
  };
  button.addEventListener('pointerleave', reset);
  reducedMotion.addEventListener('change', reset);
});
await document.fonts.ready;
renderAll();
