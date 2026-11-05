import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tools.js';

test('loan_sync_147 failed reconciliation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loan-repro-'));
    const mapping = join(dir, 'portfolio-sync-targets.md');
    writeFileSync(mapping, '```json\n' + JSON.stringify({
        version: 1,
        targets: [
            { key: 'loans_primary', budget: 'primary', metric: 'account_balances', portfolio_account_id: 'portfolio-loan', actual_account_ids: ['loan-a', 'loan-b', 'loan-c'] },
        ],
    }) + '\n```\n');

    const balances = { 'loan-a': -200, 'loan-b': -150, 'loan-c': 25 };
    const bridge = {
        pull: async () => ({ status: 'ok' }),
        push: async () => ({ status: 'ok' }),
        getAccounts: async () => [{ id: 'portfolio-loan', currency: 'SGD' }],
        updateBalance: async () => ({ status: 'updated', delta: -3.25 }),
        queryTaxonomies: async () => ({ taxonomies: [] }),
        getStatus: async () => ({ summary: { currencies: {}, equity_currencies: {} } }),
    };
    globalThis.fetch = async (url) => {
        const { pathname, searchParams } = new URL(url);
        let data = { emergency_total: 0, investment_total: 0 };
        if (pathname === '/accounts') data = Object.keys(balances).map((id) => ({ id, offbudget: true }));
        if (pathname.startsWith('/accounts/balance/')) data = { balance: balances[pathname.split('/').pop()] };
        return { ok: true, status: 200, json: async () => data };
    };
    const registry = new ToolRegistry({
        primaryBudgetFile: 'primary',
        secondaryBudgetFile: 'secondary',
        syncTargetsFile: mapping,
    }, null, null, bridge);
    registry._exportTaxonomiesToSheet = async () => ({ status: 'skipped' });
    const result = await registry._computeSyncAll();
    const target = result.sync_targets.find((item) => item.name === 'Loan balance');
    assert.equal(target?.amount, -3.25);
}, { timeout: 15000 });
