import { Image, StyleSheet, View, type ImageSourcePropType } from 'react-native';
import { colors, radius } from '../theme/tokens';
import type { Product } from '../types';

const imageMap: Record<Product['imageTone'], ImageSourcePropType> = {
  ceramic: require('../../assets/products/24k-ceramic-diffuser.png'),
  carry: require('../../assets/products/24k-carryall.png'),
  watch: require('../../assets/products/24k-phone.png'),
  fragrance: require('../../assets/products/24k-tea-box.png'),
  home: require('../../assets/products/24k-home-console.png'),
  jacket: require('../../assets/products/24k-runner.png'),
  bottle: require('../../assets/products/24k-steel-bottle.png')
};

export const heroBannerSource = require('../../assets/products/24k-market-banner.png');

export type ProductThumbProps = {
  product?: Product;
  size?: number;
  logo?: boolean;
  radiusSize?: number;
};

export function ProductThumb({ product, size = 92, logo = false, radiusSize = radius.md }: ProductThumbProps) {
  const source = logo ? require('../../assets/products/24k-logo-mark.png') : imageMap[product?.imageTone || 'ceramic'];
  return (
    <View style={[styles.frame, { width: size, height: size, borderRadius: logo ? radius.round : radiusSize }]}> 
      <Image source={source} resizeMode="cover" style={styles.image} accessibilityLabel={logo ? '24K 商城 logo' : product?.title || '24K 商品图片'} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    backgroundColor: colors.surfaceMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(11,17,28,0.10)'
  },
  image: {
    width: '100%',
    height: '100%'
  }
});
