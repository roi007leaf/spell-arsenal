import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.foundry = { applications: { api: { ApplicationV2: class {} } } };
globalThis.game = { modules: new Map() };
const { SpellArsenalConfig } = await import('../scripts/ui.js');
const { DEFAULT_RULES, validateRules } = await import('../scripts/rules.js');

test('cards list every template including line width and escape source text', () => {
  const ui = new SpellArsenalConfig();
  const html = ui.row({ ...DEFAULT_RULES[3], hasTemplate: true, templateDetails: ['5 ft burst', '5 × 5 ft line', '<script>bad</script>'] });
  assert.match(html, /5 ft burst/); assert.match(html, /5 × 5 ft line/);
  assert.doesNotMatch(html, /From template|<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /class="picker-control" hidden/);
});

test('existing mappings hydrate all native and description templates without replacing overrides', async () => {
  const saved = { ...DEFAULT_RULES[3], duration: 120, stageMode: 'fixed', stage: 3, sourceUuid: 'Actor.a.Item.grease' };
  globalThis.game = { user: { isGM: true, id: 'gm' }, users: { activeGM: { id: 'gm' } }, modules: new Map([['tile-arsenal', { active: true }]]), packs: [],
    settings: { get: (id, key) => key === 'rules' ? [saved] : true } };
  globalThis.fromUuid = async () => ({ type: 'spell', name: 'Grease', uuid: saved.sourceUuid, system: { description: { value: '@Template[burst|distance:5] @Template[line|distance:5|width:5]' } } });
  globalThis.tileArsenal = { utils: { getConfigurations: async () => ({ configurations: {} }) } };
  const html = await new SpellArsenalConfig()._renderHTML();
  assert.match(html, /5 ft burst/); assert.match(html, /5 × 5 ft line/);
  assert.match(html, /value="3"/); assert.match(html, /value="2"/);
  assert.equal(saved.duration, 120); assert.equal(saved.hasTemplate, false);
  assert.equal(validateRules([{ ...saved, templateDetails: ['5 ft burst', '5 × 5 ft line'] }])[0].templateDetails.length, 2);
});

test('legacy Grease card reads actor-specific Wizard shapes when no source link exists', async () => {
  const id = 'pf2e-aztecs-template-wizard';
  const automation = { enabled: true, templateShape: { shapes: [{ type: 'square', size: 10 }] } };
  const spell = { type: 'spell', name: 'Grease', uuid: 'Actor.actor.Item.grease', flags: { [id]: { automation } }, system: {}, getFlag: () => automation };
  globalThis.game = { user: { isGM: true, id: 'gm' }, users: { activeGM: { id: 'gm' } }, actors: [{ items: [spell] }], packs: [],
    modules: new Map([[id, { active: true, api: { readAutomation: item => item.getFlag(id, 'automation') } }], ['tile-arsenal', { active: true }]]),
    settings: { get: (module, key) => key === 'rules' ? [DEFAULT_RULES[3]] : true } };
  const html = await new SpellArsenalConfig()._renderHTML();
  assert.match(html, /Wizard: 10 ft square/);
  assert.doesNotMatch(html, /No spell template/);
  assert.match(html, /Actor.actor.Item.grease/);
  assert.doesNotMatch(html, /Template Wizard configured/);
  assert.match(html, /name="areaTriggers"/);
});

test('Wizard-managed cards hide prompt controls while keeping saved preference', () => {
  const config = new SpellArsenalConfig();
  const html = config.row({ ...DEFAULT_RULES[3], wizardManaged: true, areaAutomation: 'turn-start' });
  assert.match(html, /data-area-automation="turn-start"/);
  assert.match(html, /Template Wizard configured/);
  assert.doesNotMatch(html, /name="areaTriggers"/);
  const ordinary = config.row({ ...DEFAULT_RULES[3], wizardManaged: false });
  assert.match(ordinary, /name="areaTriggers"/);
  assert.doesNotMatch(ordinary, /Template Wizard configured/);
});
