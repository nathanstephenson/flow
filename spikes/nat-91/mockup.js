// A bounded SVG surface rather than a rainbow gradient: broad coloured reflections,
// near-black troughs, and narrow silver folds. Static until the pointer moves.
const studies = {
  cobalt: {
    title: '01 — Cobalt chrome',
    description: 'Deep blue reflections. Silver at the edges. A quiet workspace, with unmistakable selection.',
    note: 'A blue-black base, a folded silver edge, and a broad cobalt reflection. The most restrained of the three studies.',
    base: ['#070b16', '#071c55', '#163fa2', '#08205e', '#050a16'],
    fold: ['#122b60', '#647d9e', '#ecf2ff', '#8598b8', '#030916', '#1853c9'],
    path: 'M-20 77 C70 106 94 34 191 48 S280 74 354 30 S440 -4 520 27 L520 50 C439 18 412 30 359 50 S269 90 188 63 S70 119 -20 94Z',
    sheen: .65,
  },
  silver: {
    title: '02 — Silver chrome',
    description: 'A silver-forward surface with cobalt reflections. Sharper, more machined, more luminous.',
    note: 'The same geometry with a brighter silver fold and a wider graphite reflection. A more literal metallic treatment.',
    base: ['#101722', '#59677e', '#c0cbdc', '#304d87', '#070d1c'],
    fold: ['#122345', '#ced9ee', '#ffffff', '#8a9cb9', '#030916', '#1a56b5'],
    path: 'M-20 65 C56 115 126 9 204 33 S309 91 373 36 S446 11 520 17 L520 38 C443 28 431 37 377 56 S280 82 203 50 S47 132 -20 82Z',
    sheen: .9,
  },
  liquid: {
    title: '03 — Liquid chrome',
    description: 'Saturated cobalt and fluid silver folds. The closest to the references—and the boldest treatment.',
    note: 'More sculptural and saturated: a larger cobalt reflection and a second silver fold. The highest material presence, without chrome on the transcript.',
    base: ['#010617', '#082675', '#164ed8', '#0c32a6', '#020713'],
    fold: ['#091634', '#96b1df', '#ffffff', '#a9b9cc', '#030610', '#1c61fa'],
    path: 'M-20 50 C60 120 129 -10 215 43 S328 77 379 29 S455 65 520 14 L520 43 C435 92 436 39 386 48 S279 108 212 63 S52 146 -20 74Z',
    sheen: .95,
  },
};

function material(study, id) {
  const baseStops = study.base.map((color, i) => `<stop offset="${i * 25}%" stop-color="${color}"/>`).join('');
  const offsets = [0, 30, 44, 49, 57, 100];
  const foldStops = study.fold.map((color, i) => `<stop offset="${offsets[i]}%" stop-color="${color}"/>`).join('');
  return `<svg viewBox="0 0 500 120" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="base-${id}" x1="0" y1="0" x2=".8" y2="1">${baseStops}</linearGradient>
      <linearGradient id="fold-${id}" x1="0" y1="0" x2=".2" y2="1">${foldStops}</linearGradient>
      <radialGradient id="glint-${id}" cx=".86" cy="0" r=".7" gradientTransform="translate(0 .04) scale(1 .24)"><stop stop-color="#fff" stop-opacity="${study.sheen}"/><stop offset=".15" stop-color="#bdd2ff" stop-opacity=".2"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <linearGradient id="shade-${id}"><stop stop-color="#030a19" stop-opacity=".72"/><stop offset=".55" stop-color="#030a19" stop-opacity=".48"/><stop offset="1" stop-color="#030a19" stop-opacity="0"/></linearGradient>
    </defs>
    <path fill="url(#base-${id})" d="M0 0H500V120H0Z"/>
    <path fill="url(#fold-${id})" opacity="${study.sheen}" d="${study.path}"/>
    ${document.body.dataset.treatment === 'liquid' ? `<path fill="url(#fold-${id})" opacity=".4" d="M270 120C330 35 374 130 429 80S483 37 520 70L520 83C457 33 443 130 391 112S321 81 296 120Z"/>` : ''}
    <path fill="url(#glint-${id})" d="M0 0H500V120H0Z"/>
    <path fill="url(#shade-${id})" d="M0 0H500V120H0Z"/>
    <path fill="#e1ebff" fill-opacity=".35" d="M0 0H500V.8H0Z"/>
  </svg>`;
}

function setTreatment(name) {
  if (!studies[name]) name = 'cobalt';
  const study = studies[name];
  document.body.dataset.treatment = name;
  document.querySelector('#study-title').textContent = study.title;
  document.querySelector('#study-description').textContent = study.description;
  document.querySelector('#material-name').textContent = study.title.toUpperCase();
  document.querySelector('#material-note').textContent = study.note;
  document.querySelectorAll('nav [data-treatment]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.treatment === name)));
  document.querySelectorAll('.material').forEach((surface, index) => { surface.innerHTML = material(study, index); });
  const url = new URL(location.href);
  url.searchParams.set('treatment', name);
  history.replaceState(null, '', url);
}

document.querySelectorAll('nav [data-treatment]').forEach(button => button.addEventListener('click', () => setTreatment(button.dataset.treatment)));
const themeButton = document.querySelector('#theme-toggle');
function setTheme(light) {
  document.body.classList.toggle('light', light);
  themeButton.setAttribute('aria-pressed', String(light));
  themeButton.textContent = light ? 'Dark' : 'Light';
  const url = new URL(location.href);
  if (light) url.searchParams.set('theme', 'light'); else url.searchParams.delete('theme');
  history.replaceState(null, '', url);
}
themeButton.addEventListener('click', () => setTheme(!document.body.classList.contains('light')));

// Only decoration is interactive. All app-shaped actions use synthetic fixtures and do nothing.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
document.querySelectorAll('.reflective').forEach(button => {
  button.addEventListener('pointermove', event => {
    if (reducedMotion.matches || event.pointerType === 'touch') return;
    const rect = button.getBoundingClientRect();
    button.style.setProperty('--light-x', `${event.clientX - rect.left}px`);
    button.style.setProperty('--light-y', `${event.clientY - rect.top}px`);
  });
  button.addEventListener('pointerleave', () => {
    button.style.removeProperty('--light-x');
    button.style.removeProperty('--light-y');
  });
});
reducedMotion.addEventListener('change', () => document.querySelectorAll('.reflective').forEach(button => {
  button.style.removeProperty('--light-x');
  button.style.removeProperty('--light-y');
}));
const params = new URLSearchParams(location.search);
setTreatment(params.get('treatment') ?? 'cobalt');
setTheme(params.get('theme') === 'light');
if (params.get('view') === 'detail') document.body.dataset.view = 'detail';
