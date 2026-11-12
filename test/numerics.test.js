import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarize } from '../src/domain.js';

const seed = JSON.parse(await readFile('data/records.json', 'utf8')).records[0];
const probe = patches => summarize(patches.map((patch, index) => ({...seed, id: `p${index}`, ...patch}))).groups[0];

test('触达核对只数显式转化触点，不把路径频次当转化标志', () => {

  assert.equal(probe([{converted: false, weight: 20}, {converted: true, weight: 3}]).convertedTouches, 1);
  assert.equal(probe([{converted: false}]).convertedTouches, 0);
});
