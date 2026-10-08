// Toolbelt's createRegion listener awaits user input, but Foundry does not await hooks.
// Its spell-card target update starts after setTargets: observe preUpdate as well
// as update, since Foundry drops a no-op update when the targets haven't changed.
const pending = new Map();
const helperClass = 'pf2e-toolbelt-template-helper';
function usesHelper(region, checkControl = true) {
  const origin = region.flags?.[game.system.id]?.origin;
  return game.modules.get('pf2e-toolbelt')?.active && game.toolbelt?.getToolSetting?.('targetHelper', 'enabled') &&
    game.toolbelt.getToolSetting('targetHelper', 'template') && globalThis.canvas?.scene && region.isEffectArea &&
    region.shapes?.length && origin && !region.flags?.['pf2e-toolbelt']?.targetHelper?.skip &&
    (!checkControl || !game.keyboard?.isModifierActive('Control'));
}
function remember(region, creatorId) {
  if (pending.has(region.uuid)) return pending.get(region.uuid);
  let resolve;
  const state = { region, creatorId, confirmed: false, settled: false, dialog: null,
    promise: new Promise(done => { resolve = done; }) };
  state.finish = (targets, handled = true) => {
    if (state.settled) return;
    state.settled = true;
    resolve({ handled, targets });
  };
  pending.set(region.uuid, state);
  // Retain the source in this bounded cache: Toolbelt can delete it before
  // the caster's roll query arrives. Never evict an unresolved targeting dialog.
  if (pending.size > 100) for (const [uuid, entry] of pending) {
    if (entry.settled) { pending.delete(uuid); break; }
  }
  return state;
}
export function targetingRegion(uuid) { return pending.get(uuid)?.region; }
export async function waitForToolbeltTargets(region) {
  const state = pending.get(region.uuid);
  if (!state) return { handled: false };
  if (state.creatorId === game.user.id) return state.promise;
  const creator = game.users.get(state.creatorId);
  if (!creator?.active || !creator.query) return { handled: true, targets: null };
  try { return await creator.query('spell-arsenal.area-targets', { regionUuid: region.uuid }, { timeout: 120000 }); }
  catch (error) { console.warn('Spell Arsenal template targeting', error); return { handled: true, targets: null }; }
}
export function registerToolbeltTargeting() {
  Hooks.on('preCreateRegion', (region, _data, options) => {
    options.spellArsenalTargetHelper = usesHelper(region, false) ? game.user.id : false;
  });
  Hooks.on('createRegion', (region, options, userId) => {
    const creatorId = options.spellArsenalTargetHelper ?? (userId === game.user.id && usesHelper(region) ? userId : false);
    if (creatorId) {
      const state = remember(region, creatorId);
      if (creatorId === game.user.id && !usesHelper(region)) state.finish(null, false);
    }
  });
  CONFIG.queries['spell-arsenal.area-targets'] = data => pending.get(data.regionUuid)?.promise ?? { handled: false };
  Hooks.on('renderDialogV2', dialog => {
    if (!dialog.options.classes?.includes(helperClass)) return;
    const matches = [...pending.values()].filter(state => state.creatorId === game.user.id && !state.settled && !state.dialog &&
      state.region.flags?.[game.system.id]?.origin?.name === dialog.options.window?.title);
    // A card update identifies confirmations exactly. With simultaneous same-name
    // casts, don't guess which source a canceled dialog belongs to.
    if (matches.length !== 1) return;
    const state = matches[0];
    state.dialog = dialog;
    // ApplicationV2 freezes the top-level options. Button definitions remain
    // mutable; observe their result before DialogV2 resolves its wait promise.
    for (const button of Object.values(dialog.options.buttons)) {
      const callback = button.callback;
      button.callback = async function(...args) {
        const result = await callback?.apply(this, args);
        state.confirmed = Boolean(result && Object.hasOwn(result, 'targets'));
        if (!state.confirmed) state.finish(null);
        return result;
      };
    }
  });
  Hooks.on('closeDialogV2', dialog => {
    for (const state of pending.values()) if (state.dialog === dialog) {
      if (!state.confirmed) state.finish(null);
      else if (!state.region.flags?.[game.system.id]?.messageId) {
        state.finish([...game.user.targets ?? []].map(token => (token.document ?? token).uuid));
      }
    }
  });
  const updatedTargets = (message, changes) => {
    const path = 'flags.pf2e-toolbelt.targetHelper.targets';
    const targets = changes[path] ?? changes.flags?.['pf2e-toolbelt']?.targetHelper?.targets;
    if (!Array.isArray(targets)) return;
    for (const state of pending.values()) if (state.region.flags?.[game.system.id]?.messageId === message.id) {
      if (state.dialog && !state.confirmed) continue;
      state.confirmed = true;
      state.finish(targets);
    }
  };
  Hooks.on('preUpdateChatMessage', updatedTargets);
  Hooks.on('updateChatMessage', updatedTargets);
  Hooks.on('deleteRegion', region => {
    const state = pending.get(region.uuid);
    if (state && !state.confirmed) state.finish(null);
  });
  Hooks.on('canvasTearDown', () => { for (const state of pending.values()) state.finish(null); pending.clear(); });
}
