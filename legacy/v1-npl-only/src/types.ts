export type FulfillmentMode = 'delivery' | 'pickup';
export type LedgerState = 'Locked' | 'Available' | 'PendingClaim' | 'Claimed' | 'Burned';

export type ProductSku = {
  id: string;
  name: string;
  settlementPriceNpl: number;
  stock: number;
};

export type Sku = ProductSku;

export type Product = {
  id: string;
  shopName: string;
  shopBadge: '24K' | '秒杀' | '自提' | '精选' | '限量' | '链上';
  title: string;
  sku: string;
  skus?: Sku[];
  imageUrl: string;
  imageTone: 'ceramic' | 'carry' | 'watch' | 'fragrance' | 'home' | 'jacket' | 'bottle';
  category: '精选' | '穿搭' | '居家' | '科技' | '香氛' | '食品' | '数码' | '运动';
  summary: string;
  priceNpl: number;
  originalPriceNpl?: number;
  bnmRebateRate: number;
  seckillLocked?: boolean;
  fulfillmentModes: FulfillmentMode[];
  adminRegionCode?: string;
  stock: number;
  sellerAddress: `0x${string}`;
  tags: string[];
};

export type CartItem = {
  productId: string;
  skuId?: string;
  skuName?: string;
  unitPriceNpl?: number;
  quantity: number;
  selected: boolean;
  fulfillmentMode?: FulfillmentMode;
  addressId?: string;
  storeId?: string;
  regionCode?: string;
};

export type MessageItem = {
  id: string;
  title: string;
  preview: string;
  date: string;
  unread?: number;
  tone: 'order' | 'escrow' | 'support' | 'system' | 'promo';
};

export type OrderStatus =
  | 'Draft'
  | 'AwaitingApproval'
  | 'Approved'
  | 'Funding'
  | 'PaidLocked'
  | 'AwaitingShipment'
  | 'Shipped'
  | 'PickupReady'
  | 'Completed'
  | 'Arbitration'
  | 'RefundRequested'
  | 'ForcedRefunded'
  | 'EmergencyRefunded'
  | 'Released'
  | 'Cancelled'
  | 'Claimed'
  | 'Failed';

export type Order = {
  id: string;
  orderId: string;
  buyerAddress: string;
  sellerAddress: string;
  amountNpl: string;
  fulfillmentMode?: FulfillmentMode;
  addressId?: string;
  storeId?: string;
  regionCode?: string;
  bnmLocked?: string;
  status: OrderStatus;
  txHash?: string;
  fundTxHash?: string;
  lastEventTxHash?: string;
  chainId: number;
  escrowAddress: string;
  orderDigest: string;
};

export type SeckillSession = {
  id: string;
  productId: string;
  status: 'upcoming' | 'live' | 'settling' | 'settled';
  startsAt: string;
  endsAt: string;
  mainSecondsLeft: number;
  relaySecondsLeft: number;
  relayExtendSeconds: number;
  prizePoolNpl: number;
  totalBuys: number;
  winnerAddress?: string;
  ruleVersion: string;
};

export type SeckillFeedItem = {
  id: string;
  address: string;
  text: string;
  createdAt: string;
  sessionId?: string;
  buyerAddress?: string;
  orderId?: string;
  txHash?: string;
  totalBuys?: number;
};

export type Store = {
  id: string;
  name: string;
  merchantAddress?: string;
  country: string;
  city: string;
  district: string;
  regionCode: string;
  address: string;
  distanceKm: number;
  hours: string;
  phone: string;
  lat: number;
  lng: number;
};

export type AddressBookEntry = {
  id: string;
  name: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  regionCode: string;
  isDefault: boolean;
};

export type AssetBucket = {
  id: 'bnm' | 'genesis-node' | 'referral-shop' | 'region-agent' | 'ops' | 'seckill-prize';
  title: string;
  assetSymbol: AssetSymbol;
  cumulative: number;
  available: number;
  locked: number;
  claimed?: number;
  burned?: number;
  pendingClaim?: number;
  visible: boolean;
  docsKey?: string;
  claimable?: boolean;
  claimEndpoint?: string;
  unlockPolicy?: string;
  visibility?: Record<string, unknown>;
  stateSummary?: Record<string, number>;
};

export type RewardLedgerEntry = {
  id: string;
  bucketId?: AssetBucket['id'];
  source: string;
  assetSymbol: AssetSymbol;
  amount: number;
  state: LedgerState;
  txHash?: string;
};

export type ClaimRecord = {
  id: string;
  rewardId?: string;
  bucketId: AssetBucket['id'] | 'merchant';
  assetSymbol: AssetSymbol;
  amount: number;
  status: 'pending' | 'success' | 'failed';
  txHash?: string;
  gasBnb?: number;
  expiresAt?: number;
  createdAt: string;
};

export type AssetSummary = {
  address?: string;
  addresses: AddressBookEntry[];
  buckets: AssetBucket[];
  ledger: RewardLedgerEntry[];
  claims: ClaimRecord[];
};

export type AssetSymbol = 'BNM' | 'NPL';

export type TabKey = 'seckill' | 'mall' | 'stores' | 'assets';
