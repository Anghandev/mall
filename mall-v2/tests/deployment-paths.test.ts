import { joinBrandAssetUrl, resolveCoreApiBaseUrl } from '../src/deployment-paths';

describe('Mall deployment paths', () => {
  it('keeps public brand assets under the configured base without duplicate slashes', () => {
    expect(joinBrandAssetUrl('/mall/', '/logo-mark.png')).toBe('/mall/brand/logo-mark.png');
  });

  it('uses /core for production while allowing an explicit Core override', () => {
    expect(resolveCoreApiBaseUrl(undefined, true)).toBe('/core');
    expect(resolveCoreApiBaseUrl('/core/', true)).toBe('/core');
    expect(resolveCoreApiBaseUrl('https://core.mall.test/', true)).toBe('https://core.mall.test');
    expect(resolveCoreApiBaseUrl(undefined, false)).toBeUndefined();
  });
});
