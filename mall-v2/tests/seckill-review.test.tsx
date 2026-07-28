import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { artifactVersion } from '@abu24k/core-artifacts';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import type { MallRuntimeValue } from '../src/mall-runtime';
import { seckillQuote } from './payment-fixtures';

const mocked = vi.hoisted(() => ({ runtime: null as MallRuntimeValue | null }));

vi.mock('../src/mall-runtime', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/mall-runtime')>();
  return { ...original, useMallRuntime: () => mocked.runtime! };
});

import { ReviewScreen } from '../src/screens';

describe('seckill signed quote review', () => {
  it('requires explicit acknowledgement of both prices and Router classification', async () => {
    const user = userEvent.setup();
    const quote = seckillQuote();
    const broadcastPayment = vi.fn().mockResolvedValue(undefined);
    mocked.runtime = {
      bootstrap: { artifactVersion, writesEnabled: true, runtimeBlockers: [], blockCode: null },
      catalog: [],
      catalogState: 'ready',
      categories: [],
      tags: [],
      taxonomyState: 'empty',
      stores: [],
      storesState: 'empty',
      checkoutTarget: null,
      seckillSession: null,
      seckillSessionState: 'empty',
      seckillHistory: [],
      seckillEvents: [],
      seckillRealtimeState: 'IDLE',
      seckillRealtimeError: null,
      selectedSeckillSessionId: null,
      orders: [],
      ordersState: 'idle',
      ordersNextCursor: null,
      orderActions: {},
      orderTargets: {},
      orderCapabilityErrors: {},
      takeoverTimelines: {},
      takeoverTimelineErrors: {},
      fulfillmentEvidenceStatus: 'AVAILABLE',
      buyerProfile: null,
      buyerProfileState: 'idle',
      buyerAvatarAccess: null,
      buyerAvatarState: 'idle',
      buyerOverview: null,
      buyerOverviewState: 'idle',
      buyerAddresses: [],
      buyerAddressesState: 'idle',
      shoppingStatements: [],
      shoppingStatementsState: 'idle',
      shoppingStatementsNextCursor: null,
      shoppingStatementsLoadingMore: false,
      shoppingStatementsError: null,
      settlements: null,
      settlementsState: 'idle',
      notifications: [],
      notificationsState: 'idle',
      notificationEndpoint: null,
      cmsItems: [],
      cmsState: 'empty',
      session: { token: 'session', walletAddress: quote.dual.seckill.buyer, roles: ['BUYER'] },
      selectedProduct: null,
      selectedSku: null,
      quantity: 1,
      fulfillmentMode: 'DELIVERY',
      quote,
      projection: null,
      approvals: quote.approvalRequirements.map(() => ({ currentAllowance: '999', sufficient: true })),
      pendingSubmission: null,
      submittedTxHash: null,
      busy: false,
      error: null,
      walletWritesAuthorized: true,
      supportUrl: null,
      supportConfigurationError: 'ConfigurationRequired：客服入口未配置',
      connectWallet: vi.fn(),
      reloadCatalog: vi.fn(),
      reloadTaxonomy: vi.fn(),
      resolvePublicMedia: vi.fn(),
      reloadSeckill: vi.fn(),
      selectSeckillSession: vi.fn(),
      reloadStores: vi.fn(),
      createPickupTarget: vi.fn(),
      reloadOrders: vi.fn(),
      loadMoreOrders: vi.fn(),
      submitBuyerAction: vi.fn(),
      reloadBuyerAccount: vi.fn(),
      saveBuyerProfile: vi.fn(),
      createBuyerAddress: vi.fn(),
      updateBuyerAddress: vi.fn(),
      deleteBuyerAddress: vi.fn(),
      setDefaultBuyerAddress: vi.fn(),
      selectSavedAddress: vi.fn(),
      reloadShoppingStatements: vi.fn(),
      loadMoreShoppingStatements: vi.fn(),
      reloadSettlements: vi.fn(),
      requestSettlement: vi.fn(),
      reloadNotifications: vi.fn(),
      enableInAppNotifications: vi.fn(),
      reloadCms: vi.fn(),
      selectProduct: vi.fn(),
      selectSku: vi.fn(),
      setQuantity: vi.fn(),
      setFulfillmentMode: vi.fn(),
      requestOrdinaryQuote: vi.fn(),
      requestSeckillQuote: vi.fn(),
      broadcastPayment,
      retrySubmission: vi.fn(),
      refreshPayment: vi.fn(),
      revokeApproval: vi.fn(),
      clearError: vi.fn(),
    };

    render(<MemoryRouter><ReviewScreen /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '秒杀与日常备用报价' })).toBeTruthy();
    expect(screen.getByText(/付款在活动时间内/)).toBeTruthy();
    expect(screen.getByText(/付款超过活动截止/)).toBeTruthy();
    expect(screen.getByText(/是否命中秒杀只看奖金付款时间/)).toBeTruthy();
    const payButton = screen.getByRole('button', { name: /确认支付/ });
    expect(payButton.hasAttribute('disabled')).toBe(true);

    await user.click(screen.getByRole('checkbox', { name: /我已核对秒杀价和截止后普通价/ }));
    expect(payButton.hasAttribute('disabled')).toBe(false);
    await user.click(payButton);
    expect(broadcastPayment).toHaveBeenCalledWith(false, true);
  });
});
