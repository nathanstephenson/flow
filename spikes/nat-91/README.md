# NAT-91 — brushed chrome material studies, round 02

**Design exploration only. Do not merge as a production implementation.**

The first round's blue/silver ribbons were rejected. This replaces the illustrated wave surfaces and whole-app mockup with close-up **brushed, reflective metal** studies:

1. **Silver:** neutral metal, horizontal brushing, broad silver light and dark reflections.
2. **Cobalt:** the same surface reflecting a blue panel, not a blue coating.
3. **Graphite:** a darker environment with restrained silver highlights.

All three have fine directional grain and small control-size samples. The material is rendered procedurally in Canvas: a gently formed surface reflects rectangular studio fixtures; anisotropic softness and micro-scratches break up the reflections. No decorative SVG curves or repeating wave shapes. This is a simplified material study, not a physically accurate production renderer.

## Preview

From the repository root, after dependencies are installed:

```sh
node spikes/nat-91/preview.mjs
```

Visit <http://127.0.0.1:4391>. The comparison board shows all three finishes. Hover over “Publish changes” to shift its subdued reflected light. “Shell 1” is a static selected-control sample. These controls are **inert**: they do not send messages, open Shells, or publish anything.

Direct links:

- `/?material=silver`
- `/?material=cobalt`
- `/?material=graphite`
- `/?theme=light`

There is no continuous animation. Reduced-motion and touch pointers do not move the reflected light. Keyboard focus has its own visible outline.

The preview is loopback-only, with no Session Host, API, auth, or production app connection. `MOCKUP_PORT` overrides port 4391; `MOCKUP_FONT_FILE` can point to an existing Inter variable font instead of this checkout's `node_modules`.

## Capture

Start the preview, then:

```sh
node spikes/nat-91/capture.mjs
```

Playwright is external tooling, not a new project dependency. If the environment's default installation is unavailable, set:

- `PLAYWRIGHT_MODULE`: path to an installed Playwright module.
- `PLAYWRIGHT_EXECUTABLE_PATH`: path to an existing Chromium executable.
- `MOCKUP_FONT_FILE`: existing `inter-latin-wght-normal.woff2`, when dependencies are not installed in this checkout.

The script captures six images: dark/light comparison boards, three individual close-ups with hover visible, and a narrow comparison board. It checks rendered-pixel changes on pointer movement, reduced-motion and touch stability, actual keyboard focus, theme switching, surface bounds, horizontal overflow, and asset/console errors.

Output defaults to `screenshots/nat-91-round-02`; override with `MOCKUP_SCREENSHOTS`. Screenshots are committed once, then removed in a follow-up commit. The draft PR uses retained commit URLs.

## Scope and review

This is a **material study, not an app-layout proposal**. There are no changes to `web/src`, backend code, dependencies, or Settings. The earlier UI mockup remains in PR history for context, but is no longer the design direction.

First choose whether the material itself is right, then tune grain, silver highlights, and cobalt reflections. Only after that should it return to the real shared UI components. Production contrast, disabled/destructive states, performance, and both themes still need validation; these mockups are not an accessibility sign-off.
