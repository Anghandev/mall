import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adminModules, globalRequirementIds, requirementIds } from '../src/domain/adminModules';

describe('platform requirement traceability', () => {
  it('maps every frozen admin requirement to a deterministic UI module', () => {
    const matrixPath = join(process.cwd(), 'docs/requirements/REQUIREMENTS_MATRIX.md');
    const matrix = readFileSync(matrixPath, 'utf8');
    const matrixIds = [...matrix.matchAll(/^\| (ADM-[A-Z]+-\d{3}) \|/gm)].map((match) => match[1]);
    const implementedIds = [...globalRequirementIds, ...requirementIds];

    expect(new Set(implementedIds).size).toBe(implementedIds.length);
    expect([...implementedIds].sort()).toEqual([...matrixIds].sort());
  });

  it('marks immutable surfaces so no soft-delete affordance is emitted', () => {
    const immutableIds = ['dashboard', 'policy', 'seckill', 'takeover', 'system', 'audit', 'clearing', 'operations', 'core'];
    for (const id of immutableIds) {
      expect(adminModules.find((module) => module.id === id)?.ordinarySoftDelete).not.toBe(true);
    }
  });
});
