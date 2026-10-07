# NAT-91 — promoted to the production web client

The interactive prototype from PR #71 has been replaced by native production components.
Normal `npm run dev`, `npm run build:web`, and packaged builds now include the treatment;
there is no preview-only Vite plugin, DOM-discovery observer, WebGL requirement, or adaptive text mask.

- Richer blue/violet activity and composer accents replace the pastels through more pigment
  and lower lightness, not luminous or neon colours. Diff additions use a deeper green.
  Light/dark values retain readable small-text contrast, including tinted faces.
- Agent Session rows use that shared status palette for full-height edges and the selected
  row's slow rightward tint. Dark working/awaiting tints carry more pigment while neutral
  Lifecycles keep their quieter surface. Dormant is muted grey, distinct from Idle. Selection does not
  recolour the status edge or text. Reduced motion keeps selection static; forced colours
  exposes status words rather than relying on colour.
- Ordinary Band headings no longer take visible space. Ordering, attention, accessible
  list names and the renamed Settled disclosure retain their native behavior. When Ended
  rows are present, the disclosure explicitly names both Lifecycles.
- Shared controls use a lightweight cursor-local CSS gloss over their native fills and ink,
  including portalled dropdown options. Settle stays transparent; accordion/disclosure
  headers stay flat. Focus rings and keyboard handling remain native.
- Dock/view/mode tabs and dedicated rail actions fill their strips. Only the selected
  Chat/Workflow tab has the muted fill. Narrow Subagent descriptions sit below their titles.

The rejected blue/silver ribbon backgrounds and experimental material/adaptive-ink renderer
are not shipped. The latest prototype explicitly removed those from tabs, dropdowns and the
rail; production uses the final native-fill/gloss treatment rather than reviving rejected rounds.
Original design references and old screenshot URLs remain in PR history.

## Verify the actual built client

```sh
npm run typecheck
npm run build:web
node --test --experimental-strip-types web/src/lib/cursor-gloss.test.ts

# In a separate terminal; use a fresh isolated temporary directory.
FLOW_VISUAL_STATE_DIR=/tmp/flow-visual-check node --experimental-strip-types scripts/visual-fixture-host.ts

# Uses the host's normal production web/dist, not a preview script.
FLOW_STATE_DIR=/tmp/flow-visual-check SCREENSHOT_DIR=/tmp/flow-visual-captures \
  node scripts/check-visual-alignment.mjs
```

Use `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` to point the check at existing Playwright/Chromium
installations when they are not in the default location; do not install browser binaries.

The fixture host uses FakeBackend, temporary repositories with no remote, and its own token.
It never restarts the operator's Session Host or copies operator credentials. The browser
suite blocks mutating requests and does not create Agent Sessions, save Settings, execute
MCP commands, publish Git changes or submit logout. Browser-local discovery fixtures exercise
native menus and Git views without adding services to the host. Captures stay outside the
source tree, including dedicated working/awaiting accent screenshots in both themes.
