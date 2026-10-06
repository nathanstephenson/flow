# NAT-91 — neo-chrome mockups

**Design exploration only. Do not merge as a production implementation.**

A standalone, synthetic Flow workspace for comparing three mirror-chrome treatments:

1. **Cobalt:** blue-black with a restrained silver fold.
2. **Silver:** a brighter, silver-forward surface reflecting cobalt.
3. **Liquid:** saturated cobalt, near-black troughs, and more pronounced silver folds; closest to the supplied reference art.

All three use the same layout and content. The material spans selected Agent Session rows and Dock tabs. Hover catches a subdued, cursor-following reflection; labels stay still. No continuous animation. Reduced-motion and touch pointers do not drive the highlight.

## Preview

From the repository root, after dependencies are installed:

```sh
node spikes/nat-91/preview.mjs
```

Visit <http://127.0.0.1:4391>. Switch treatments in the study header and scroll down for interaction close-ups. App-shaped buttons are **inert**; only the study selectors, theme toggle, and decorative pointer reflection are wired. Text, tool output, diffs, model labels, and test counts are fixtures, not actual results.

Direct links:

- `/?treatment=cobalt`
- `/?treatment=silver`
- `/?treatment=liquid`
- `/?treatment=cobalt&theme=light`
- `/?treatment=liquid&view=detail`

The preview is loopback-only and has no connection to a Session Host or API. It cannot send a message, start an Agent Session, or publish changes. `MOCKUP_PORT` overrides the port; `MOCKUP_FONT_FILE` can point to an existing Inter variable font installation instead of this checkout's `node_modules`.

## Capture

Start the preview, then:

```sh
node spikes/nat-91/capture.mjs
```

The capture script uses the environment's existing Playwright, not a project dependency. Set `PLAYWRIGHT_MODULE` to an alternate Playwright module and `PLAYWRIGHT_EXECUTABLE_PATH` to an existing Chromium executable if necessary. It produces eight screenshots and checks study/theme selection, pointer lighting, reduced-motion behaviour, asset/console errors, and horizontal overflow at desktop/mobile sizes. Screenshot output defaults to `screenshots/nat-91`; override with `MOCKUP_SCREENSHOTS`.

Screenshots are committed once and removed in a follow-up commit, per the repository convention. View them in the draft PR, whose images point at the retained screenshot commit.

## Relationship to the app

This is **not a running-app screenshot** and does not modify `web/src`, backend code, dependencies, or Settings. Geometry is based on the existing Agent Session rail, pane header, composer, Git view, and Docks. It retains Inter, Lucide icon shapes, neutral light/dark surfaces, and the blue/purple status meanings. It explores flatter, integrated controls rather than inset rounded pills.

The mobile screenshot is a narrow-layout material check, not a proposal for replacing Flow's mobile navigation. Before implementation, choose the material treatment and bring it into shared UI tokens/components; verify real selection/hover/focus/disabled/destructive states, contrast over every reflection, mobile navigation, and both themes. These mockups are not an accessibility sign-off.

## Review questions

- Which material is closest to the intended direction: cobalt, silver, or liquid?
- Is chrome appropriately limited to selection and hover, or should it appear elsewhere?
- Are the full-bleed controls right, and is the reflection too strong or too restrained?

## Icon attribution

`icons.svg` contains the same Lucide icon paths used by Flow. See [LICENSE-icons](./LICENSE-icons) for the upstream ISC notice and MIT notice covering Feather-derived icons.
