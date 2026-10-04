# Changelog

## 0.1.7 - 2026-10-04

- Fix automatic D&D 5e placement damage opening a roll configuration dialog over spell effects, including when Nik's DND5e Tweaks has automatic damage prompts disabled.
- Keep native damage rolls, targeting, scaling, and manual damage configuration intact.

## 0.1.6 — 2026-10-03

- Simplify single-save prompt buttons to show the save ability without repeating the D&D activity's combined trigger name.
- Keep trigger context in the prompt summary and preserve activity labels when multiple saves require a choice.
- Retain system DC visibility rules and native roll behavior.

## 0.1.5 — 2026-10-03

- Respect PF2e metagame DC visibility and caster ownership in area roll prompts.
- Respect D&D 5e Challenge Visibility when displaying DCs in area roll prompts.
- Keep hidden DCs out of player prompt labels while retaining the actual DC for native save rolls.

## 0.1.4 — 2026-10-03

- Fix garbled separators in save button labels, roll prompt titles, and picker-cell validation text.
- Use plain ASCII separators for these labels to prevent encoding artifacts.

## 0.1.3 — 2026-10-03

- Add optional Trigger Animations integration with a Tile Arsenal node and registered spell entries.
- Add area saves and damage for PF2e, SF2e, and D&D 5e, using native spell rolls and actual cast rank or level.
- Route saves to the affected token's active player owner and attacks/damage to the caster's active player owner, with GM handling unowned actors.
- Detect area triggers automatically from spell data and descriptions, with manual overrides for placement, entry, start/end of turn, and exit.
- Add repeat limits per affected token's turn or caster's turn, plus unrestricted triggers.
- Target covered enemies and roll placement damage once per area; attack spells use their native attack roll.
- Use native token footprint and movement paths for coverage, including passing through an area.
- Remove instant templates after successful damage rolls, including rolls made from native chat cards. Keep lasting areas and cancelled rolls.
- Skip follow-up save prompts when PF2e Toolbelt is active and delegate configured Template Wizard save/damage behaviors.
- Improve mapping controls and roll prompts with clearer labels, portraits, aligned controls, and full-width action buttons.
- Prevent duplicate spell-card posts and cancel stale prompts when their source disappears or expires.
