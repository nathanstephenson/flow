# NAT-91 — interactive material study on the real UI

Round five runs the **actual Flow React UI under Vite**, with a dev-only material layer. This work-in-progress replaces feathered neon pools with directional cobalt/steel-blue reflections, adds fine page-space micro-grooves, and stretches tab controls into their rails. Inactive controls use the same quieter surface. The material still needs visual refinement; this is not a final chrome treatment. Production UI files are unchanged. Earlier standalone round-two sources (`index.html`, `mockup.css`, `mockup.js`) remain as reference, but are not served by this preview.

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
- **Shared material:** one procedural WebGL atlas, page-coordinate grain, anisotropic silver highlights, and a common pointer-driven light. Each control samples the visual underlay and its ancestor backgrounds (including translucent and OKLCH colours) so active colour fades back to the correct page/panel tone. This also handles absolute controls sitting over a sibling region, such as the mobile rail trigger over the header. Local canvas layers respect control stacking/clipping and do not replace React text nodes. No baked material images, ribbons, or textured wallpaper.
- **Restrained interaction:** selected controls catch cobalt; ordinary controls stay graphite/silver. Reduced-motion and touch keep the light stable. Native keyboard focus treatment stays in place.

The preview-only Vite plugin injects `live-material.js`; the normal build never includes it. Edit that file while the preview runs to iterate.

## Capture and checks

With both processes running:

```sh
MOCKUP_STATE_DIR=/tmp/nat91-preview-1 node spikes/nat-91/capture.mjs
```

`PLAYWRIGHT_MODULE` and `PLAYWRIGHT_EXECUTABLE_PATH` can point to existing installations. Do not install browser binaries. `CAPTURE_DIR` defaults to `/tmp/nat91-live-captures`; `MOCKUP_URL` defaults to `http://127.0.0.1:5191`.

Checks cover the handoff, a saturated active core with a neutral gradient tail, changing shared-light pixels, real tab/session navigation, keyboard focus, reduced motion, both themes, narrow bounds, and browser script errors. **Passing checks is not visual acceptance.** Inspect full-layout and close-up captures in both themes and narrow layouts before publishing. Round five went through four local capture iterations; screenshot review caught the mobile trigger's mismatched backdrop and rejected the softer initial highlights. The remaining concern is that the luminous brushing can still read as horizontal streaking rather than convincing metal. Temporary captures stay outside the tree. For PR publication, commit captures, embed their commit URLs, then remove the files in a follow-up commit.
