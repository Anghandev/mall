import { products } from '../data/catalog';
import type { CartItem, Product } from '../types';

export function selectedCartTotal(items: CartItem[], productList: Product[] = products) {
  return items.reduce((sum, item) => {
    if (!item.selected) return sum;
    const product = productList.find((entry) => entry.id === item.productId);
    if (!product || product.stock <= 0) return sum;
    const skuPrice = product.skus?.find((sku) => sku.id === item.skuId)?.settlementPriceNpl;
    return sum + (item.unitPriceNpl ?? skuPrice ?? product.priceNpl) * item.quantity;
  }, 0);
}

export function formatNpl(value: number | string) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (numeric > 0 && numeric < 0.01) {
    return numeric.toLocaleString('zh-CN', {
      minimumFractionDigits: 6,
      maximumFractionDigits: 6
    });
  }
  return numeric.toLocaleString('zh-CN', {
    minimumFractionDigits: numeric >= 100 ? 0 : 2,
    maximumFractionDigits: 2
  });
}

export function shortAddress(address?: string) {
  if (!address) return '未连接';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
