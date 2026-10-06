# NAT-91 — interactive material study on the real UI

Round six resets the **actual Flow React UI under Vite** against both original user references: saturated reflected colour, near-black troughs, and bright silver catches, rather than capped blue glow. Those references are mirror chrome; fine brushing is an additional requirement, not a claimed property of the artwork. This remains a visual WIP, not an approved chrome treatment. The bright catches can still read as graphic streaks, and brushing is too faint at normal size. Production UI files are unchanged. Earlier standalone sources remain as history, but are not served by this preview. The original user artwork is not committed or published.

**Latest feedback adjustment:** each Agent Session's activity dot is replaced visually by a solid left-edge line in exactly that indicator's colour. Only the selected Agent Session gets a gently flowing gradient in the same hue; inactive rows keep their flat native sidebar fill. The gradient is static under reduced motion. Status colours still come from the real indicator, including background work and theme changes; existing accessible status words are retained. The rail's material canvas stays transparent; cursor-local gloss is a separate lightweight CSS compositor layer, without covering the gradient. Settle actions have no material canvas and remain transparent on hover; native keyboard focus rings are retained. Dropdown options in body portals now receive the same selection/hover treatment as other controls. Native trigger, popup, and item radii/fills are preserved rather than forcing a 3px radius on triggers. Other chrome treatment is still WIP.

## Run

From the checkout, with dependencies installed, start these in separate terminals:

```sh
# Use a fresh directory for each fixture host.
MOCKUP_STATE_DIR=/tmp/nat91-preview-1 node --experimental-strip-types spikes/nat-91/dev-host.ts
MOCKUP_STATE_DIR=/tmp/nat91-preview-1 node spikes/nat-91/preview.mjs
```

Open **http://127.0.0.1:5191/study**. The loopback-only handoff authenticates against the isolated host and opens the seeded Agent Session. The host is on port 4392. Override these with `MOCKUP_PORT` and `MOCKUP_HOST_PORT`.

- **Real controls:** session navigation, tabs, menus, composer, and Settings use the existing components and handlers.
- **Simulated model activity:** `FakeBackend` seeds input-needed, working, idle, and completed Subagent states. New model prompts stay in flight until aborted; there is no live model connection or automatic response.
- **Isolated state and repositories:** fixtures live beneath `MOCKUP_STATE_DIR`. They have no remote, so GitHub and update services are intentionally unavailable. No real Session Host is restarted or used, and no operator credentials are copied.
- **Shared material:** one procedural WebGL renderer, page-coordinate fine brushing, and a shared reflected environment. Surface normals follow control/rail geometry; there is no per-control left-to-right fade mask. Reflected blue/purple shades derive from the app's `--trigger-command` and `--trigger-skill` tokens. Selected material surfaces are cached and copied immediately after their draw to avoid overlap contamination. Inactive canvases are transparent, leaving the native control fill intact. Backdrop colours come from the control's DOM ancestors, never from an overlapping popup or full-screen portal backdrop.
- **Readable type:** outside the quiet Agent Session rail, the actual chrome material drives a black/white foreground map clipped to existing DOM text. The rail keeps ordinary theme foregrounds and muted metadata. Reflections remain continuous—no dark label-shaped patches. Direct-text buttons need a visual-only pseudo-element with empty accessibility alternative text; exact accessible tab names are checked. Monochrome icons sample the material at their centres. This is a mockup technique, **not a completed production accessibility/performance solution**; icon-centre sampling needs particular scrutiny.
- **Integrated regions:** dock tabs share available rail width, Git's view strip reaches the panel edges, and Git actions form a connected strip. Narrow Subagent notices put descriptions on a second line so task names do not break mid-word; long descriptions still truncate.
- **Restrained interaction:** chrome reflections remain stable; only the hovered control's subdued CSS gloss follows the cursor. Pointer frames update a local compositor transform only—no whole-page discovery, GPU copies, image readbacks, pixel loops, or PNG encoding. Cached chrome/type maps rebuild for structural, text, geometry, or theme changes. The rail's selected-only status tint flows on a slow CSS animation, without triggering GPU-material redraws. Unselected Agent Sessions never get that animation. Reduced motion stops the flow and fixes the gloss position; keyboard focus retains a distinct outline.

