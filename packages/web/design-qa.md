# Design QA

## Comparison input

- Selected design direction: `/Users/a/.codex/generated_images/01a11e94-b25b-7aa1-abe2-449030d073e8/exec-d14f3005-03e3-43ba-9a2c-722c1a2febd4.png`
- Implemented screen: `implementation-desktop.png`
- Desktop viewport: 1920 × 1080
- Mobile viewport: 390 × 844
- State: connected Pi workbench, execution panel open

## Findings and resolution

| Area | Finding | Resolution |
| --- | --- | --- |
| Layout | The selected direction uses a three-column workbench with a persistent execution rail. | Implemented fixed navigation, flexible conversation canvas, and 430 px run rail. |
| Hierarchy | The concept depends on quiet surfaces, thin borders, and one blue action accent. | Matched the visual hierarchy and reserved blue for progress and active state. |
| Conversation | The reference keeps the composer visible while content scrolls independently. | Corrected the center column height and overflow so the composer remains reachable. |
| Execution state | A decorative panel would not satisfy the product requirement. | Bound connection, message, tool, stop, progress, and extension UI events to Pi RPC/SSE. |
| Responsive | Three columns cannot remain usable on phone widths. | Navigation becomes a drawer and the run rail can be opened/closed; prompt stays visible at 390 × 844. |
| Misleading controls | Unbuilt product modules must not appear complete. | Current milestone is explicitly scoped to chat; unavailable modules display a clear status message. |

## Verification history

1. Desktop visual inspection at 1920 × 1080: passed.
2. Mobile breakpoint at 390 × 844: menu and prompt both visible.
3. Real RPC prompt `只回复：Pi 企业级链路正常`: received exact response `Pi 企业级链路正常`.
4. Repository static/type checks: passed.
5. Web gateway integration tests: 3 passed, 0 failed.
6. Dependency audit: blocked by 2 inherited high-severity `node-forge` findings with no upstream fix available; recorded as a production release gate.

## Result

Passed for the conversation-workbench milestone. Production exposure still requires deployment-layer TLS, enterprise SSO, audit retention, and rate limiting, as documented in the usage guide.
