import { AREA_TRIGGERS, areaTriggers, areaMode } from './area-triggers.js';
export const MODULE_ID = 'spell-arsenal';
export function isInstant(rule) { return rule.instant ?? (rule.duration === 5); }
export const DURATION_UNITS = { seconds: 1, rounds: 6, minutes: 60, hours: 3600 };
export function displayDuration(rule) {
  const unit = rule.durationUnit ?? (rule.duration > 0 && rule.duration % 60 === 0 ? 'minutes' : 'seconds');
  return { unit, value: rule.duration / (DURATION_UNITS[unit] ?? 1) };
}
export function hasTemplate(rule) {
  return rule.hasTemplate ?? ['fireball', 'scatter scree', 'grim tendrils', 'breathe fire'].includes(rule.spell?.trim().toLowerCase());
}
export { DEFAULT_RULES } from './default-rules.js';

export function missingDefaults(existing, defaults) {
  const names = new Set(existing.map(rule => rule.spell.trim().toLowerCase()));
  const ids = new Set(existing.map(rule => rule.id));
  return defaults.filter(rule => !names.has(rule.spell.toLowerCase())).map(rule => {
    let id = rule.id, suffix = 1;
    while (ids.has(id)) id = `${rule.id.slice(0, 55)}-${suffix++}`;
    ids.add(id);
    return { ...rule, id };
  });
}

export function validateRules(rules) {
  if (!Array.isArray(rules) || rules.length > 2500) throw new Error('Supply at most 2500 spell mappings.');
  const ids = new Set(), triggers = new Set();
  return rules.map(rule => {
    if (!rule || typeof rule !== 'object') throw new Error('Invalid spell mapping.');
    if (rule.id === 'grease' && rule.spell === 'Grease' && rule.duration === 0 && rule.instant === undefined && rule.durationUnit === undefined) rule = { ...rule, duration: 60, durationUnit: 'minutes', instant: false };
    const spell = typeof rule.spell === 'string' ? rule.spell.trim() : '';
    const effect = typeof rule.effect === 'string' ? rule.effect.trim() : '';
    if (!spell || (rule.enabled && !effect) || !['area', 'damage', 'caster'].includes(rule.kind)) throw new Error('Each enabled mapping needs spell, effect and trigger.');
    if (typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(rule.id) || ids.has(rule.id)) throw new Error('Mapping IDs must be unique.');
    ids.add(rule.id);
    const areaAutomation = rule.areaAutomation ?? 'off';
    if (!['off', 'placement-entry', 'turn-start'].includes(areaAutomation)) throw new Error('Invalid area automation.');
    const areaEvents = areaTriggers(rule);
    if (!Array.isArray(areaEvents) || areaEvents.some(trigger => !Object.hasOwn(AREA_TRIGGERS, trigger))) throw new Error('Invalid area triggers.');
    const areaRepeat = rule.areaRepeat ?? 'affected-turn';
    const triggerMode = areaMode(rule);
    if (!['auto', 'manual'].includes(triggerMode)) throw new Error('Invalid area trigger mode.');
    if (!['affected-turn', 'caster-turn', 'unrestricted'].includes(areaRepeat)) throw new Error('Invalid area repeat limit.');
    const stageMode = rule.stageMode ?? 'auto';
    if (!['auto', 'buildup', 'fixed'].includes(stageMode)) throw new Error('Stage mode must be auto, buildup or fixed.');
    if (typeof rule.enabled !== 'boolean' || typeof rule.highlight !== 'boolean') throw new Error('Invalid mapping toggle.');
    if (rule.instant !== undefined && typeof rule.instant !== 'boolean') throw new Error('Invalid instant toggle.');
    if (rule.hasTemplate !== undefined && typeof rule.hasTemplate !== 'boolean') throw new Error('Invalid template toggle.');
    if (rule.durationUnit !== undefined && !Object.hasOwn(DURATION_UNITS, rule.durationUnit)) throw new Error('Invalid duration unit.');
    const templateDetails = Array.isArray(rule.templateDetails) ? [...new Set(rule.templateDetails.filter(label => typeof label === 'string' && label.length <= 200))].slice(0, 64) : [];
    const trigger = `${rule.kind}:${spell.toLowerCase()}`;
    if (rule.enabled && triggers.has(trigger)) throw new Error(`Duplicate enabled trigger for ${spell}.`);
    if (rule.enabled) triggers.add(trigger);
    if (!Number.isFinite(rule.duration) || rule.duration < 0 || rule.duration > 2147483 || (!isInstant(rule) && rule.kind !== 'area' && rule.duration === 0)) throw new Error('Duration must be positive; area effects may use 0 for permanent.');
    if (!Number.isInteger(rule.stage) || rule.stage < 1) throw new Error('Stage must be a positive integer.');
    if (!Number.isInteger(rule.squares) || rule.squares < 1 || rule.squares > 120) throw new Error('Choose 1-120 touching cells.');
    return { areaMode: triggerMode, areaAutomation, areaTriggers: [...new Set(areaEvents)], areaRepeat, id: rule.id, enabled: rule.enabled, kind: rule.kind, spell, sourceUuid: typeof rule.sourceUuid === 'string' ? rule.sourceUuid : '', effect, hasTemplate: hasTemplate(rule), templateDetails, duration: isInstant(rule) ? 0 : rule.duration, durationUnit: displayDuration(rule).unit, instant: isInstant(rule), stage: rule.stage, stageMode, squares: rule.squares, highlight: rule.highlight, animater: rule.animater === true };
  });
}

export function runtimeSettings(rule) {
  return { SPELL_NAME: rule.spell, EFFECT_NAME: rule.effect, INSTANT: isInstant(rule), DURATION_SECONDS: isInstant(rule) ? 5 : rule.duration,
    STAGE: rule.stage, STAGE_MODE: rule.stageMode ?? 'auto', FREEFORM_SQUARES: rule.squares, REGION_HIGHLIGHT_ONLY_WHILE_EDITING: rule.highlight, TILE_ELEVATION_OFFSET: 0.1, ANIMATER: rule.animater === true };
}

export function runtimeSignature(rule) { return JSON.stringify([rule.kind, runtimeSettings(rule)]); }
