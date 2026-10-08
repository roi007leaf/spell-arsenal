import { registerAreaAutomation } from './area-automation.js';
import { MODULE_ID, validateRules, runtimeSettings, runtimeSignature } from './rules.js';
import { runSpellEffect } from './runtime.js';
import { SpellArsenalConfig } from './ui.js';
import { rememberAnimationRegion, preventMappedAnimation, suppressMappedAnimations } from './animation-integration.js';
import { systemAdapter } from './systems.js';
import { registerTriggerIntegration, triggerIntegrationEnabled } from './trigger-integration.js';
import { animationActivity } from './animater-integration.js';

registerTriggerIntegration();
registerAreaAutomation();

const states = new Map();
let queue = Promise.resolve();
const activeGM = () => game.user.isGM && game.users.activeGM?.id === game.user.id;
const report = error => { console.error('Spell Arsenal', error); ui.notifications.error(`Spell Arsenal: ${error.message}`); };

export function synchronize() {
  queue = queue.then(async () => {
    const authority = activeGM();
    if (authority) for (const scene of game.scenes) await systemAdapter().restoreTextures(scene);
    if (authority) await suppressMappedAnimations();
    const enabled = game.settings.get(MODULE_ID, 'enabled');
    const rules = validateRules(game.settings.get(MODULE_ID, 'rules'));
    const wanted = new Map(authority && enabled ? rules.filter(r => r.enabled).map(r => [r.id, r]) : []);
    const signature = rule => `${runtimeSignature(rule)}:${triggerIntegrationEnabled()}`;
    for (const [id, state] of states) {
      if (wanted.has(id) && state.ruleSignature === signature(wanted.get(id))) continue;
      await state.stop(authority);
      states.delete(id);
    }
    if (!authority || !enabled) return;
    for (const [id, rule] of wanted) {
      if (states.has(id)) continue;
      try {
        const state = await runSpellEffect(rule.kind, runtimeSettings(rule), `${MODULE_ID}:${id}`);
        if (state) { state.ruleSignature = signature(rule); states.set(id, state); }
      } catch (error) { report(error); }
    }
  }).catch(report);
  return queue;
}

async function clearEffects() {
  if (!activeGM()) throw new Error('Cleanup requires the active GM.');
  await game.settings.set(MODULE_ID, 'enabled', false);
  await synchronize();
  // Remove leftovers even when their mappings were deleted before refresh.
  for (const scene of game.scenes) {
    for (const type of ['Tile', 'AmbientLight', 'AmbientSound', 'Region']) {
      const ids = [...scene.getEmbeddedCollection(type)].filter(doc =>
        ['spellArsenalArea', 'spellArsenalDamage', 'spellArsenalCaster'].some(flag =>
          doc.flags.world?.[flag]?.owner?.startsWith(`${MODULE_ID}:`)) ||
        doc.flags.world?.spellArsenalPlacement?.owner?.startsWith(`${MODULE_ID}:`)).map(doc => doc.id);
      if (ids.length) await scene.deleteEmbeddedDocuments(type, ids);
    }
    for (const region of scene.regions) {
      const saved = region.flags.world?.spellArsenalHighlight;
      if (!saved?.owner?.startsWith(`${MODULE_ID}:`)) continue;
      const update = { 'flags.world.-=spellArsenalHighlight': null };
      if (region.visibility === CONST.REGION_VISIBILITY.LAYER) update.visibility = saved.visibility;
      await region.update(update);
    }
  }
  ui.notifications.info('Spell Arsenal paused. Generated effects cleared. Enable automation to resume.');
}

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'autoRollDamage', { name: 'Automatically roll area damage', hint: 'Roll spell damage when a configured spell area is placed. Disable to roll damage manually from the spell card. Applies to all supported systems; attack rolls and explicit area roll prompts remain available.', scope: 'world', config: true, type: Boolean, default: true });
  game.settings.register(MODULE_ID, 'triggerAnimations', { name: 'Use Trigger Animations', hint: 'Manage Tile Arsenal spell entries and priorities in Trigger Animations. Enable its Spell Arsenal entries, then refresh after adding new spell mappings.', scope: 'world', config: true, type: Boolean, default: false, requiresReload: true });
  game.settings.register(MODULE_ID, 'enabled', { name: 'Enable spell visuals', hint: 'Automatically run mappings in the active GM session.', scope: 'world', config: true, type: Boolean, default: true, onChange: synchronize });
  game.settings.register(MODULE_ID, 'rules', { scope: 'world', config: false, type: Array, default: systemAdapter().defaults(), onChange: synchronize });
  game.settings.registerMenu(MODULE_ID, 'configure', { name: 'Spell mappings', label: 'Configure Spell Arsenal', hint: 'Add spells, choose Tile Arsenal effects, manage durations and triggers.', icon: 'fas fa-wand-magic-sparkles', type: SpellArsenalConfig, restricted: true });
});

Hooks.once('ready', async () => {
  game.modules.get(MODULE_ID).api = { open: () => new SpellArsenalConfig().render(true), synchronize, clearEffects, status: () => [...states.keys()], animationActivity, diagnose: () => {
    const result = {
      enabled: game.settings.get(MODULE_ID, 'enabled'), activeGM: activeGM(), activeRules: [...states.keys()],
      rules: game.settings.get(MODULE_ID, 'rules'),
      animationActivity: animationActivity(),
      regions: [...(canvas.scene?.regions ?? [])].map(region => {
        let spell, pending, error;
        try { spell = systemAdapter().regionName(region); pending = systemAdapter().placementPending(region); } catch (e) { error = e.message; }
        return { id: region.id, name: region.name, flags: region.toObject().flags, spell, pending, error, levels: [...region.levels] };
      }),
      tiles: [...(canvas.scene?.tiles ?? [])].map(tile => ({ id: tile.id, alpha: tile.alpha, texture: tile.texture?.src, flags: tile.toObject().flags })),
      animationEffects: globalThis.Sequencer?.EffectManager?.getEffects?.()?.map(effect => ({ name: effect.data?.name, file: effect.data?.file, source: effect.data?.source })) ?? []
    };
    console.log('Spell Arsenal diagnostic', result);
    return JSON.stringify(result, null, 2);
  } };
  await synchronize();
});
Hooks.on('updateUser', synchronize);
Hooks.on('triggerAnimations.ready', synchronize);
Hooks.on('userConnected', synchronize);
Hooks.on('createRegion', rememberAnimationRegion);
Hooks.on('deleteRegion', rememberAnimationRegion);
Hooks.on('preCreateSequencerEffect', preventMappedAnimation);
Hooks.once('init', () => systemAdapter().registerHooks());
Hooks.on('createSequencerEffect', () => { suppressMappedAnimations().catch(report); });
Hooks.on('sequencerEffectManagerReady', () => { suppressMappedAnimations().catch(report); });
