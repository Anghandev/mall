import { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppKit, AppKitProvider, useAccount, useAppKit, useProvider } from '@reown/appkit-react-native';
import { appKit, BSC_CHAIN_ID, isWalletProjectConfigured } from './src/config/web3';
import { BottomTabs } from './src/components/BottomTabs';
import { CmsPlacements } from './src/components/CmsPlacements';
import { AssetsScreen } from './src/screens/AssetsScreen';
import { CartScreen } from './src/screens/CartScreen';
import { MallScreen } from './src/screens/MallScreen';
import { SeckillScreen } from './src/screens/SeckillScreen';
import { StoresScreen } from './src/screens/StoresScreen';
import { fetchAssetSummary } from './src/services/api';
import type { DappStore } from './src/services/api';
import { ensureBuyerSession } from './src/services/buyerAuth';
import type { WalletProvider } from './src/services/payment';
import { colors } from './src/theme/tokens';
import type { AddressBookEntry, CartItem, FulfillmentMode, Product, TabKey } from './src/types';

function MallApp() {
  const [tab, setTab] = useState<TabKey>('seckill');
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [mallNotice, setMallNotice] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState<AddressBookEntry | null>(null);
  const [pickupStore, setPickupStore] = useState<DappStore | null>(null);
  const [preferredFulfillmentMode, setPreferredFulfillmentMode] = useState<FulfillmentMode | null>(null);
  const [contentRegionCode, setContentRegionCode] = useState('');
  const manuallySelectedFulfillmentRef = useRef(false);
  const selectedWalletRef = useRef('');
  const { address, chainId, isConnected } = useAccount();
  const { provider } = useProvider();
  const { open, switchNetwork } = useAppKit();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const wallet = isConnected && address ? address.toLowerCase() : '';
    if (selectedWalletRef.current !== wallet) {
      selectedWalletRef.current = wallet;
      manuallySelectedFulfillmentRef.current = false;
      setDeliveryAddress(null);
      setPickupStore(null);
      setPreferredFulfillmentMode(null);
      setContentRegionCode('');
    }
    if (!wallet || !provider || !address) return;

    let active = true;
    ensureBuyerSession(provider as WalletProvider, address)
      .then((session) => fetchAssetSummary(address, session.token))
      .then((summary) => {
        if (!active || summary.address?.toLowerCase() !== wallet || manuallySelectedFulfillmentRef.current) return;
        const defaultAddress = summary.addresses.find((entry) => entry.isDefault) || null;
        setDeliveryAddress(defaultAddress);
        setPreferredFulfillmentMode(defaultAddress ? 'delivery' : null);
        setContentRegionCode(defaultAddress?.regionCode || '');
        if (defaultAddress) {
          setCartItems((current) => current.map((item) => item.fulfillmentMode === 'delivery' && !item.addressId ? {
            ...item,
            addressId: defaultAddress.id,
            regionCode: defaultAddress.regionCode
          } : item));
        }
      })
      .catch(() => {
        // The assets screen exposes the authenticated error and retry path when opened.
      });
    return () => { active = false; };
  }, [address, isConnected, provider]);

  function handleConnectPress() {
    open({ view: isConnected ? 'Account' : 'Connect' });
  }

  async function switchBsc() {
    await switchNetwork(`eip155:${BSC_CHAIN_ID}`);
  }

  function changeTab(nextTab: TabKey) {
    setCheckoutOpen(false);
    setTab(nextTab);
  }

  function addProductToCart(product: Product, selection: Partial<CartItem> = {}) {
    if (product.stock <= 0) {
      setMallNotice('该商品暂时无库存，无法加入终核清单。');
      return false;
    }
    setCartItems((current) => {
      const nextLine = { productId: product.id, ...selection };
      const nextKey = cartLineKey(nextLine);
      const exists = current.find((item) => cartLineKey(item) === nextKey);
      if (exists) {
        return current.map((item) => cartLineKey(item) === nextKey
          ? { ...item, ...selection, selected: true, quantity: Math.min(product.stock, selection.quantity ?? item.quantity + 1) }
          : item);
      }
      return [...current, { productId: product.id, quantity: 1, selected: true, ...selection }];
    });
    setMallNotice(`${product.title.slice(0, 18)} 已加入终核清单。`);
    return true;
  }

  function selectDeliveryAddress(entry: AddressBookEntry) {
    manuallySelectedFulfillmentRef.current = true;
    setDeliveryAddress(entry);
    setPreferredFulfillmentMode('delivery');
    setContentRegionCode(entry.regionCode);
    setCartItems((current) => current.map((item) => item.fulfillmentMode === 'delivery' ? {
      ...item,
      addressId: entry.id,
      regionCode: entry.regionCode
    } : item));
    setMallNotice(`已选择配送地址：${entry.name} · ${entry.regionCode}`);
    setTab('mall');
  }

  function selectPickupStore(store: DappStore) {
    manuallySelectedFulfillmentRef.current = true;
    setPickupStore(store);
    setPreferredFulfillmentMode('pickup');
    setContentRegionCode(store.regionCode);
    setCartItems((current) => current.map((item) => item.fulfillmentMode === 'pickup' ? {
      ...item,
      storeId: store.id,
      regionCode: store.regionCode
    } : item));
    setMallNotice(`已选择自提门店：${store.name} · ${store.regionCode}`);
    setTab('mall');
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.phoneShell}>
        <CmsPlacements regionCode={contentRegionCode || undefined} />
        <View style={styles.body}>
          {checkoutOpen ? (
            <CartScreen
              address={address}
              chainId={chainId}
              isConnected={isConnected}
              isProjectConfigured={isWalletProjectConfigured}
              provider={provider}
              items={cartItems}
              setItems={setCartItems}
              onConnectPress={handleConnectPress}
              onSwitchBsc={switchBsc}
              onBack={() => setCheckoutOpen(false)}
            />
          ) : null}
          {!checkoutOpen && tab === 'seckill' ? <SeckillScreen cartItems={cartItems} deliveryAddress={deliveryAddress} pickupStore={pickupStore} preferredFulfillmentMode={preferredFulfillmentMode} onAddToCart={addProductToCart} onOpenCheckout={() => setCheckoutOpen(true)} /> : null}
          {!checkoutOpen && tab === 'mall' ? <MallScreen cartItems={cartItems} notice={mallNotice} deliveryAddress={deliveryAddress} pickupStore={pickupStore} preferredFulfillmentMode={preferredFulfillmentMode} onAddToCart={addProductToCart} onOpenCheckout={() => setCheckoutOpen(true)} onOpenAssets={() => changeTab('assets')} onOpenStores={() => changeTab('stores')} /> : null}
          {!checkoutOpen && tab === 'stores' ? <StoresScreen selectedStoreId={pickupStore?.id} onSelectStore={selectPickupStore} /> : null}
          {!checkoutOpen && tab === 'assets' ? <AssetsScreen address={address} chainId={chainId} isConnected={isConnected} isProjectConfigured={isWalletProjectConfigured} selectedAddressId={deliveryAddress?.id} onConnectPress={handleConnectPress} onSelectAddress={selectDeliveryAddress} /> : null}
        </View>
        {!checkoutOpen ? (
          <View style={[styles.tabs, { paddingBottom: Math.max(insets.bottom, 8) }]}> 
            <BottomTabs active={tab} onChange={changeTab} />
          </View>
        ) : null}
      </View>
      <AppKit />
      <StatusBar style={tab === 'seckill' || tab === 'assets' ? 'light' : 'dark'} />
    </SafeAreaView>
  );
}


function cartLineKey(item: Partial<CartItem> & { productId?: string }) {
  return [
    item.productId || '',
    item.skuId || '',
    item.fulfillmentMode || '',
    item.addressId || '',
    item.storeId || '',
    item.regionCode || ''
  ].join('::');
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppKitProvider instance={appKit}>
        <MallApp />
      </AppKitProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.pageDeep
  },
  phoneShell: {
    flex: 1,
    backgroundColor: colors.page
  },
  body: {
    flex: 1
  },
  tabs: {
    backgroundColor: colors.surfaceDark
  }
});
