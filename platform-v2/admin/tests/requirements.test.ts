import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adminModules, globalRequirementIds, requirementIds } from '../src/domain/adminModules';

function listFiles(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const child = join(path, entry);
    return statSync(child).isDirectory() ? listFiles(child) : [child];
  });
}

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

  it('does not ship fixture records through production state modules', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const sourceFiles = listFiles(sourceRoot).filter((file) => /\.(?:ts|tsx)$/.test(file));
    const productionSource = sourceFiles
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    expect(sourceFiles.map((file) => file.slice(sourceRoot.length + 1))).not.toContainEqual(
      expect.stringMatching(/(?:^|\/)(?:fixtures?|mocks?)(?:\/|\.)/i),
    );
    expect(productionSource).not.toMatch(/(?:mock|fixture|sample)AdminRecords/);
    expect(productionSource).not.toContain('sampleOrderTxHash');
  });

  it('does not expose Merchant store-management calls from Admin production source', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const productionSource = listFiles(sourceRoot)
      .filter((file) => /\.(?:ts|tsx)$/.test(file))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    expect(productionSource).not.toContain('/v2/merchant/stores');
    expect(productionSource).not.toMatch(/(?:fetch|create|update|activate|close)MerchantStore/);
  });
});
