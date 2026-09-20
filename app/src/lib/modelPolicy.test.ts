import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tierForMode,
  recommendForMode,
  modelPolicyView,
} from './modelPolicy.ts'
import { modelPolicyConfig } from './config.ts'

const POLICY_CHEAP = { complexModel: 'exp-model', cheapModel: 'lean-model' }
const POLICY_NO_CHEAP = { complexModel: 'exp-model', cheapModel: null }

test('tierForMode maps spend-guard modes to model tiers', () => {
  assert.equal(tierForMode('run'), 'complex')
  assert.equal(tierForMode('downshift'), 'cheap')
  assert.equal(tierForMode('skip'), null)
})

test('recommendForMode routes normal runs to the complex model', () => {
  const rec = recommendForMode('run', POLICY_CHEAP)
  assert.equal(rec.tier, 'complex')
  assert.equal(rec.spend, true)
  assert.equal(rec.model, 'exp-model')
  assert.match(rec.reason, /full-power/)
})

test('recommendForMode routes downshifted runs to the cheapest capable model', () => {
  const rec = recommendForMode('downshift', POLICY_CHEAP)
  assert.equal(rec.tier, 'cheap')
  assert.equal(rec.spend, true)
  assert.equal(rec.model, 'lean-model')
  assert.match(rec.reason, /cheapest capable/)
})

test('recommendForMode spends nothing on a skip', () => {
  const rec = recommendForMode('skip', POLICY_CHEAP)
  assert.equal(rec.tier, null)
  assert.equal(rec.spend, false)
  assert.equal(rec.model, null)
})

test('downshift with no cheap model falls back to the leanest capable (complex) model', () => {
  const rec = recommendForMode('downshift', POLICY_NO_CHEAP)
  assert.equal(rec.tier, 'cheap')
  assert.equal(rec.spend, true)
  assert.equal(rec.model, 'exp-model')
  assert.match(rec.reason, /no CHEAP_MODEL configured/)
})

test('modelPolicyView reflects configured cheap model', () => {
  const v = modelPolicyView()
  assert.equal(typeof v.complexModel, 'string')
  assert.ok(v.complexModel.length > 0)
  // When a cheap model is set it must differ from the complex model.
  if (v.cheapModel !== null && v.cheapEnabled) {
    assert.notEqual(v.cheapModel, v.complexModel)
  }
  assert.equal(typeof v.summary, 'string')
  assert.ok(v.summary.length > 0)
  assert.equal(typeof v.cheapEnabled, 'boolean')
})

test('config cheapModel is null when CHEAP_MODEL equals COMPLEX_MODEL', () => {
  // The config already handles this at load time; verify the invariant:
  // cheapModel never equals complexModel.
  if (modelPolicyConfig.cheapModel !== null) {
    assert.notEqual(modelPolicyConfig.cheapModel, modelPolicyConfig.complexModel)
  }
})
