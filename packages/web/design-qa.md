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
- State: the source is a populated image-generation task; the saved implementation is the empty state. Layout and component styling can be compared directly, but generated imagery cannot be accepted from this state.

## Full-view comparison evidence

- The three-column proportions, quiet neutral surfaces, thin separators, fixed composer, and persistent task rail follow the selected design direction.
- Typography uses Inter and Noto Sans SC with clear display, body, metadata, and control hierarchy.
- The active accent remains blue; success, danger, disabled, and focus states use semantic tokens with restrained shadows.
- Runtime sample messages, fixed counts, sample history, and sample coffee-machine imagery are absent.
- The source includes a real product-image board. The current environment has no enabled image-generation model, so equivalent dynamic imagery cannot yet be captured or accepted.

## Focused region comparison evidence

- Right rail: tabs are now a compact segmented control with distinct icons, selected surface, and dynamic count badges. Bottom actions share height, radius, icon containers, spacing, hover, disabled, danger, and primary states.
- Composer: the duplicate inner focus rectangle is removed. It starts at 36 px, grows to 168 px, becomes scrollable only beyond the cap, and returns to 36 px after send. Tool labels remain single-line at the 1280 px desktop viewport.
- Mobile: navigation opens as a drawer; the task rail has an explicit open/close control and remains usable at 390 × 844.

## Findings

- [P1] Dynamic product imagery is unavailable.
  - Evidence: the source contains a generated product presentation board; `/api/health` reports image generation unavailable in the current environment.
  - Impact: a request for a concept image can only produce a text design specification, so the complete source state cannot be reproduced.
  - Fix: enable an approved image-generation model, then capture a real generated result and repeat same-state visual QA.

No additional actionable P0/P1/P2 issues remain in the navigation, composer, task rail, tabs, bottom actions, responsive layout, copy, or interaction states.

## Comparison history

1. P1: new-session reset retained the previous result panel. Fixed by resetting the active tab, panel contents, counts, and permission visibility; post-fix browser evidence showed `0 / 0` and an empty process view.
2. P2: 1024 px navigation labels and status text wrapped. Fixed with non-wrapping labels and fixed status badges; post-fix tablet capture showed one-line rows.
3. P0: the task rail was hidden below 1180 px with no usable opener. Added a responsive task trigger and restored fixed overlay positioning; verified open and close at 390 × 844.
4. P1: the composer showed a duplicate inner focus rectangle and retained its expanded height after send. Removed the textarea outline, added controlled auto-growth, and reset height after send; verified 81 px expanded and 36 px reset.
5. P2: right-rail tabs were text-only and bottom actions lacked visual hierarchy. Added icon-led segmented tabs, count badges, unified button geometry, semantic danger/primary treatments, and complete disabled states.
6. P2: streamed Markdown exposed raw headings and tables. Rendering now formats headings, emphasis, lists, and tables during streaming; tables are contained and horizontally scrollable.

## Verification

- Primary interactions tested: prompt submit, auto-grow/reset, stop, retry availability, new session, result/resource tabs, task rail open/close, navigation drawer, and responsive breakpoints.
- Console errors and warnings: none in the final in-app browser pass.
- `npm run check`: passed.
- `npm test --workspace=@jonwork/pi-web`: 5 passed, 0 failed.

## Final result

final result: blocked

Blocker: an approved image-generation model is not enabled, so the populated source state with dynamically generated product imagery cannot be reproduced and accepted yet.
