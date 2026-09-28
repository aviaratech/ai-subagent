import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listModels } from './vendor/ai/index.js';

import { resolveSubagentPreset } from './presets.js';

void describe('ai-subagent presets', () => {
  void it('keeps build/review/ask concepts as presets behind spawn_agent', () => {
    const builder = resolveSubagentPreset({ agentType: 'builder' });
    const worker = resolveSubagentPreset({ agentType: 'worker' });
    const reviewer = resolveSubagentPreset({ agentType: 'reviewer' });
    const ask = resolveSubagentPreset({ agentType: 'ask' });

    assert.strictEqual(builder.agentType, 'builder');
    assert.strictEqual(worker.agentType, 'builder');
    assert.deepStrictEqual(builder.behavior, { sandbox: 'off' });
    assert.deepStrictEqual(worker.behavior, { sandbox: 'off' });
    assert.strictEqual(builder.model, 'xai');
    assert.strictEqual(builder.modelId, 'grok-4.5');
    assert.strictEqual(builder.defaultReasoningEffort, 'high');
    assert.strictEqual(worker.modelId, 'grok-4.5');
    assert.deepStrictEqual(reviewer.behavior, { sandbox: 'off' });
    assert.strictEqual(reviewer.model, 'xai');
    assert.strictEqual(reviewer.modelId, 'grok-4.5');
    assert.strictEqual(reviewer.defaultReasoningEffort, 'high');
    assert.match(reviewer.instructions, /VERDICT: approve \| request-changes/u);
    assert.deepStrictEqual(ask.behavior, { sandbox: 'off' });
    assert.strictEqual(ask.model, 'xai');
    assert.strictEqual(ask.modelId, 'grok-4.5');
    assert.strictEqual(ask.defaultReasoningEffort, 'high');
    assert.match(ask.instructions, /bounded second opinion/u);
  });

  void it('maps default and explorer presets to their GPT-5.6 classes with xhigh reasoning', () => {
    const defaultPreset = resolveSubagentPreset({});
    const explorer = resolveSubagentPreset({ agentType: 'explorer' });

    assert.strictEqual(defaultPreset.agentType, 'default');
    assert.strictEqual(defaultPreset.model, 'gpt');
    assert.strictEqual(defaultPreset.modelId, 'gpt-5.6-terra');
    assert.strictEqual(defaultPreset.defaultReasoningEffort, 'xhigh');
    assert.strictEqual(explorer.agentType, 'explorer');
    assert.strictEqual(explorer.model, 'gpt');
    assert.strictEqual(explorer.modelId, 'gpt-5.6-luna');
    assert.strictEqual(explorer.defaultReasoningEffort, 'xhigh');
  });

  void it('uses each explicit model highest stable effort instead of inheriting another preset default', () => {
    const claude = resolveSubagentPreset({ agentType: 'default', model: 'claude-fable-5[1m]' });
    const grok = resolveSubagentPreset({ agentType: 'reviewer', model: 'grok-4.5' });
    const glm = resolveSubagentPreset({ agentType: 'ask', model: 'glm-5.2' });

    assert.strictEqual(claude.model, 'claude');
    assert.strictEqual(claude.modelId, 'claude-fable-5[1m]');
    assert.strictEqual(claude.defaultReasoningEffort, 'xhigh');
    assert.strictEqual(grok.defaultReasoningEffort, 'high');
    assert.strictEqual(glm.defaultReasoningEffort, undefined);
  });

  void it('allows every active frontier model for every preset with native autonomous authority', () => {
    const agentTypes = ['ask', 'builder', 'default', 'explorer', 'reviewer', 'worker'] as const;
    for (const model of listModels()) {
      for (const agentType of agentTypes) {
        const preset = resolveSubagentPreset({ agentType, model: model.id });
        const effectiveType = agentType === 'worker' ? 'builder' : agentType;
        assert.strictEqual(preset.modelId, model.id, `${agentType}/${model.id}`);
        assert.strictEqual(preset.agentType, effectiveType, `${agentType}/${model.id}`);
        assert.deepStrictEqual(preset.behavior, { sandbox: 'off' }, `${agentType}/${model.id}`);
      }
    }
  });

  void it('fails loudly for unknown agent types and unknown model overrides', () => {
    assert.throws(() => resolveSubagentPreset({ agentType: 'build' }), /Unsupported ai-subagent agent_type/u);
    assert.throws(() => resolveSubagentPreset({ agentType: 'builder', model: 'not-a-real-model' }), /Unknown model/u);
  });
});
