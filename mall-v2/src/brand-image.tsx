import type { ImgHTMLAttributes } from 'react';

import { brandAssetUrl } from './deployment-paths';

type BrandImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet'> & {
  filename: string;
  webpFilename?: string;
};

export function BrandImage({ filename, webpFilename = toWebpFilename(filename), alt, ...props }: BrandImageProps) {
  return (
    <picture>
      <source srcSet={brandAssetUrl(webpFilename)} type="image/webp" />
      <img {...props} src={brandAssetUrl(filename)} alt={alt} />
    </picture>
  );
}

function toWebpFilename(filename: string) {
  return filename.replace(/\.(png|jpe?g)$/i, '.webp');
}
