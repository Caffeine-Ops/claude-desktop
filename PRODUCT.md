# Product

## Register

product

## Users

Knowledge workers and creators who hand off real work — writing proposals, doing design, running automation tasks — to an AI agent instead of doing it by hand. They use Claude Desktop as a focused, sit-down desktop workspace, not a quick glance-and-leave surface. Many are not technical: the project's own convention is "普通用户产品：一律大白话" (plain language for everyday users, not power-user jargon), so copy and UI must stay approachable even though the underlying tech (an agent SDK driving a CLI) is sophisticated.

## Product Purpose

Claude Desktop is an Electron app that wraps the Claude Agent SDK (actually driving a bundled `fusion-code` CLI) into a desktop workbench. Its own login-page tagline states the pitch directly: "把想法交给智能体" (hand your ideas to an agent) — "写方案、做设计、跑任务，一个工作台完成" (write proposals, do design, run tasks, all in one workbench). Success looks like a user trusting the app enough to delegate a real task and getting a usable result back without fighting the interface.

## Brand Personality

**专业 · 科技感 · 克制** (Professional · Tech-forward · Restrained)

The existing login screen already encodes this: a "HUD split-screen" layout, a signature brand green (not the user's adjustable accent color — a deliberate identity/preference split), a slow-rotating glow ring, monospace terminal-style status lines ("System Ready"). The tone reads as a serious tool that happens to look good, not a toy and not a cold enterprise dashboard. Tech/sci-fi cues (glow, grid, mono type) are seasoning, not the entrée — they should never get in the way of the user trusting the product with real work.

## Anti-references

No strong objections from the user beyond staying consistent with the existing direction. Two soft avoidances follow from the stated personality:
- Generic enterprise-SaaS login/form templates (Notion/Linear-style flat white cards) — would flatten the product's existing identity.
- Over-the-top cyberpunk/neon excess that trades legibility and trust for spectacle — restraint is part of the brand, not just aesthetics.

## Design Principles

1. **Plain language over jargon.** UI copy is written for everyday users first; raw/technical data gets collapsed behind a fold rather than shown by default. (Existing project convention, not open for reinterpretation per task.)
2. **Brand identity vs. user preference are different tokens.** The signature green (`--brand`) is the product's identity and does not follow the user's theme; `--accent` is what the user is free to customize. Never conflate the two when adding UI.
3. **Two rendering surfaces, one coherent product.** The app is technically split into a "chat" surface (shadcn/Tailwind) and a "canvas" surface (hand-rolled CSS) sharing one document — they must read as a single consistent app to the user even though they're isolated at the implementation layer.
4. **Tech atmosphere serves trust, not spectacle.** Glow, grid lines, orbiting rings, mono status text are allowed but must stay restrained — the goal is "this feels like a capable professional tool," not "look how futuristic this is."

## Accessibility & Inclusion

No explicit WCAG level or special user-need requirements have been raised. Default to WCAG AA-equivalent care (contrast ratios, visible focus states, `prefers-reduced-motion` alternatives for decorative animation) until a stronger requirement surfaces.
