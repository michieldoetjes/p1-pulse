#!/usr/bin/env node
/**
 * Gas cost guard (P1API.guardGasCost) against the captured fixtures.
 * The month fixture has a EUR 8,146 gas bucket next to 5.36 m³ of gas.
 *
 * Usage: node tests/run-cost-guard-tests.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/p1', name), 'utf8'));

const sandbox = {
    P1Logger: { log() {}, warn() {}, error() {} },
    P1Utils: { tariffs: () => ({ gas: 1.5 }) }
};
sandbox.window = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(root, 'assets/js/api.js'), 'utf8'), sandbox);
const api = sandbox.P1API;

let failed = 0;
const test = (name, fn) => {
    try { fn(); console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
};

test('spike month is replaced by volume × tariff', () => {
    const out = api.guardGasCost(fixture('financial-month.json'), fixture('powergas-month.json'));
    const bad = out.find(r => r.TIMESTAMP_lOCAL.startsWith('2025-08-25'));
    assert.strictEqual(bad.gasCostEstimated, true);
    assert.ok(Math.abs(bad.CONSUMPTION_COST_GAS - 5.356148 * 1.5) < 1e-6);
});

test('normal months are left untouched', () => {
    const input = fixture('financial-month.json');
    const out = api.guardGasCost(input, fixture('powergas-month.json'));
    out.filter(r => !r.TIMESTAMP_lOCAL.startsWith('2025-08-25')).forEach(r => {
        assert.ok(!r.gasCostEstimated, r.TIMESTAMP_lOCAL);
    });
    assert.strictEqual(out.filter(r => r.gasCostEstimated).length, 1);
});

test('spike year is replaced, other years are not', () => {
    const out = api.guardGasCost(fixture('financial-year.json'), fixture('powergas-year.json'));
    assert.deepStrictEqual(out.map(r => !!r.gasCostEstimated), [true, false, false, false]);
});

test('day rows are all plausible', () => {
    const out = api.guardGasCost(fixture('financial-day.json'), fixture('powergas-day.json'));
    assert.ok(out.every(r => !r.gasCostEstimated));
});

test('input rows are not mutated', () => {
    const input = fixture('financial-month.json');
    api.guardGasCost(input, fixture('powergas-month.json'));
    assert.ok(input.some(r => r.CONSUMPTION_COST_GAS > 8000));
});

test('without powergas data the rows pass through', () => {
    const input = fixture('financial-month.json');
    assert.strictEqual(api.guardGasCost(input, null), input);
    assert.strictEqual(api.guardGasCost(input, []).filter(r => r.gasCostEstimated).length, 0);
});

process.exit(failed ? 1 : 0);
