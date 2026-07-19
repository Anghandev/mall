export const mallBasePath = import.meta.env.BASE_URL;

export const coreApiBaseUrl = resolveCoreApiBaseUrl(
  import.meta.env.VITE_CORE_API_BASE_URL,
  import.meta.env.PROD,
);

export function resolveCoreApiBaseUrl(value: string | undefined, production: boolean) {
  return value?.trim().replace(/\/+$/, '') || (production ? '/core' : undefined);
}

export function brandAssetUrl(filename: string) {
  return joinBrandAssetUrl(mallBasePath, filename);
}

export function joinBrandAssetUrl(basePath: string, filename: string) {
  const base = `${basePath.replace(/\/+$/, '')}/`;
  const asset = filename.replace(/^\/+/, '');
  return `${base}brand/${asset}`;
}
