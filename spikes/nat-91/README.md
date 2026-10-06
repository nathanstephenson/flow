# NAT-91 — interactive material study on the real UI

Round six resets the **actual Flow React UI under Vite** against both original user references: saturated reflected colour, near-black troughs, and bright silver catches, rather than capped blue glow. Those references are mirror chrome; fine brushing is an additional requirement, not a claimed property of the artwork. This remains a visual WIP, not an approved chrome treatment. The bright catches can still read as graphic streaks, and brushing is too faint at normal size. Production UI files are unchanged. Earlier standalone sources remain as history, but are not served by this preview. The original user artwork is not committed or published.

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
- **Shared material:** one procedural WebGL renderer, page-coordinate fine brushing, and a shared reflected environment. Surface normals follow control/rail geometry; there is no per-control left-to-right fade mask. Reflected blue/purple shades derive from the app's `--trigger-command` and `--trigger-skill` tokens. Each surface is copied immediately after its draw to avoid overlap contamination. Backdrop sampling still handles translucent/OKLCH backgrounds and absolute controls over sibling regions.
- **Readable type:** the actual material drives a black/white foreground map clipped to existing DOM text. Reflections remain continuous—no dark label-shaped patches. Direct-text buttons need a visual-only pseudo-element with empty accessibility alternative text; exact accessible tab names are checked. Monochrome icons sample the material at their centres. This is a mockup technique, **not a completed production accessibility/performance solution**; icon-centre sampling needs particular scrutiny.
- **Integrated regions:** dock tabs share available rail width, Git's view strip reaches the panel edges, and Git actions form a connected strip. Narrow Subagent notices put descriptions on a second line so task names do not break mid-word; long descriptions still truncate.
- **Restrained interaction:** the reflected environment is stable; only the hovered button's subdued gloss follows the cursor. Remote selected controls do not relight. Reduced-motion and touch use a stable highlight position; keyboard focus retains a distinct outline.

The preview-only Vite plugin injects `live-material.js`; the normal build never includes it. Edit that file while the preview runs to iterate.

### Frontend only, against an existing backend

When explicitly testing live Sessions instead of fixtures:

```sh
MOCKUP_STATE_DIR="${FLOW_STATE_DIR:-$HOME/.flow}" MOCKUP_LIVE_BACKEND=1 \
  MOCKUP_BIND_HOST=0.0.0.0 MOCKUP_PORT=3069 \
  MOCKUP_ALLOWED_HOSTS=testing.nathanstephenson.dev node spikes/nat-91/preview.mjs
```

This starts only Vite and proxies to the existing `daemon.json` URL. Use a backend built from the same revision; an older running host may lack the current transcript API. A backend configured with OIDC may redirect to its registered public address; this preview does not alter that auth configuration. Prefer fixture mode above for portable local testing. It does not start/restart a Session Host, seed Sessions, install fixture layouts, or offer the token-bearing `/study` handoff. Open `/` using the backend's normal authentication. **Actions now target the live backend**, not `FakeBackend`. The default binding remains loopback unless `MOCKUP_BIND_HOST` is explicitly set. `MOCKUP_ALLOWED_HOSTS` accepts a comma-separated list of exact hostnames for reverse proxies; Vite's hostname protection is not disabled.

## Capture and checks

With both processes running:

```sh
MOCKUP_STATE_DIR=/tmp/nat91-preview-1 node spikes/nat-91/capture.mjs
```

`PLAYWRIGHT_MODULE` and `PLAYWRIGHT_EXECUTABLE_PATH` can point to existing installations. Do not install browser binaries. `CAPTURE_DIR` defaults to `/tmp/nat91-live-captures`; `MOCKUP_URL` defaults to `http://127.0.0.1:5191`.

Checks cover the handoff, material coverage at the right edge (no neutral fade tail), actual silver/black tonal range, cursor-local gloss with stable remote selections, exact accessible tab names, real tab/session navigation, keyboard focus, reduced motion, both themes, narrow bounds, and browser script errors. **Passing checks is not visual acceptance.** Inspect full layouts and close-ups directly against both original references. This reset rejected local pastel-bevel and label-patch candidates before the current captures. Remaining concerns include graphic-looking silver streaks, faint brushing, stark light-theme selection, and integration between active and inactive faces. Temporary captures stay outside the tree. For PR publication, commit captures, embed their immutable URLs, then remove the files in a follow-up commit.