The preview-only Vite plugin injects `live-material.js`; the normal build never includes it. Edit that file while the preview runs to iterate.

### Frontend only, against an existing backend

When explicitly testing live Sessions instead of fixtures:

```sh
MOCKUP_STATE_DIR="${FLOW_STATE_DIR:-$HOME/.flow}" MOCKUP_LIVE_BACKEND=1 \
  MOCKUP_BIND_HOST=0.0.0.0 MOCKUP_PORT=3069 \
  MOCKUP_ALLOWED_HOSTS=testing.nathanstephenson.dev node spikes/nat-91/preview.mjs
```

This starts only Vite and proxies to the existing `daemon.json` URL. Use a backend built from the same revision; an older running host may lack the current transcript API. A backend configured with OIDC may redirect to its registered public address; this preview does not alter that auth configuration. Prefer fixture mode above for portable local testing. It does not start/restart a Session Host, seed Sessions, install fixture layouts, or offer the token-bearing `/study` handoff. Open `/` using the backend's normal authentication. **Actions now target the live backend**, not `FakeBackend`. The default binding remains loopback unless `MOCKUP_BIND_HOST` is explicitly set. `MOCKUP_ALLOWED_HOSTS` accepts a comma-separated list of exact hostnames for reverse proxies; Vite's hostname protection is not disabled.

**Docker:** `MOCKUP_PORT` is the container port. For a published mapping such as host `3001` → container `3000`, set `MOCKUP_PORT=3000` and `MOCKUP_BIND_HOST=0.0.0.0` on the preview command, then visit `http://localhost:3001` on the host.

## Capture and checks

With both processes running:

```sh
MOCKUP_STATE_DIR=/tmp/nat91-preview-1 node spikes/nat-91/capture.mjs
MOCKUP_STATE_DIR=/tmp/nat91-preview-1 node spikes/nat-91/capture-dropdowns.mjs
```

`PLAYWRIGHT_MODULE` and `PLAYWRIGHT_EXECUTABLE_PATH` can point to existing installations. Do not install browser binaries. `CAPTURE_DIR` defaults to `/tmp/nat91-live-captures`; `MOCKUP_URL` defaults to `http://127.0.0.1:5191`.

`capture-dropdowns.mjs` tests Workflow, Default Backend, Default/Summary Model, composer, and combobox popups in both themes using browser-local fixture responses. It checks unchanged trigger/popup radii, portalled option coverage, selection/keyboard/Escape behaviour, no unrelated trigger texture changes, and pointer-only motion with zero material/ink rebuilds. Settings and Workflows are never saved, and mutating API calls are intercepted. Renderer counters are exposed through `window.nat91Material.getStats()`; frame timing is recorded as diagnostic evidence, not a hardware-independent FPS promise.

Checks cover the handoff, hidden activity dots with matching solid status edges, selected-only gradient motion and its reduced-motion stop, Running/Awaiting hue changes on navigation, live hue updates and both themes in the portalled mobile drawer, a fully transparent gloss overlay at rest, transparent Settle actions and native keyboard focus, chrome-tab coverage at the right edge (no neutral fade tail), actual silver/black tonal range, cached ink recovery after native class resets and direct text-node changes, cursor-local rail/button gloss with stable remote selections, exact accessible tab names, real tab/session navigation, keyboard focus, reduced motion, both themes, narrow bounds, and browser script errors. **Passing checks is not visual acceptance.** Inspect full layouts and close-ups directly against both original references. This reset rejected local pastel-bevel and label-patch candidates before the current captures. Remaining concerns include graphic-looking silver streaks, faint brushing, stark light-theme selection, and integration between active and inactive faces. Temporary captures stay outside the tree. For PR publication, commit captures, embed their immutable URLs, then remove the files in a follow-up commit.
