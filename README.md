# Spell Arsenal

Bring your spells to life with automatic **Tile Arsenal** visuals in Foundry VTT. Supports **Pathfinder 2e, Starfinder 2e, and D&D 5e**.

Inspired by [Lunatic Dice's video](https://www.youtube.com/watch?v=w0UHqiM_6U8).

## What it does

- Start with curated spell defaults, or drag spells from sheets and compendiums into the editor.
- Read spell templates and durations, with suggested Tile Arsenal effects.
- Trigger visuals when a spell is cast, its area is placed, or its damage is applied.
- Use the placed areas actual shape and covered cells.
- Match visual stages to spell rank or cast level, or choose repeated-cast buildup or a fixed stage.
- Open spell details and customize each mappingâ€™s effect, duration, and trigger.
- Suppress overlapping Automated Animations template effects for mapped spells.

Spell Arsenal handles visuals. Your game system handles saves, damage, conditions, and spell resources.

## Requirements

- **Foundry VTT v14**
- **PF2e, SF2e, or D&D 5e** (D&D 5e version **6.0.5+**)
- **Tile Arsenal 1.1.0+**, installed and enabled
- A square or hex grid and an active GM online

## Install

In Foundry's **Add-on Modules’ Install Module**, paste this manifest URL:

```text
https://github.com/roi007leaf/spell-arsenal/releases/download/1.0.0/module.json
```

Enable **Spell Arsenal** and **Tile Arsenal** in your world.  [feedback and bug reports](https://github.com/roi007leaf/spell-arsenal/issues) are welcome.

## Quick start

1. Open **Settings’ Configure Spell Arsenal** as GM.
2. Use the defaults, or drag in a spell to add a mapping.
3. Review the suggested effect, trigger, and duration, then click **Save mappings**.
4. Cast the spell and place its area or apply its damage as usual.

Use **Add missing defaults** to add catalog mappings while keeping your customizations. D&D defaults follow your world's 2014 or 2024 Rules Version setting. Not every spell has a suitable automatic visual; you can configure additional spells yourself.

## Customize your visuals

**Triggers:** Area follows a placed spell region; Damage plays on the damaged token; Cast plays on the caster. Spells without a template can use a picker for touching cells.

**Duration:** Instant spells get brief visual playback. Lasting spells can use a duration in seconds, rounds, minutes, hours, or days. Timers use real time. Lasting areas with duration zero remain until their source region is deleted.

**Stages:** Spell rank uses the available stage closest to the cast rank or level. Cantrips use stage 1. Cast buildup increases the stage when the same effect is cast again in an occupied cell. Fixed lets you choose manually.

**Animater:** Enable the desired spell recipe or catalog entry in Animater, then check **Also play Animater recipe** on its mapping. Animater finishes before Spell Arsenal starts its Tile Arsenal visuals. Area animations wait for Toolbelt's target confirmation when its helper is enabled, use the selected tokens, and can finish both visuals after the template is removed.

Use **Animater for all entries → Enable all / Disable all** above the mapping list to change every mapping, including filtered entries. Click **Save mappings** to apply.

For playback troubleshooting, run `game.modules.get('spell-arsenal').api.animationActivity()` in Foundry's console after casting. The last 40 entries show placement, target waits, recipe resolution, playback completion, and reasons for skipped or blocked animations. Reload Foundry after updating module scripts.

**Cleanup:** Delete the source region to remove its visuals, or use **Pause & clear effects** to stop automation and clear generated effects across scenes.

## Area save and damage prompts

Under **Area saves and damage**, new mappings use **Automatic from spell rules**. Trigger selections come from the actual spell’s native activities and description. Turn automatic mode off to select any combination of placement, entry/re-entry, start of turn, end of turn, and exit manually. No manual selections means off. Existing manual overrides are preserved. Coverage follows the token’s footprint and movement path, including passing through an area. Teleports only check the destination.

Choose a repeat limit: once per affected token’s turn, once per caster’s turn, or every trigger. These limits are per token and source area; without combat, movement triggers run each time. Automatic mode shows detected triggers and resolves them again when the spell is used. No reliable data means no inferred triggers; unusual or localized wording may need manual setup.

On placement, Spell Arsenal targets all covered enemies: PF2e uses actor alliances; D&D uses token disposition relative to the caster’s scene token. Damage spells roll native damage once for the area; attack spells roll their native attack instead. The roll still happens when no enemies are covered. Save prompts remain individual; entry and turn triggers use their configured prompts.

With **PF2e Toolbelt** active, Spell Arsenal skips its follow-up save prompts after the placement roll. Use Toolbelt’s chat controls to handle those saves.

Instant spell templates are removed after a successful placement damage roll and any follow-up save prompts. Lasting areas and cancelled rolls keep their templates.

An active player who owns the token receives its save prompt; otherwise the GM handles the save. The GM receives damage controls. Rolls use the system’s native spell data, including the actual cast rank or level and caster DC. Automation opens a prompt without reposting the spell description. Use the original spell card for follow-up; HP is not changed automatically. A timed-out player request does not trigger an automatic second save.

Prompts are limited to once per token and region per combat turn. Deleting the source or token, disabling automation, or reaching a lasting area’s duration cancels pending prompts. Aztec Template Wizard save and damage behaviors are left to that module; configuring only template shapes still allows Spell Arsenal rolls. Defaults stay off: choose triggers according to the individual spell’s rules.

## Trigger Animations integration

With **Trigger Animations** and **Trigger Engine** enabled, turn on **Use Trigger Animations** in Spell Arsenal’s settings and reload. In Trigger Animations’ registration menu, enable the entries in **Spell Arsenal** and choose their priorities relative to other animations. Each entry uses the custom **Tile Arsenal** node to render its configured spell mapping. Disabled entries do not fall back to Spell Arsenal’s standalone visuals.

Spell Arsenal still manages area placement updates, durations, and cleanup. Save mapping changes in Spell Arsenal; refresh after adding new mappings so their entries appear in Trigger Animations. Turn off **Use Trigger Animations** and reload to return to standalone behavior.

## Current limitations

- Gridless scenes are unsupported.
- Imported suggestions may need adjustment, especially for unusual spells or localized duration text.
- D&D concentration changes and damage undo do not automatically clear visuals. Delete the source region or use **Pause & clear effects**.

## Credits

Inspired by **Lunatic Dice**. Artwork and sounds come from your installed **Tile Arsenal** module and are not bundled here.

Automatic area damage rolls are enabled by default. Turn off **Automatically roll area damage** in module settings to roll damage manually from the spell card. With PF2e Toolbelt's template helper enabled, damage waits for its targeting confirmation and uses the chosen targets; canceling or selecting no targets skips the automatic roll. Otherwise, area placement targets enemies.
