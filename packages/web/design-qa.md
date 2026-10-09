# Design QA

## Comparison input

- Source visual truth: `/Users/a/.codex/generated_images/01a11e94-b25b-7aa1-abe2-449030d073e8/exec-d14f3005-03e3-43ba-9a2c-722c1a2febd4.png`
- User input-focus evidence: `/var/folders/vb/byp2m8bd007dzyh4tzrw9w040000gn/T/codex-clipboard-f3b39f93-7556-4ffe-8718-27f7faa85e2c.png`
- Rendered implementation: `/Users/a/xz-workspace/pi/packages/web/implementation-desktop.png`
- Combined comparison: `/Users/a/xz-workspace/pi/packages/web/design-comparison.png`
- Source pixels: 1487 × 1058.
- Implementation pixels: 1487 × 1058 at a 1487 × 1058 CSS viewport.
- Combined comparison pixels: 5948 × 2116 because the macOS composition canvas exported at 2× density; both halves use the same scale.
- Additional responsive viewports: 1280 × 720, 1024 × 768, and 390 × 844 in the Codex in-app browser.
- State: the source is a populated image-generation task; the saved implementation is the empty state. The relay integration is covered by an isolated contract test, but a live generated image cannot be accepted until the deployment injects its secret and supported image model.

## Full-view comparison evidence

- The three-column proportions, quiet neutral surfaces, thin separators, fixed composer, and persistent task rail follow the selected design direction.
- Typography uses Inter and Noto Sans SC with clear display, body, metadata, and control hierarchy.
- The active accent remains blue; success, danger, disabled, and focus states use semantic tokens with restrained shadows.
- Runtime sample messages, fixed counts, sample history, and sample coffee-machine imagery are absent.
- The source includes a real product-image board. The implementation can now render, zoom, download, and count a real image returned by the relay; the current process has no deployment secret, so equivalent live imagery cannot yet be captured or accepted.

## Focused region comparison evidence

- Right rail: tabs are now a compact segmented control with distinct icons, selected surface, and dynamic count badges. Bottom actions share height, radius, icon containers, spacing, hover, disabled, danger, and primary states.
- Composer: the duplicate inner focus rectangle is removed. It starts at 36 px, grows to 168 px, becomes scrollable only beyond the cap, and returns to 36 px after send. Tool labels remain single-line at the 1280 px desktop viewport.
- Mobile: navigation opens as a drawer; the task rail has an explicit open/close control and remains usable at 390 × 844.

## Findings

- [P1] Live relay image output is not yet accepted.
  - Evidence: the isolated relay contract test passes and verifies `gpt-6.1-sol` plus a forced `image_generation` tool call, while the current preview process has no `JONWORK_API_KEY`.
  - Impact: the production-shaped path exists, but this local preview cannot prove the selected relay account and image model return a valid image.
  - Fix: inject `JONWORK_API_KEY` at deployment, confirm the relay-supported `JONWORK_IMAGE_MODEL`, then capture a real generated result and repeat same-state visual QA.

No additional actionable P0/P1/P2 issues remain in the navigation, composer, task rail, tabs, bottom actions, responsive layout, copy, or interaction states.

## Comparison history

1. P1: new-session reset retained the previous result panel. Fixed by resetting the active tab, panel contents, counts, and permission visibility; post-fix browser evidence showed `0 / 0` and an empty process view.
2. P2: 1024 px navigation labels and status text wrapped. Fixed with non-wrapping labels and fixed status badges; post-fix tablet capture showed one-line rows.
3. P0: the task rail was hidden below 1180 px with no usable opener. Added a responsive task trigger and restored fixed overlay positioning; verified open and close at 390 × 844.
4. P1: the composer showed a duplicate inner focus rectangle and retained its expanded height after send. Removed the textarea outline, added controlled auto-growth, and reset height after send; verified 81 px expanded and 36 px reset.
5. P2: right-rail tabs were text-only and bottom actions lacked visual hierarchy. Added icon-led segmented tabs, count badges, unified button geometry, semantic danger/primary treatments, and complete disabled states.
6. P2: streamed Markdown exposed raw headings and tables. Rendering now formats headings, emphasis, lists, and tables during streaming; tables are contained and horizontally scrollable.
7. P1: image requests could only depend on the legacy provider path. Added a server-only OpenAI-compatible Responses integration, real result rendering/download, and a fake-relay contract test without committing a credential.
8. P2: no direct creation shortcuts existed. Added keyboard-accessible shortcuts for a new design, concept image, reference image, and current outputs.
9. P2: an extension editor prompt glyph could appear as stray composer content. Standalone prompt glyphs are now discarded while normal user-entered text remains unchanged.

## Verification

- Primary interactions tested: prompt submit, auto-grow/reset, stop, retry availability, new session, result/resource tabs, task rail open/close, navigation drawer, and responsive breakpoints.
- Console errors and warnings: none in the final in-app browser pass.
- `npm run check`: passed.
- `npm test --workspace=@jonwork/pi-web`: 7 passed, 0 failed.

## Final result

final result: blocked

Blocker: the deployment has not injected `JONWORK_API_KEY` into the running process and the relay-supported image model has not been live-verified, so dynamic product imagery cannot yet receive final acceptance.
