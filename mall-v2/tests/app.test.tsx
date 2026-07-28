import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  allowedActionNames,
  artifactVersion,
  chainIdentity,
  executableOrderActionNames,
  type NotificationInboxItem,
  type PaymentQuoteResponse,
} from '@abu24k/core-artifacts';
import { Interface } from 'ethers';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import { MallApp, mallRuntimeBoundary } from '../src/App';
import { isCoreOrderActionExecutable, productBaseline } from '../src/bootstrap';
import { CoreClientError, type CoreClient, type CorePaymentAvailability, type PublishedSeckillSessionProjection } from '../src/core-client';
import { MallRuntimeProvider, useMallRuntime, validateSupportUrl, type MallServices, type PendingSubmission } from '../src/mall-runtime';
import type { WalletGateway } from '../src/wallet';
import { catalogCategories, catalogTags, publicMediaAccess } from './catalog-fixtures';
import {
  authenticatedAvatarAccess,
  avatarAssetId,
  avatarContentHash,
  avatarUploadIntent,
  buyerOverview,
  buyerProfile,
  buyerSavedAddress,
  buyerTakeoverTimeline,
  parsedBuyerAddress,
  verifiedAvatarAsset,
} from './account-fixtures';
import {
  buyerActionResult,
  evidenceAssetId,
  evidenceFileHash,
  mediaUploadIntent,
  orderActionEvidence,
  orderEvidenceHash,
  verifiedEvidenceAsset,
} from './evidence-fixtures';
import {
  deliveryActions,
  deliveryOrder,
  deliveryOrderTarget,
  deliveryTarget,
  pickupTarget,
  store,
  storeImageAssetIds,
} from './fulfillment-fixtures';
import { paymentQuote, product, seckillQuote } from './payment-fixtures';
import {
  approvedPrizeSettlement,
  relayEvent,
  reviewPendingPrizeSettlement,
  rolledOverPrizeSettlement,
  seckillCandidateOrderId,
  seckillGovernanceActionId,
  seckillPrizeExecutionTxHash,
  seckillPublicationTxHash,
  seckillRulesContentHash,
  seckillSession,
  seckillSessionId,
} from './seckill-fixtures';
import {
  finalExecutionTxHash,
  notificationItem,
  prizeSettlementIntent,
  publicCmsItem,
  requestedSettlement,
  settlementIntent,
  settlementProjection,
  settlementTransferId,
} from './settlement-fixtures';
import {
  firstShoppingStatementPage,
  fallbackShoppingStatement,
  ordinaryShoppingStatement,
  secondShoppingStatementPage,
} from './shopping-statement-fixtures';

function renderAt(path = '/seckill', services = offlineServices()) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MallApp services={services} />
    </MemoryRouter>,
  );
}

function shortHashForTest(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function NotificationConnectionProbe() {
  const runtime = useMallRuntime();
  return (
    <div>
      <button type="button" onClick={() => void runtime.connectWallet()}>连接测试钱包</button>
      <button type="button" onClick={() => void runtime.reloadNotifications()}>刷新测试通知</button>
      <span data-testid="notification-state">{runtime.notificationsState}</span>
      {runtime.notifications.map((item) => <span key={item.messageId}>{item.messageId}</span>)}
    </div>
  );
}

describe('Mall V2 payment consumer', () => {
  it('consumes the current coordinated Core checkpoint and keeps deployment authorization external', async () => {
    renderAt('/mall');

    expect(screen.getByRole('link', { name: '24K商城首页' })).toBeTruthy();
    expect(screen.getByText('24K商城', { selector: '.brand strong' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/阿步|Abu 24K|ABU 24K/);
    expect(productBaseline.coreArtifacts).toBe(artifactVersion);
    expect(artifactVersion).toBe('2.0.0-fulfillment-launch.30');
    expect(productBaseline.manifestsAligned).toBe(true);
    expect(productBaseline.knownOrderActions).toBe(allowedActionNames);
    expect(productBaseline.executableOrderActions).toBe(executableOrderActionNames);
    expect(executableOrderActionNames).toContain('CONFIRM_RECEIPT');
    expect(executableOrderActionNames).toContain('PAY_ORDER');
    expect(isCoreOrderActionExecutable('CONFIRM_RECEIPT')).toBe(true);
    expect(isCoreOrderActionExecutable('PAY_ORDER')).toBe(true);
    expect(mallRuntimeBoundary).toMatchObject({
      artifactStatus: '2.0.0-fulfillment-launch.30',
      executableOrderActions: executableOrderActionNames,
      deploymentAuthorized: false,
      settlementAdminCapabilities: {
        settlements: true,
        cms: true,
        notifications: true,
        seckillSessions: true,
        websocket: true,
      },
      sharedInterface: '@abu24k/core-artifacts',
    });
    await waitFor(() => expect(screen.getByText('暂无可买商品')).toBeTruthy());
  });

  it('renders public taxonomy and short-lived Core media without constructing provider URLs', async () => {
    const user = userEvent.setup();
    const createPublicMediaReadAccess = vi.fn((assetId: string) => Promise.resolve(publicMediaAccess(assetId)));
    const services = readyServices({ createPublicMediaReadAccess });
    renderAt('/mall', services);

    expect(await screen.findByRole('heading', { name: product.title })).toBeTruthy();
    expect(screen.getByText('鞋履')).toBeTruthy();
    expect(screen.getByText('运动鞋')).toBeTruthy();
    expect(screen.getByText('黑金', { selector: '.taxonomy-strip span' })).toBeTruthy();
    expect(screen.getByText(product.subtitle)).toBeTruthy();
    expect(screen.getAllByText(/10\.00 USDT|80\.00 USDT/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/USDT 原子单位/);
    expect(screen.getByText(/秒杀进行中/)).toBeTruthy();
    expect(screen.getByText(/秒杀进行中，普通购买暂停，前往秒杀/)).toBeTruthy();
    const productImage = await screen.findByRole('img', { name: product.title });
    expect(productImage.getAttribute('src')).toBe(publicMediaAccess(product.mainImageAssetIds[0]!).readUrl);
    expect(createPublicMediaReadAccess).toHaveBeenCalledWith(product.mainImageAssetIds[0]!.toLowerCase());
    expect(document.body.textContent).not.toMatch(/CDN|OSS|分类稍后批次发布/);

    await user.click(screen.getByRole('link', { name: `查看 ${product.title} 商品详情` }));
    expect(screen.getByRole('heading', { name: '商品详情' })).toBeTruthy();
    expect(screen.getByText('黑金鞋面，轻量缓震结构。')).toBeTruthy();
    expect(screen.getByText(/41码 \/ 秒杀黑金/)).toBeTruthy();
    expect(screen.getByText(/普通结算禁用/)).toBeTruthy();
    const productVideo = await screen.findByLabelText(`${product.title} 商品视频`);
    expect(productVideo.tagName).toBe('VIDEO');
    expect(productVideo.getAttribute('src')).toBe(publicMediaAccess(product.videoAssetId!).readUrl);
    expect(createPublicMediaReadAccess).toHaveBeenCalledWith(product.videoAssetId!.toLowerCase());
  });

  it('filters products only by the published category and tag associations', async () => {
    const user = userEvent.setup();
    const uncategorized = {
      ...product,
      productId: 'product-uncategorized',
      chainProductId: `0x${'d'.repeat(64)}`,
      title: '未分类商品',
      subtitle: '',
      mainImageAssetIds: [],
      videoAssetId: null,
      categoryId: null,
      tagIds: [],
      skus: [{ ...product.skus[0]!, skuId: 'sku-uncategorized', chainSkuId: `0x${'7'.repeat(64)}` }],
    };
    renderAt('/mall', readyServices({ listCatalog: vi.fn().mockResolvedValue([product, uncategorized]) }));

    expect(await screen.findByRole('heading', { name: '未分类商品' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '运动鞋' }));
    expect(screen.getByRole('heading', { name: product.title })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '未分类商品' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '黑金' }));
    expect(screen.getByRole('heading', { name: product.title })).toBeTruthy();
  });

  it('fails media closed when the signed read target is bound to another product', async () => {
    const mismatched = {
      ...publicMediaAccess(product.mainImageAssetIds[0]!),
      resourceId: 'another-product',
    };
    renderAt('/mall', readyServices({
      createPublicMediaReadAccess: vi.fn((assetId: string) => Promise.resolve(
        assetId === product.mainImageAssetIds[0] ? mismatched : publicMediaAccess(assetId),
      )),
    }));

    expect(await screen.findByRole('button', { name: '重新加载图片' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: product.title })).toBeNull();
  });

  it('rejects a product video read target with an image purpose and content type', async () => {
    const user = userEvent.setup();
    renderAt('/mall', readyServices({
      createPublicMediaReadAccess: vi.fn((assetId: string) => {
        const access = publicMediaAccess(assetId);
        return Promise.resolve(assetId === product.videoAssetId
          ? { ...access, purpose: 'PRODUCT_IMAGE' as const, contentType: 'image/webp' as const }
          : access);
      }),
    }));

    await user.click(await screen.findByRole('link', { name: `查看 ${product.title} 商品详情` }));
    expect(await screen.findByRole('button', { name: '重新加载视频' })).toBeTruthy();
    expect(screen.queryByLabelText(`${product.title} 商品视频`)).toBeNull();
  });

  it('keeps all five primary tabs reachable and preserves the existing shell', async () => {
    const user = userEvent.setup();
    renderAt();

    const navigation = screen.getByRole('navigation', { name: '主要导航' });
    const labels = ['秒杀', '商城', '门店', '爆区块', '资产'];
    for (const label of labels) {
      expect(within(navigation).getByRole('link', { name: label })).toBeTruthy();
    }
    expect(Array.from(navigation.querySelectorAll('a')).map((link) => link.textContent?.trim())).toEqual(labels);
    await user.click(within(navigation).getByRole('link', { name: '爆区块' }));
    expect(screen.getByRole('heading', { name: '爆区块' })).toBeTruthy();
    expect(screen.getByText(/DEFI共识顶层逻辑/)).toBeTruthy();
    const accountHeading = screen.getByRole('heading', { name: '我的本金权重' });
    const nextHeading = screen.getByRole('heading', { name: '下一次爆区块' });
    expect(Boolean(accountHeading.compareDocumentPosition(nextHeading) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('fails the block burst page closed until a production contract is configured', () => {
    renderAt('/block-blast');

    expect(screen.getByRole('heading', { name: '爆区块' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '生产合约未配置' })).toBeTruthy();
    expect(screen.getByText(/测试入口不作为生产入口/)).toBeTruthy();
    for (const label of ['打入 NPL', '领取本金', '领取奖励', '爆区块']) {
      expect(screen.getByRole('button', { name: label }).hasAttribute('disabled')).toBe(true);
    }
  });

  it('reads configured block burst pool and wallet state without Core coupling', async () => {
    const user = userEvent.setup();
    vi.stubEnv('VITE_BLOCK_BURST_CHAIN_ID', '56');
    vi.stubEnv('VITE_BLOCK_BURST_NPL_TOKEN', BLOCK_BURST_NPL);
    vi.stubEnv('VITE_BLOCK_BURST_PROXY', BLOCK_BURST_PROXY);
    vi.stubEnv('VITE_BLOCK_BURST_RPC_URL', '/block-burst/rpc');
    vi.stubEnv('VITE_BLOCK_BURST_ENABLE_WRITES', 'false');
    const fetchSpy = mockBlockBurstRpc({ wallet: BLOCK_BURST_GUEST });
    const authenticate = vi.fn().mockRejectedValue(new Error('Core login blocked'));
    const previousEthereum = (globalThis as typeof globalThis & { ethereum?: unknown }).ethereum;
    Object.defineProperty(globalThis, 'ethereum', {
      configurable: true,
      value: {
        request: vi.fn(async ({ method }: { method: string }) => {
          if (method === 'eth_chainId') return '0x38';
          if (method === 'eth_requestAccounts') return [BLOCK_BURST_GUEST];
          throw new Error(`unexpected wallet method ${method}`);
        }),
      },
    });

    try {
      renderAt('/block-blast', readyServices({ authenticate }));

      const nextSection = screen.getByRole('heading', { name: '下一次爆区块' }).closest('section')!;
      expect(await within(nextSection).findByLabelText('当前期数2 / 10')).toBeTruthy();
      expect(within(nextSection).getByLabelText('已入本金150.00 NPL')).toBeTruthy();
      expect(within(nextSection).getByLabelText('本期目标200 万亿')).toBeTruthy();
      expect(within(nextSection).getByLabelText('本期进度 0%')).toBeTruthy();
      expect(within(nextSection).getByText('暂停中')).toBeTruthy();

      await user.click(screen.getByRole('button', { name: '连接爆区块钱包' }));
      expect(authenticate).not.toHaveBeenCalled();
      expect(await screen.findByRole('button', { name: '切换爆区块钱包' })).toBeTruthy();
      const accountSection = screen.getByRole('heading', { name: '我的本金权重' }).closest('section')!;
      expect(await within(accountSection).findByLabelText('未领取本金25.00 NPL')).toBeTruthy();
      expect(within(accountSection).getByLabelText('待领奖励3.00 NPL')).toBeTruthy();
      expect(within(accountSection).getByLabelText('本金单数1')).toBeTruthy();
      expect(await screen.findByText('本金单 #7')).toBeTruthy();
      expect(fetchSpy).toHaveBeenCalled();
      const rpcCalls = fetchSpy.mock.calls.map((call) => JSON.parse(String(call[1]?.body ?? '{}')) as { method: string; params?: [{ to?: string }] });
      expect(new Set(rpcCalls.map((call) => call.method))).toEqual(new Set(['eth_chainId', 'eth_call']));
      expect(rpcCalls.filter((call) => call.method === 'eth_call').every((call) => call.params?.[0]?.to?.toLowerCase() === BLOCK_BURST_PROXY.toLowerCase())).toBe(true);
      expect(fetchSpy.mock.calls.every((call) => call[0] === '/block-burst/rpc')).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      if (previousEthereum === undefined) {
        Reflect.deleteProperty(globalThis, 'ethereum');
      } else {
        Object.defineProperty(globalThis, 'ethereum', { configurable: true, value: previousEthereum });
      }
      vi.unstubAllEnvs();
    }
  });

  it('colors the block burst tank by live progress thresholds', async () => {
    vi.stubEnv('VITE_BLOCK_BURST_CHAIN_ID', '56');
    vi.stubEnv('VITE_BLOCK_BURST_NPL_TOKEN', BLOCK_BURST_NPL);
    vi.stubEnv('VITE_BLOCK_BURST_PROXY', BLOCK_BURST_PROXY);
    vi.stubEnv('VITE_BLOCK_BURST_RPC_URL', '/block-burst/rpc');
    vi.stubEnv('VITE_BLOCK_BURST_ENABLE_WRITES', 'false');
    const fetchSpy = mockBlockBurstRpc({
      activePrincipal: blockBurstNpl(140_000_000_000_000n),
      currentTarget: blockBurstNpl(200_000_000_000_000n),
    });

    try {
      renderAt('/block-blast', readyServices());

      const tank = await screen.findByLabelText('本期进度 70%');
      expect(tank.className).toContain('block-burst-tank--green');
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('enables block burst approve and deposit only after explicit production write config', async () => {
    const user = userEvent.setup();
    vi.stubEnv('VITE_BLOCK_BURST_CHAIN_ID', '56');
    vi.stubEnv('VITE_BLOCK_BURST_NPL_TOKEN', BLOCK_BURST_NPL);
    vi.stubEnv('VITE_BLOCK_BURST_PROXY', BLOCK_BURST_PROXY);
    vi.stubEnv('VITE_BLOCK_BURST_RPC_URL', '/block-burst/rpc');
    vi.stubEnv('VITE_BLOCK_BURST_ENABLE_WRITES', 'true');
    let allowance = 0n;
    const fetchSpy = mockBlockBurstRpc({
      wallet: BLOCK_BURST_GUEST,
      getAllowance: () => allowance,
      getBalance: () => blockBurstNpl(50n),
    });
    const sentTransactions: { from: string; to: string; data: string }[] = [];
    const previousEthereum = (globalThis as typeof globalThis & { ethereum?: unknown }).ethereum;
    Object.defineProperty(globalThis, 'ethereum', {
      configurable: true,
      value: {
        request: vi.fn(async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
          if (method === 'eth_chainId') return '0x38';
          if (method === 'eth_requestAccounts') return [BLOCK_BURST_GUEST];
          if (method === 'eth_sendTransaction') {
            const tx = params?.[0] as { from: string; to: string; data: string };
            sentTransactions.push(tx);
            if (tx.to.toLowerCase() === BLOCK_BURST_NPL.toLowerCase()) {
              allowance = blockBurstNpl(10n);
              return BLOCK_BURST_APPROVE_TX;
            }
            return BLOCK_BURST_DEPOSIT_TX;
          }
          throw new Error(`unexpected wallet method ${method}`);
        }),
      },
    });

    try {
      const authenticate = vi.fn().mockRejectedValue(new Error('Core login blocked'));
      renderAt('/block-blast', readyServices({ authenticate }));

      await user.click(screen.getByRole('button', { name: '连接爆区块钱包' }));
      expect(authenticate).not.toHaveBeenCalled();
      expect(await screen.findByLabelText('未领取本金25.00 NPL')).toBeTruthy();
      expect(await screen.findByText('钱包余额')).toBeTruthy();
      await user.type(screen.getByLabelText('打入 NPL 数量'), '1.25');
      await user.click(screen.getByRole('button', { name: /授权并打入 NPL|打入 NPL/ }));

      expect(await screen.findByText(/已打入 1.25 NPL/)).toBeTruthy();
      expect(sentTransactions).toHaveLength(2);
      expect(sentTransactions[0]?.from.toLowerCase()).toBe(BLOCK_BURST_GUEST.toLowerCase());
      expect(sentTransactions[0]?.to.toLowerCase()).toBe(BLOCK_BURST_NPL.toLowerCase());
      expect(sentTransactions[0]?.data.startsWith(blockBurstTokenInterface.getFunction('approve')!.selector)).toBe(true);
      expect(sentTransactions[1]?.to.toLowerCase()).toBe(BLOCK_BURST_PROXY.toLowerCase());
      expect(sentTransactions[1]?.data.startsWith(blockBurstTestInterface.getFunction('deposit')!.selector)).toBe(true);
      expect(fetchSpy.mock.calls.some((call) => JSON.parse(String(call[1]?.body ?? '{}')).method === 'eth_getTransactionReceipt')).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      if (previousEthereum === undefined) {
        Reflect.deleteProperty(globalThis, 'ethereum');
      } else {
        Object.defineProperty(globalThis, 'ethereum', { configurable: true, value: previousEthereum });
      }
      vi.unstubAllEnvs();
    }
  });

  it('renders the real buyer profile, UID and canonical overview counts', async () => {
    const user = userEvent.setup();
    renderAt('/assets', readyServices({
      getBuyerProfile: vi.fn().mockResolvedValue(buyerProfile),
      getBuyerOverview: vi.fn().mockResolvedValue(buyerOverview),
    }));

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect(await screen.findByRole('heading', { name: buyerProfile.nickname! })).toBeTruthy();
    expect(screen.getByText('账号编号：10001')).toBeTruthy();
    expect(screen.getByText('--', { selector: '.order-status-item strong' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('DecisionBlocked');
    expect(screen.getByText('2', { selector: '.order-status-item strong' })).toBeTruthy();
    expect(screen.getByText('3', { selector: '.order-status-item strong' })).toBeTruthy();
    expect(screen.getByText('1', { selector: '.order-status-item strong' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '收益概览' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'BNM 积分' })).toBeTruthy();
    expect(screen.getByText(/履约完成后会从锁定变为可用积分/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(deliveryOrder.buyerWallet);
  });

  it('summarizes Core reward ledgers into total, available and locked states', async () => {
    const user = userEvent.setup();
    renderAt('/assets', readyServices({
      getBuyerOverview: vi.fn().mockResolvedValue(buyerOverview),
      listSettlements: vi.fn().mockResolvedValue(settlementProjection),
    }));

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    const summary = await screen.findByRole('heading', { name: '收益概览' });
    const panel = summary.closest('section')!;
    const bnm = within(panel).getByRole('heading', { name: 'BNM 积分' }).closest('article')!;
    expect(within(bnm).getAllByText('<0.01 BNM')).toHaveLength(3);
    expect(document.body.textContent).not.toMatch(/BNM 原子单位/);

    const genesis = within(panel).getByRole('heading', { name: '创世节点 NPL' }).closest('article')!;
    expect(within(genesis).getAllByText('<0.01 NPL')).toHaveLength(2);
    expect(within(genesis).getByText('0.00 NPL')).toBeTruthy();

    const regional = within(panel).getByRole('heading', { name: '区域代理 NPL' }).closest('article')!;
    expect(within(regional).getAllByText('<0.01 NPL')).toHaveLength(2);
    expect(within(regional).getByText('0.00 NPL')).toBeTruthy();
  });

  it('labels seckill and shopping counts as loaded-page statistics without placeholders', async () => {
    const user = userEvent.setup();
    const seckillOrder = { ...deliveryOrder, orderId: `0x${'e'.repeat(64)}`, orderKind: 'SECKILL' as const };
    renderAt('/assets', readyServices({
      getBuyerOverview: vi.fn().mockResolvedValue(buyerOverview),
      listOrders: vi.fn().mockResolvedValue({ orders: [deliveryOrder, seckillOrder], nextCursor: null }),
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
    }));

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    const tracking = (await screen.findByRole('heading', { name: '我的记录' })).closest('section')!;
    expect(within(tracking).queryByText('--')).toBeNull();
    expect(within(tracking).getAllByText('1')).toHaveLength(2);
    expect(within(tracking).getAllByText('已加载')).toHaveLength(2);
  });

  it.each(['DecisionBlocked', 'ExternalBlocked', 'ConfigurationRequired'] as const)(
    'renders only the Core %s payment readiness reason',
    async (blockCode) => {
      const user = userEvent.setup();
      renderAt('/mall', readyServices({
        getBootstrap: vi.fn().mockResolvedValue({
          artifactVersion,
          writesEnabled: false,
          runtimeBlockers: ['SIGNER_UNAVAILABLE'],
          blockCode,
        }),
      }));

      await screen.findByRole('heading', { name: product.title });
      await openProductCheckout(user);
      expect(screen.getByRole('heading', { name: '新支付当前已安全停用' })).toBeTruthy();
      expect(screen.getByText('系统当前阻止新支付，暂不创建新报价。')).toBeTruthy();
      expect(document.body.textContent).not.toContain(blockCode);
      expect(screen.queryByText('SIGNER_UNAVAILABLE')).toBeNull();
    },
  );

  it('updates nickname only after a verified buyer avatar upload', async () => {
    const user = userEvent.setup();
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'avatar.png', { type: 'image/png' });
    const intent = avatarUploadIntent();
    const asset = verifiedAvatarAsset();
    const updated = { ...buyerProfile, nickname: '新昵称', avatarAssetId, version: 3 };
    const createMediaUploadIntent = vi.fn<CoreClient['createMediaUploadIntent']>().mockResolvedValue(intent);
    const uploadMediaFile = vi.fn<CoreClient['uploadMediaFile']>().mockResolvedValue(undefined);
    const completeMediaUpload = vi.fn<CoreClient['completeMediaUpload']>().mockResolvedValue(asset);
    const updateBuyerProfile = vi.fn<CoreClient['updateBuyerProfile']>().mockResolvedValue(updated);
    const services = readyServices({
      getBuyerProfile: vi.fn().mockResolvedValue(buyerProfile),
      getBuyerOverview: vi.fn().mockResolvedValue(buyerOverview),
      createMediaUploadIntent,
      uploadMediaFile,
      completeMediaUpload,
      updateBuyerProfile,
      createAuthenticatedMediaReadAccess: vi.fn().mockResolvedValue(authenticatedAvatarAccess()),
    });
    services.hashEvidenceFile = vi.fn().mockResolvedValue(avatarContentHash);
    renderAt('/assets', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await user.click(await screen.findByRole('button', { name: '编辑买家资料' }));
    await user.clear(screen.getByLabelText('昵称'));
    await user.type(screen.getByLabelText('昵称'), '新昵称');
    await user.upload(screen.getByLabelText(/^头像文件/), file);
    await user.click(screen.getByRole('button', { name: /保存资料/ }));

    expect(await screen.findByRole('heading', { name: '新昵称' })).toBeTruthy();
    expect(createMediaUploadIntent).toHaveBeenCalledWith('buyer-session', expect.objectContaining({
      purpose: 'BUYER_AVATAR',
      resourceType: 'BUYER',
      resourceId: BUYER,
      contentType: 'image/png',
      sizeBytes: 4,
      contentSha256: avatarContentHash,
    }));
    expect(uploadMediaFile).toHaveBeenCalledWith(intent, file);
    expect(completeMediaUpload).toHaveBeenCalledWith('buyer-session', intent.uploadIntentId);
    expect(updateBuyerProfile).toHaveBeenCalledWith('buyer-session', {
      nickname: '新昵称',
      avatarAssetId,
      expectedVersion: buyerProfile.version,
      idempotencyKey: 'mall-test-idempotency',
    });
    expect((await screen.findByRole('img', { name: '买家头像' })).getAttribute('src')).toBe(authenticatedAvatarAccess().readUrl);
  });

  it('creates and edits a manual address without map services, then binds the saved target', async () => {
    const user = userEvent.setup();
    let addresses = [{ ...buyerSavedAddress, isDefault: false }];
    const createBuyerAddress = vi.fn<CoreClient['createBuyerAddress']>().mockImplementation(async (_token, request) => {
      const created = { ...buyerSavedAddress, label: request.label, isDefault: request.isDefault };
      addresses = [created];
      return created;
    });
    const updateBuyerAddress = vi.fn<CoreClient['updateBuyerAddress']>().mockImplementation(async (_token, _id, request) => {
      addresses = [{ ...addresses[0]!, ...request, version: 4 }];
      return addresses[0]!;
    });
    const setDefaultBuyerAddress = vi.fn<CoreClient['setDefaultBuyerAddress']>().mockImplementation(async () => {
      addresses = [{ ...addresses[0]!, isDefault: true, version: 5 }];
      return addresses[0]!;
    });
    const deleteBuyerAddress = vi.fn<CoreClient['deleteBuyerAddress']>().mockImplementation(async () => { addresses = []; });
    const createBuyerAddressTarget = vi.fn<CoreClient['createBuyerAddressTarget']>().mockResolvedValue(deliveryTarget);
    const services = readyServices({
      getBuyerProfile: vi.fn().mockResolvedValue(buyerProfile),
      getBuyerOverview: vi.fn().mockResolvedValue(buyerOverview),
      listBuyerAddresses: vi.fn().mockImplementation(async () => addresses),
      createBuyerAddress,
      updateBuyerAddress,
      setDefaultBuyerAddress,
      deleteBuyerAddress,
      createBuyerAddressTarget,
    });
    renderAt('/assets/addresses', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    const form = screen.getByRole('form', { name: '新增收货地址' });
    await user.type(within(form).getByLabelText('收货人'), '张三');
    await user.type(within(form).getByLabelText('手机号'), '13800138000');
    await user.type(within(form).getByLabelText('省份'), '辽宁省');
    await user.type(within(form).getByLabelText('城市'), '大连市');
    await user.type(within(form).getByLabelText('区县'), '中山区');
    await user.type(within(form).getByLabelText('六位行政区代码'), '210202');
    await user.type(within(form).getByLabelText('详细地址'), '示例路 24 号');
    await user.click(within(form).getByRole('button', { name: /保存地址/ }));
    await waitFor(() => expect(createBuyerAddress).toHaveBeenCalledTimes(1));
    expect(createBuyerAddress).toHaveBeenCalledWith('buyer-session', expect.objectContaining({
      recipientName: '张三',
      phone: '13800138000',
      province: '辽宁省',
      city: '大连市',
      district: '中山区',
      regionCode: '210202',
      detailAddress: '示例路 24 号',
      longitude: null,
      latitude: null,
    }));

    await user.click(screen.getByRole('button', { name: '用于下单' }));
    expect(createBuyerAddressTarget).toHaveBeenCalledWith('buyer-session', buyerSavedAddress.addressId, 'mall-test-idempotency');
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.clear(screen.getByLabelText('标签'));
    await user.type(screen.getByLabelText('标签'), '公司');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(updateBuyerAddress).toHaveBeenCalledTimes(1));
    await user.click(await screen.findByRole('button', { name: '将公司设为默认地址' }));
    await waitFor(() => expect(setDefaultBuyerAddress).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '删除公司地址' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleteBuyerAddress).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('heading', { name: '暂无已保存地址' })).toBeTruthy();
  });

  it('keeps manual address version conflicts visibly fail closed', async () => {
    const user = userEvent.setup();
    const updateBuyerAddress = vi.fn<CoreClient['updateBuyerAddress']>()
      .mockRejectedValue(new CoreClientError('UnknownState', 'Buyer address version changed'));
    renderAt('/assets/addresses', readyServices({
      getBuyerProfile: vi.fn().mockResolvedValue(buyerProfile),
      getBuyerOverview: vi.fn().mockResolvedValue(buyerOverview),
      listBuyerAddresses: vi.fn().mockResolvedValue([buyerSavedAddress]),
      updateBuyerAddress,
    }));

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Buyer address version changed'));
    expect(screen.getByRole('heading', { name: '地址同步失败' })).toBeTruthy();
  });

  it('loads Core products, authenticates the buyer and requests an exact signed reservation', async () => {
    const user = userEvent.setup();
    const quote = paymentQuote();
    const createOrdinaryQuote = vi.fn<CoreClient['createOrdinaryQuote']>().mockResolvedValue(quote);
    const services = readyServices({ createOrdinaryQuote });
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByRole('button', { name: /0x1111/ });
    await openProductCheckout(user);
    expect(screen.getByRole('heading', { name: '订单配置' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    await prepareDeliveryTarget(user);
    await user.click(screen.getByRole('button', { name: '生成付款报价' }));

    await screen.findByRole('heading', { name: '库存已预留' });
    expect(createOrdinaryQuote).toHaveBeenCalledWith('buyer-session', {
      idempotencyKey: 'mall-test-idempotency',
      productId: product.productId,
      skuId: product.skus[0]?.skuId,
      quantity: 1,
      fulfillmentMode: 'DELIVERY',
      fulfillmentTargetHash: deliveryTarget.targetHash,
      regionCodeHash: deliveryTarget.regionCodeHash,
      label: '张三 · 辽宁省大连市中山区示例路 24 号',
    });
    expect(screen.getAllByText('120.00 USDT').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('link', { name: /核对报价/ }));
    expect(screen.getByText('84.00 USDT')).toBeTruthy();
    expect(screen.getByText('1.20 USDT')).toBeTruthy();
    expect(screen.getByText('82.80 USDT')).toBeTruthy();
    expect(screen.getAllByText('10.00 USDT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('94.00 USDT').length).toBeGreaterThan(0);
    expect(screen.getByText('72.00 NPL')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '付款明细' })).toBeTruthy();
    expect(screen.getByText(/实际支付仍以系统报价为准/)).toBeTruthy();
    expect(screen.getByText('当前 0.00 USDT')).toBeTruthy();
    expect(screen.getByText('需要授权')).toBeTruthy();
    expect(screen.getByText('额度足够')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '完整收货信息' })).toBeTruthy();
    expect(screen.getByText(buyerSavedAddress.phone)).toBeTruthy();
    expect(screen.getByText(`${buyerSavedAddress.province} / ${buyerSavedAddress.city} / ${buyerSavedAddress.district}`)).toBeTruthy();
    expect(screen.getByText(/付款成功后，商品、规格、数量、履约方式与所在行政区将写入订单/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /确认支付/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/当前支付尚未通过系统上线开关/)).toBeTruthy();
  });

  it('renders exact Core finality and never promotes a submitted hash to final', async () => {
    const user = userEvent.setup();
    const quote = paymentQuote();
    const services = readyServices({
      createOrdinaryQuote: vi.fn().mockResolvedValue(quote),
      getPayment: vi.fn().mockResolvedValue({ ...quote, state: 'SUBMITTED', submittedTxHash: HASH_3, finality: null }),
    });
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await openProductCheckout(user);
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    await prepareDeliveryTarget(user);
    await user.click(screen.getByRole('button', { name: '生成付款报价' }));
    await user.click(await screen.findByRole('link', { name: /核对报价/ }));
    await user.click(screen.getByRole('button', { name: '刷新支付状态' }));

    await waitFor(() => expect(screen.getAllByText('已提交').length).toBeGreaterThan(0));
    expect(screen.getAllByText('确认中').length).toBeGreaterThan(0);
    expect(screen.getByText('--/15')).toBeTruthy();
  });

  it('refuses to invent fulfillment hashes until a Core target exists', async () => {
    const user = userEvent.setup();
    const createOrdinaryQuote = vi.fn<CoreClient['createOrdinaryQuote']>();
    const services = readyServices({ createOrdinaryQuote });
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await openProductCheckout(user);
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    expect(screen.getByRole('button', { name: '生成付款报价' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('请先选择已保存的收货地址')).toBeTruthy();
    expect(createOrdinaryQuote).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: '库存已预留' })).toBeNull();
  });

  it('latches a broadcast hash and retries only Core submission after a network failure', async () => {
    const user = userEvent.setup();
    const quote = paymentQuote();
    const submitPayment = vi.fn<CoreClient['submitPayment']>()
      .mockRejectedValueOnce(new Error('submission network unavailable'))
      .mockResolvedValue({ orderId: quote.orderId, txHash: HASH_3, state: 'SUBMITTED' });
    const getPayment = vi.fn<CoreClient['getPayment']>().mockResolvedValue({
      ...quote,
      state: 'SUBMITTED',
      submittedTxHash: HASH_3,
      finality: null,
    });
    const services = readyServices({
      createOrdinaryQuote: vi.fn().mockResolvedValue(quote),
      submitPayment,
      getPayment,
    });
    services.walletWritesAuthorized = true;
    const saveSubmission = vi.spyOn(services.submissionStore, 'save');
    const clearSubmission = vi.spyOn(services.submissionStore, 'clear');
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await openProductCheckout(user);
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    await prepareDeliveryTarget(user);
    await user.click(screen.getByRole('button', { name: '生成付款报价' }));
    await user.click(await screen.findByRole('link', { name: /核对报价/ }));
    await user.click(screen.getByRole('checkbox', { name: /无限额度授权风险/ }));
    await user.click(screen.getByRole('button', { name: /确认支付/ }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('网络连接失败，请检查网络后重试。'));
    expect(screen.getByRole('button', { name: '重试提交付款凭证' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /确认支付/ }).hasAttribute('disabled')).toBe(true);
    expect(services.wallet.broadcastPayment).toHaveBeenCalledTimes(1);
    expect(saveSubmission).toHaveBeenCalledWith(pendingRecord(quote.orderId, HASH_3));

    await user.click(screen.getByRole('button', { name: '重试提交付款凭证' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试提交付款凭证' })).toBeNull());
    expect(submitPayment).toHaveBeenCalledTimes(2);
    expect(getPayment).toHaveBeenCalledTimes(1);
    expect(services.wallet.broadcastPayment).toHaveBeenCalledTimes(1);
    expect(clearSubmission).toHaveBeenCalledTimes(1);
  });

  it('rehydrates a persisted pending hash and resumes without rebroadcasting', async () => {
    const user = userEvent.setup();
    const quote = paymentQuote();
    const pending = pendingRecord(quote.orderId, HASH_3);
    const submitPayment = vi.fn<CoreClient['submitPayment']>().mockResolvedValue({ ...pending, state: 'SUBMITTED' });
    const services = readyServices({
      submitPayment,
      getPayment: vi.fn().mockResolvedValue({ ...quote, state: 'SUBMITTED', submittedTxHash: HASH_3, finality: null }),
    });
    services.submissionStore.load = () => pending;
    renderAt('/checkout/review', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByRole('button', { name: '重试提交付款凭证' });
    await user.click(screen.getByRole('button', { name: '重试提交付款凭证' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: '重试提交付款凭证' })).toBeNull());
    expect(submitPayment).toHaveBeenCalledWith('buyer-session', { orderId: quote.orderId, txHash: HASH_3 });
    expect(services.wallet.broadcastPayment).not.toHaveBeenCalled();
    expect(screen.getAllByText('已提交').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain(HASH_3);
  });

  it('keeps a submitted hash until the Core projection is recoverable', async () => {
    const user = userEvent.setup();
    const quote = paymentQuote();
    const submitPayment = vi.fn<CoreClient['submitPayment']>()
      .mockResolvedValue({ orderId: quote.orderId, txHash: HASH_3, state: 'SUBMITTED' });
    const getPayment = vi.fn<CoreClient['getPayment']>()
      .mockRejectedValueOnce(new Error('projection unavailable'))
      .mockResolvedValue({ ...quote, state: 'SUBMITTED', submittedTxHash: HASH_3, finality: null });
    const services = readyServices({
      createOrdinaryQuote: vi.fn().mockResolvedValue(quote),
      submitPayment,
      getPayment,
    });
    services.walletWritesAuthorized = true;
    const saveSubmission = vi.spyOn(services.submissionStore, 'save');
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await openProductCheckout(user);
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    await prepareDeliveryTarget(user);
    await user.click(screen.getByRole('button', { name: '生成付款报价' }));
    await user.click(await screen.findByRole('link', { name: /核对报价/ }));
    await user.click(screen.getByRole('checkbox', { name: /无限额度授权风险/ }));
    await user.click(screen.getByRole('button', { name: /确认支付/ }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('projection unavailable'));
    expect(screen.getAllByRole('button', { name: '刷新支付状态' }).length).toBeGreaterThan(0);
    expect(saveSubmission).toHaveBeenLastCalledWith(pendingRecord(quote.orderId, HASH_3, 'AWAITING_PROJECTION'));
    expect(submitPayment).toHaveBeenCalledTimes(1);

    const refreshButtons = screen.getAllByRole('button', { name: '刷新支付状态' });
    await user.click(refreshButtons.at(-1)!);
    expect(submitPayment).toHaveBeenCalledTimes(1);
    expect(getPayment).toHaveBeenCalledTimes(2);
    expect(services.wallet.broadcastPayment).toHaveBeenCalledTimes(1);
  });

  it('shows frozen rules and stays fail closed when Core has no published session', async () => {
    const user = userEvent.setup();
    renderAt('/seckill');

    await user.click(screen.getByText('规则说明'));
    expect(screen.getByRole('dialog', { name: '秒杀规则' }).getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText(/主场固定 60 分钟/)).toBeTruthy();
    expect(screen.getByText(/增加 30 秒/)).toBeTruthy();
    expect(screen.getByText(/系统按付款最终确认时间判断/)).toBeTruthy();
    expect(screen.getByText(/70% USDT \+ 30% 等值 NPL/)).toBeTruthy();
    expect(screen.getByText(/5 分钟有效报价/)).toBeTruthy();
    expect(screen.getByText(/USDT 标价 1:1.*后台积分/)).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '规则说明' }));
    expect(await screen.findByText('暂无活动')).toBeTruthy();
    expect(screen.getByRole('button', { name: '立即抢购' }).hasAttribute('disabled')).toBe(true);
  });

  it.each([
    ['PREHEAT', '预热中'],
    ['LIVE', '活动进行中'],
    ['SETTLING', '抢购已结束'],
    ['SETTLED', '本场中奖用户'],
  ] as const)('renders authoritative %s seckill state without deriving phase locally', async (phase, expected) => {
    const current = seckillSession({
      phase,
      storedPhase: phase,
      ...(phase === 'PREHEAT' ? { startsAt: '2033-05-18T05:10:00.000Z' } : {}),
      ...(phase === 'SETTLED' ? { winnerWallet: BUYER, prizeSettlement: approvedPrizeSettlement() } : {}),
    });
    renderAt('/seckill', readyServices({ getCurrentSeckillSession: vi.fn().mockResolvedValue(current) }));

    expect(await screen.findByText(new RegExp(expected))).toBeTruthy();
    expect(screen.getAllByText('80.00 USDT', { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/240\.00(?: USDT)?/, { exact: false }).length).toBeGreaterThan(0);
    if (phase === 'LIVE') {
      expect(screen.getByText('00:59:00')).toBeTruthy();
      expect(screen.getByText('00:01:00')).toBeTruthy();
      expect(document.body.textContent).not.toContain(seckillGovernanceActionId);
      expect(document.body.textContent).not.toContain(seckillRulesContentHash);
      expect(document.body.textContent).not.toContain(seckillPublicationTxHash);
    }
  });

  it('does not let the initial history-only load erase a current seckill route session', async () => {
    const current = seckillSession();
    const slowInitialHistory = deferred<{ items: PublishedSeckillSessionProjection[]; nextCursor: string | null }>();
    const listSeckillSessionHistory = vi.fn<CoreClient['listSeckillSessionHistory']>()
      .mockReturnValueOnce(slowInitialHistory.promise)
      .mockResolvedValue({ items: [], nextCursor: null });
    renderAt('/seckill', readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(current),
      listSeckillSessionHistory,
    }));

    expect(await screen.findByText(/活动进行中/)).toBeTruthy();
    await act(async () => {
      slowInitialHistory.resolve({ items: [], nextCursor: null });
    });

    expect(screen.getByText(/活动进行中/)).toBeTruthy();
    expect(screen.queryByText('暂无活动')).toBeNull();
  });

  it('fails seckill configuration closed and reloads once when a Core deadline reaches zero', async () => {
    const expired = seckillSession({ relayDeadline: '2033-05-18T05:00:00.000Z' });
    const getCurrentSeckillSession = vi.fn<CoreClient['getCurrentSeckillSession']>().mockResolvedValue(expired);
    renderAt('/seckill', readyServices({ getCurrentSeckillSession }));

    expect(await screen.findByText('00:00:00')).toBeTruthy();
    expect(screen.getByRole('button', { name: '立即抢购' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/倒计时已结束/)).toBeTruthy();
    await waitFor(() => expect(getCurrentSeckillSession).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getCurrentSeckillSession).toHaveBeenCalledTimes(2);
  });

  it('keeps the seckill setup CTA stable while an expired deadline refresh is in flight', async () => {
    const expired = seckillSession({ relayDeadline: '2033-05-18T05:00:00.000Z' });
    const secondLoad = deferred<PublishedSeckillSessionProjection>();
    const getCurrentSeckillSession = vi.fn<CoreClient['getCurrentSeckillSession']>()
      .mockResolvedValueOnce(expired)
      .mockReturnValueOnce(secondLoad.promise)
      .mockResolvedValue(expired);
    renderAt('/seckill', readyServices({ getCurrentSeckillSession }));

    expect(await screen.findByText('00:00:00')).toBeTruthy();
    await waitFor(() => expect(getCurrentSeckillSession).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: '立即抢购' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: '处理中' })).toBeNull();

    secondLoad.resolve(expired);
  });

  it('does not loop deadline reloads when Core refreshes serverTime for the same expired deadline', async () => {
    const getCurrentSeckillSession = vi.fn<CoreClient['getCurrentSeckillSession']>()
      .mockResolvedValueOnce(seckillSession({
        serverTime: '2033-05-18T05:00:00.000Z',
        relayDeadline: '2033-05-18T05:00:00.000Z',
      }))
      .mockResolvedValue(seckillSession({
        serverTime: '2033-05-18T05:00:05.000Z',
        relayDeadline: '2033-05-18T05:00:00.000Z',
      }));
    renderAt('/seckill', readyServices({ getCurrentSeckillSession }));

    expect(await screen.findByText('00:00:00')).toBeTruthy();
    await waitFor(() => expect(getCurrentSeckillSession).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getCurrentSeckillSession).toHaveBeenCalledTimes(2);
  });

  it('shows only the published rules content bound to the current final session', async () => {
    const current = seckillSession();
    const content = (text: string) => ({
      type: 'doc',
      children: [{ type: 'paragraph', children: [{ type: 'text', text }] }],
    });
    const matchingRules = {
      ...publicCmsItem,
      versionId: 'seckill-rules-current',
      slug: 'seckill-rules-current',
      contentType: 'SECKILL_RULES' as const,
      contentHash: current.rulesContentHash,
      content: content('当前场次规则'),
    };
    const staleRules = {
      ...matchingRules,
      versionId: 'seckill-rules-stale',
      slug: 'seckill-rules-stale',
      contentHash: `0x${'d'.repeat(64)}`,
      content: content('旧场次规则'),
    };
    renderAt('/seckill', readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(current),
      listPublicCms: vi.fn().mockResolvedValue([staleRules, matchingRules]),
    }));

    expect(await screen.findByRole('heading', { name: '当前场次规则' })).toBeTruthy();
    expect(screen.queryByText('旧场次规则')).toBeNull();
  });

  it('renders history and final-only relay wall from the coordinated realtime consumer', async () => {
    const current = seckillSession();
    const history = seckillSession({
      phase: 'SETTLED',
      storedPhase: 'SETTLED',
      winnerWallet: BUYER,
      prizeSettlement: approvedPrizeSettlement('SETTLED'),
    });
    const event = relayEvent();
    const services = readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(current),
      getSeckillSession: vi.fn().mockResolvedValue({ ...current, relayDeadline: String(event.payload.relayDeadline) }),
      listSeckillSessionHistory: vi.fn().mockResolvedValue({ items: [history], nextCursor: null }),
    });
    services.realtime = {
      subscribe: (_sessionId, handlers) => {
        queueMicrotask(() => {
          handlers.onState('LIVE');
          handlers.onEvent(event);
        });
        return { close() {} };
      },
    };
    const user = userEvent.setup();
    renderAt('/seckill', services);

    expect(await screen.findByText(/成功抢购，接力时间 \+30 秒/)).toBeTruthy();
    expect(screen.getByText('实时')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '历史战报' }));
    expect(screen.getByText('赢家已确认')).toBeTruthy();
    expect(document.body.textContent).not.toContain(seckillPrizeExecutionTxHash);
  });

  it('renders candidate review, rollover, quarantine and every prize payout state from Core', async () => {
    const pending = seckillSession({
      phase: 'SETTLING',
      storedPhase: 'SETTLING',
      prizeSettlement: reviewPendingPrizeSettlement(),
    });
    const payoutStates = ['AVAILABLE', 'REQUESTED', 'SUBMITTED', 'SETTLED'] as const;
    const history = payoutStates.map((state, index) => seckillSession({
      sessionId: `0x${String(index + 1).repeat(64)}`,
      phase: 'SETTLED',
      storedPhase: 'SETTLED',
      winnerWallet: BUYER,
      prizeSettlement: approvedPrizeSettlement(state),
    }));
    history.push(seckillSession({
      sessionId: `0x${'5'.repeat(64)}`,
      phase: 'SETTLED',
      storedPhase: 'SETTLED',
      prizePoolUsdt: '0',
      prizeSettlement: rolledOverPrizeSettlement(),
    }));
    const quarantined = reviewPendingPrizeSettlement();
    quarantined.state = 'QUARANTINED';
    quarantined.review = {
      decision: 'REJECTED',
      reasonCode: 'ORDER_INVALID',
      evidenceHash: `0x${'6'.repeat(64)}`,
      reviewedBy: `0x${'a'.repeat(40)}`,
      reviewedAt: '2033-05-18T05:08:00.000Z',
    };
    history.push(seckillSession({
      sessionId: `0x${'6'.repeat(64)}`,
      phase: 'SETTLED',
      storedPhase: 'SETTLED',
      prizeSettlement: quarantined,
    }));
    const user = userEvent.setup();
    renderAt('/seckill', readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(pending),
      listSeckillSessionHistory: vi.fn().mockResolvedValue({ items: history, nextCursor: null }),
    }));

    expect(await screen.findByText('候选审核中')).toBeTruthy();
    expect(screen.getByText('已有候选用户')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '历史战报' }));
    for (const label of ['可用', '已申请', '已提交', '已到账', '已滚入下一场', '已隔离']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(document.body.textContent).not.toContain(seckillCandidateOrderId);
    expect(document.body.textContent).not.toContain(seckillPrizeExecutionTxHash);
  });

  it('binds the current Core session to the existing dual-quote checkout', async () => {
    const current = seckillSession();
    const quote = seckillQuote();
    const createSeckillQuote = vi.fn<CoreClient['createSeckillQuote']>().mockResolvedValue(quote);
    const services = readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(current),
      createSeckillQuote,
    });
    const user = userEvent.setup();
    renderAt('/seckill', services);

    const configure = await screen.findByRole('button', { name: '立即抢购' });
    await user.click(configure);
    expect(screen.queryByRole('heading', { name: '秒杀订单配置' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '进入配置前确认规则' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '我已阅读并确认规则' }));
    expect(screen.getByRole('heading', { name: '秒杀订单配置' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await prepareDeliveryTarget(user);
    await user.click(screen.getByRole('button', { name: '生成秒杀报价' }));

    await screen.findByRole('heading', { name: '库存已预留' });
    expect(createSeckillQuote).toHaveBeenCalledWith('buyer-session', seckillSessionId, expect.objectContaining({
      productId: product.productId,
      skuId: product.skus[1]!.skuId,
    }));
  });

  it('keeps checkout closed when the confirmed LIVE session mismatches the catalog overlay', async () => {
    const user = userEvent.setup();
    const mismatchedProduct = {
      ...product,
      skus: product.skus.map((sku) => sku.seckill ? {
        ...sku,
        seckill: { ...sku.seckill, sessionId: `0x${'d'.repeat(64)}` },
      } : sku),
    };
    renderAt('/seckill', readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(seckillSession()),
      listCatalog: vi.fn().mockResolvedValue([mismatchedProduct]),
    }));

    await user.click(await screen.findByRole('button', { name: '立即抢购' }));
    await user.click(screen.getByRole('button', { name: '我已阅读并确认规则' }));

    expect((await screen.findByRole('alert')).textContent).toContain('overlay 不一致');
    expect(screen.queryByRole('heading', { name: '秒杀订单配置' })).toBeNull();
  });

  it('filters Core stores by administrative codes without map or location controls', async () => {
    const user = userEvent.setup();
    const createPublicMediaReadAccess = vi.fn((assetId: string) => Promise.resolve(publicMediaAccess(assetId)));
    const fartherStore = {
      ...store,
      storeId: 'store-dalian-002',
      name: '大连远程自提店',
      regionCode: '210203',
      latitude: store.latitude + 0.4,
      imageAssetIds: [],
    };
    const otherCityStore = {
      ...store,
      storeId: 'store-beijing-001',
      name: '北京自提店',
      regionCode: '110101',
      longitude: 116.4074,
      latitude: 39.9042,
      imageAssetIds: [],
    };
    const services = readyServices({
      createPublicMediaReadAccess,
      listStores: vi.fn().mockResolvedValue([fartherStore, otherCityStore, store]),
    });
    renderAt('/stores', services);

    const storeHeading = await screen.findByRole('heading', { name: store.name });
    const storeArticle = storeHeading.closest('article')!;
    expect(screen.getByLabelText('国家')).toHaveProperty('value', 'CN');
    await user.selectOptions(screen.getByLabelText('城市'), '210200');
    expect(screen.queryByRole('heading', { name: otherCityStore.name })).toBeNull();
    expect(within(screen.getByLabelText('区县')).getByRole('option', { name: '区县 210202' })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('区县'), store.regionCode);
    expect(screen.queryByRole('heading', { name: fartherStore.name })).toBeNull();
    await user.selectOptions(screen.getByLabelText('区县'), '');
    expect(screen.getAllByText(store.businessHours).length).toBeGreaterThan(0);
    const storeImages = await screen.findAllByRole('img', { name: new RegExp(`${store.name} 门店图片`) });
    expect(storeImages).toHaveLength(storeImageAssetIds.length);
    for (const [index, assetId] of storeImageAssetIds.entries()) {
      expect(storeImages[index]?.getAttribute('src')).toBe(publicMediaAccess(assetId).readUrl);
      expect(createPublicMediaReadAccess).toHaveBeenCalledWith(assetId.toLowerCase());
    }
    expect(screen.getByRole('link', { name: `拨打 ${store.name} 电话` }).getAttribute('href')).toBe(`tel:${store.phone}`);
    expect(within(storeArticle).queryByRole('button', { name: /导航|距离/ })).toBeNull();
    expect(screen.queryByText(/km|最近/)).toBeNull();
  });

  it('clears stale public stores when a reload fails', async () => {
    const user = userEvent.setup();
    const listStores = vi.fn<CoreClient['listStores']>()
      .mockResolvedValueOnce([store])
      .mockRejectedValueOnce(new CoreClientError('ExternalBlocked', '门店投影暂不可用'));
    renderAt('/stores', readyServices({ listStores }));

    await screen.findByRole('heading', { name: store.name });
    await user.click(screen.getByRole('button', { name: '刷新门店' }));

    expect(await screen.findByText('门店加载失败')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: store.name })).toBeNull();
    expect(screen.queryByRole('img', { name: new RegExp(`${store.name} 门店图片`) })).toBeNull();
  });

  it('binds a pickup target only through a published Core store snapshot', async () => {
    const user = userEvent.setup();
    const quote = paymentQuote('PICKUP');
    const createPickupTarget = vi.fn<CoreClient['createPickupTarget']>().mockResolvedValue(pickupTarget);
    const services = readyServices({
      createPickupTarget,
      createOrdinaryQuote: vi.fn().mockResolvedValue(quote),
    });
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await openProductCheckout(user);
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    await user.click(screen.getByRole('button', { name: '到店自提' }));
    expect(await screen.findByText(`营业时间：${store.businessHours}`)).toBeTruthy();
    expect(await screen.findAllByRole('img', { name: new RegExp(`${store.name} 门店图片`) })).toHaveLength(storeImageAssetIds.length);
    const nearestSelection = await screen.findByRole('button', { name: `选择 ${store.name}` });
    expect(createPickupTarget).not.toHaveBeenCalled();
    await user.click(nearestSelection);

    expect(createPickupTarget).toHaveBeenCalledWith('buyer-session', {
      idempotencyKey: 'mall-test-idempotency',
      storeId: store.storeId,
    });
    expect(screen.getByText(`${store.name} · ${store.address}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: '生成付款报价' }).hasAttribute('disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: '生成付款报价' }));
    await user.click(await screen.findByRole('link', { name: /核对报价/ }));
    expect(screen.getByRole('heading', { name: '完整自提信息' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '完整自提信息' })).getByText(store.businessHours)).toBeTruthy();
    expect(screen.getByText(/营业时间内到店/)).toBeTruthy();
    expect(screen.getByText('210202')).toBeTruthy();
  });

  it('fails closed when Core cannot bind the buyer saved address', async () => {
    const user = userEvent.setup();
    const createBuyerAddressTarget = vi.fn<CoreClient['createBuyerAddressTarget']>()
      .mockRejectedValue(new CoreClientError('ExternalBlocked', '地址目标服务暂不可用'));
    const services = readyServices({ createBuyerAddressTarget });
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await openProductCheckout(user);
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    await user.click(await screen.findByRole('button', { name: '使用默认地址' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('收货地址暂时无法确认，请刷新后重试。'));
    expect(createBuyerAddressTarget).toHaveBeenCalledWith('buyer-session', buyerSavedAddress.addressId, 'mall-test-idempotency');
    expect(screen.queryByLabelText('详细地址')).toBeNull();
    expect(screen.getByRole('button', { name: '生成付款报价' }).hasAttribute('disabled')).toBe(true);
  });

  it('uploads and submits evidence for an enabled buyer exchange action', async () => {
    const user = userEvent.setup();
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'damage.png', { type: 'image/png' });
    const intent = mediaUploadIntent();
    const asset = verifiedEvidenceAsset();
    const evidence = orderActionEvidence('REQUEST_EXCHANGE', 'PACKAGE_DAMAGED', [evidenceAssetId]);
    const createMediaUploadIntent = vi.fn<CoreClient['createMediaUploadIntent']>().mockResolvedValue(intent);
    const uploadMediaFile = vi.fn<CoreClient['uploadMediaFile']>().mockResolvedValue(undefined);
    const completeMediaUpload = vi.fn<CoreClient['completeMediaUpload']>().mockResolvedValue(asset);
    const createOrderActionEvidence = vi.fn<CoreClient['createOrderActionEvidence']>().mockResolvedValue(evidence);
    const requestExchange = vi.fn<CoreClient['requestExchange']>().mockResolvedValue(buyerActionResult('REQUEST_EXCHANGE'));
    const services = readyServices({
      listOrders: vi.fn().mockResolvedValue({ orders: [deliveryOrder], nextCursor: null }),
      getOrderAllowedActions: vi.fn().mockResolvedValue(deliveryActions),
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
      getBuyerTakeoverTimeline: vi.fn().mockResolvedValue(buyerTakeoverTimeline),
      createMediaUploadIntent,
      uploadMediaFile,
      completeMediaUpload,
      createOrderActionEvidence,
      requestExchange,
    });
    services.hashEvidenceFile = vi.fn().mockResolvedValue(evidenceFileHash);
    renderAt('/assets/orders', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByText('BNM 后台积分');
    expect(screen.getByText('顺丰')).toBeTruthy();
    expect(screen.getByText('SF1234567890')).toBeTruthy();
    expect(screen.getByText('易碎品，请当面签收')).toBeTruthy();
    expect(screen.getByText('运输中 · 05/18 13:00')).toBeTruthy();
    expect(screen.getByText('120.00 BNM')).toBeTruthy();
    expect(screen.getByText(/13800138000/)).toBeTruthy();
    expect(screen.getByText('PARTIAL_LEGACY')).toBeTruthy();
    expect(screen.getByText(/OPEN →/)).toBeTruthy();
    expect(screen.getByText(/PLATFORM_FUNDING_CONFIRMED/)).toBeTruthy();
    const exchange = screen.getByRole('button', { name: '申请换货' });
    expect(exchange.hasAttribute('disabled')).toBe(false);
    await user.click(exchange);
    await user.type(screen.getByLabelText('处理原因'), 'package_damaged');
    await user.upload(screen.getByLabelText(/证据文件（可选）/), file);
    await user.click(screen.getByRole('button', { name: /封装证据并提交/ }));

    expect(await screen.findByText('操作已由系统接收，订单状态已重新同步。')).toBeTruthy();
    expect(createMediaUploadIntent).toHaveBeenCalledWith('buyer-session', {
      purpose: 'FULFILLMENT_EVIDENCE',
      resourceType: 'ORDER',
      resourceId: deliveryOrder.orderId,
      contentType: 'image/png',
      sizeBytes: 4,
      contentSha256: evidenceFileHash,
      idempotencyKey: 'mall-test-idempotency',
    });
    expect(uploadMediaFile).toHaveBeenCalledWith(intent, file);
    expect(completeMediaUpload).toHaveBeenCalledWith('buyer-session', intent.uploadIntentId);
    expect(createOrderActionEvidence).toHaveBeenCalledWith('buyer-session', deliveryOrder.orderId, {
      action: 'REQUEST_EXCHANGE',
      reasonCode: 'PACKAGE_DAMAGED',
      mediaAssetIds: [evidenceAssetId],
      idempotencyKey: 'mall-test-idempotency',
    });
    expect(requestExchange).toHaveBeenCalledWith('buyer-session', deliveryOrder.orderId, {
      idempotencyKey: 'mall-test-idempotency',
      evidenceHash: orderEvidenceHash,
      reasonCode: 'PACKAGE_DAMAGED',
    });
    expect(screen.getAllByText('UnknownState')).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/申请退款|强制退款|无理由退款/i);
    expect(document.body.textContent).not.toContain(orderEvidenceHash);
  });

  it('appends stable order pages and consumes complete row allowedActions without a second action lookup', async () => {
    const user = userEvent.setup();
    const cursor = { createdAt: deliveryOrder.createdAt, orderId: deliveryOrder.orderId };
    const secondOrder = {
      ...deliveryOrder,
      orderId: `0x${'e'.repeat(64)}`,
      createdAt: '2033-05-17T03:00:00.000Z',
      orderKind: 'SECKILL' as const,
      allowedActions: [],
    };
    const listOrders = vi.fn<CoreClient['listOrders']>().mockImplementation((_token, nextCursor) => Promise.resolve(
      nextCursor ? { orders: [secondOrder], nextCursor: null } : { orders: [deliveryOrder], nextCursor: cursor },
    ));
    const services = readyServices({
      listOrders,
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
    });
    renderAt('/assets/orders', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect(await screen.findByText('已提交')).toBeTruthy();
    expect(document.body.textContent).not.toContain(deliveryOrder.paymentTxHash!);
    expect(screen.getByText('数量').nextElementSibling?.textContent).toBe(deliveryOrder.quantity);
    await user.click(screen.getByRole('button', { name: '加载更多订单' }));
    await screen.findByText('秒杀 · 快递订单');
    expect(screen.getByText('秒杀', { selector: '.order-kind-badge' })).toBeTruthy();
    expect(listOrders).toHaveBeenLastCalledWith('buyer-session', cursor);
    expect(services.core.getOrderAllowedActions).not.toHaveBeenCalled();
  });

  it('uses only a validated Mall support URL and fails closed when it is missing', async () => {
    const user = userEvent.setup();
    const services = readyServices({
      listOrders: vi.fn().mockResolvedValue({ orders: [deliveryOrder], nextCursor: null }),
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
    });
    services.supportUrl = 'https://support.mall.test/help';
    const view = renderAt('/assets/orders', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    const support = await screen.findByRole('link', { name: '联系客服' });
    expect(support.getAttribute('href')).toBe('https://support.mall.test/help');
    expect(support.getAttribute('rel')).toBe('noopener noreferrer');
    expect(support.getAttribute('href')).not.toContain(deliveryOrder.orderId);
    expect(validateSupportUrl('javascript:alert(1)').url).toBeNull();

    view.unmount();
    renderAt('/assets/orders', readyServices());
    expect(screen.getByText('客服入口未配置')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '联系客服' })).toBeNull();
  });

  it.each([
    ['REQUEST_DELAY', '申请延期'],
    ['OPEN_ARBITRATION', '发起仲裁'],
    ['CONFIRM_RECEIPT', '确认收货'],
  ] as const)('submits %s without requiring a pasted hash or media file', async (action, label) => {
    const user = userEvent.setup();
    const evidence = orderActionEvidence(action, 'BUYER_CONFIRMED');
    const requestDelay = vi.fn<CoreClient['requestDelay']>().mockResolvedValue(buyerActionResult('REQUEST_DELAY'));
    const openArbitration = vi.fn<CoreClient['openArbitration']>().mockResolvedValue(buyerActionResult('OPEN_ARBITRATION'));
    const confirmReceipt = vi.fn<CoreClient['confirmReceipt']>().mockResolvedValue(buyerActionResult('CONFIRM_RECEIPT'));
    const createOrderActionEvidence = vi.fn<CoreClient['createOrderActionEvidence']>().mockResolvedValue(evidence);
    const services = readyServices({
      listOrders: vi.fn().mockResolvedValue({
        orders: [{ ...deliveryOrder, allowedActions: [{ action, enabled: true }] }],
        nextCursor: null,
      }),
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
      createOrderActionEvidence,
      requestDelay,
      openArbitration,
      confirmReceipt,
    });
    renderAt('/assets/orders', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await user.click(await screen.findByRole('button', { name: label }));
    await user.type(screen.getByLabelText('处理原因'), 'buyer_confirmed');
    await user.click(screen.getByRole('button', { name: /封装证据并提交/ }));
    expect(await screen.findByText('操作已由系统接收，订单状态已重新同步。')).toBeTruthy();
    expect(createOrderActionEvidence).toHaveBeenCalledWith('buyer-session', deliveryOrder.orderId, {
      action,
      reasonCode: 'BUYER_CONFIRMED',
      idempotencyKey: 'mall-test-idempotency',
    });
    expect(services.core.createMediaUploadIntent).not.toHaveBeenCalled();
    const command = { idempotencyKey: 'mall-test-idempotency', evidenceHash: orderEvidenceHash };
    if (action === 'REQUEST_DELAY') expect(requestDelay).toHaveBeenCalledWith('buyer-session', deliveryOrder.orderId, { ...command, reasonCode: 'BUYER_CONFIRMED' });
    if (action === 'OPEN_ARBITRATION') expect(openArbitration).toHaveBeenCalledWith('buyer-session', deliveryOrder.orderId, { ...command, reasonCode: 'BUYER_CONFIRMED' });
    if (action === 'CONFIRM_RECEIPT') expect(confirmReceipt).toHaveBeenCalledWith('buyer-session', deliveryOrder.orderId, command);
  });

  it('reuses the same evidence and command idempotency keys when command submission is retried', async () => {
    const user = userEvent.setup();
    const evidence = orderActionEvidence('REQUEST_EXCHANGE', 'PACKAGE_DAMAGED');
    const createOrderActionEvidence = vi.fn<CoreClient['createOrderActionEvidence']>().mockResolvedValue(evidence);
    const requestExchange = vi.fn<CoreClient['requestExchange']>()
      .mockRejectedValueOnce(new CoreClientError('NetworkUnavailable', '命令提交中断'))
      .mockResolvedValue(buyerActionResult('REQUEST_EXCHANGE'));
    const services = readyServices({
      listOrders: vi.fn().mockResolvedValue({
        orders: [{ ...deliveryOrder, allowedActions: [{ action: 'REQUEST_EXCHANGE', enabled: true }] }],
        nextCursor: null,
      }),
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
      createOrderActionEvidence,
      requestExchange,
    });
    renderAt('/assets/orders', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await user.click(await screen.findByRole('button', { name: '申请换货' }));
    await user.type(screen.getByLabelText('处理原因'), 'package_damaged');
    await user.click(screen.getByRole('button', { name: /封装证据并提交/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('命令提交中断'));
    await user.click(screen.getByRole('button', { name: /封装证据并提交/ }));
    expect(await screen.findByText('操作已由系统接收，订单状态已重新同步。')).toBeTruthy();
    expect(createOrderActionEvidence).toHaveBeenCalledTimes(1);
    expect(requestExchange).toHaveBeenCalledTimes(2);
    expect(requestExchange.mock.calls[0]).toEqual(requestExchange.mock.calls[1]);
  });

  it('keeps takeover and pickup verification fail closed when buyer evidence authority is absent', async () => {
    const user = userEvent.setup();
    const services = readyServices({
      listOrders: vi.fn().mockResolvedValue({
        orders: [{
          ...deliveryOrder,
          allowedActions: [
            { action: 'OPEN_TAKEOVER', enabled: true },
            { action: 'VERIFY_PICKUP', enabled: true },
          ],
        }],
        nextCursor: null,
      }),
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
    });
    renderAt('/assets/orders', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect((await screen.findByRole('button', { name: '平台接管' })).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '自提核销' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/当前订单不能由买家直接发起平台接管/)).toBeTruthy();
    expect(screen.getByText(/仅授权门店或平台角色/)).toBeTruthy();
    expect(screen.queryByLabelText(/证据$/)).toBeNull();
  });

  it('keeps empty seckill activity truthful and shopping records buyer-authenticated', async () => {
    const user = userEvent.setup();
    const listBuyerShoppingStatements = vi.fn<CoreClient['listBuyerShoppingStatements']>();
    renderAt('/assets/activity', readyServices({ listBuyerShoppingStatements }));

    expect(await screen.findByRole('heading', { name: '暂无奖项结算记录' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/中奖金额|提取奖金|第\s*\d+\s*期/);
    await user.click(screen.getByRole('tab', { name: '消费购物' }));
    expect(screen.getByRole('heading', { name: '连接买家钱包后查看' })).toBeTruthy();
    expect(listBuyerShoppingStatements).not.toHaveBeenCalled();
  });

  it('renders exact Core shopping amounts and appends the paired cursor page', async () => {
    const user = userEvent.setup();
    const listBuyerShoppingStatements = vi.fn<CoreClient['listBuyerShoppingStatements']>()
      .mockImplementation((_token, cursor) => Promise.resolve(cursor ? secondShoppingStatementPage : firstShoppingStatementPage));
    renderAt('/assets/activity', readyServices({ listBuyerShoppingStatements }));

    await user.click(screen.getByRole('tab', { name: '消费购物' }));
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect(await screen.findByText('系统已记录')).toBeTruthy();
    expect(screen.getByText('已确认')).toBeTruthy();
    expect(screen.getByText('14.00 USDT')).toBeTruthy();
    expect(screen.getByText('0.20 USDT')).toBeTruthy();
    expect(screen.getByText('13.80 USDT')).toBeTruthy();
    expect(screen.getByText('1.00 USDT')).toBeTruthy();
    expect(screen.getByText('15.00 USDT')).toBeTruthy();
    expect(screen.getByText('600.00 NPL')).toBeTruthy();
    expect(screen.getByText('20.00 BNM')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/原子单位/);
    expect(screen.getByText('可用')).toBeTruthy();
    expect(screen.getByText(ordinaryShoppingStatement.createdAt)).toBeTruthy();
    expect(screen.getByText(ordinaryShoppingStatement.paymentFinalizedAt)).toBeTruthy();
    expect(screen.getByText(ordinaryShoppingStatement.fulfilledAt!)).toBeTruthy();
    for (const journalId of ordinaryShoppingStatement.bnm.journalIds) expect(screen.getByTitle(journalId)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '加载下一页' }));
    expect(await screen.findByText('边界转普通订单')).toBeTruthy();
    expect(screen.getByText('边界转普通订单')).toBeTruthy();
    expect(screen.getByText('已锁定')).toBeTruthy();
    expect(screen.getByText('尚未最终履约')).toBeTruthy();
    expect(listBuyerShoppingStatements).toHaveBeenLastCalledWith('buyer-session', firstShoppingStatementPage.nextCursor);
    expect(screen.queryByRole('button', { name: '加载下一页' })).toBeNull();
  });

  it('shows shopping loading, empty and authorization failure states', async () => {
    const user = userEvent.setup();
    type ShoppingPage = Awaited<ReturnType<CoreClient['listBuyerShoppingStatements']>>;
    let resolvePage!: (page: ShoppingPage) => void;
    const pendingPage = new Promise<ShoppingPage>((resolve) => { resolvePage = resolve; });
    const listBuyerShoppingStatements = vi.fn<CoreClient['listBuyerShoppingStatements']>().mockReturnValue(pendingPage);
    const view = renderAt('/assets/activity', readyServices({ listBuyerShoppingStatements }));
    await user.click(screen.getByRole('tab', { name: '消费购物' }));
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect(await screen.findByLabelText('正在加载购物记录')).toBeTruthy();
    resolvePage({ ...secondShoppingStatementPage, statements: [] });
    expect(await screen.findByRole('heading', { name: '暂无购物记录' })).toBeTruthy();

    view.unmount();
    const forbidden = new CoreClientError('Forbidden', '当前会话无权读取该买家购物记录');
    renderAt('/assets/activity', readyServices({
      listBuyerShoppingStatements: vi.fn<CoreClient['listBuyerShoppingStatements']>().mockRejectedValue(forbidden),
    }));
    await user.click(screen.getByRole('tab', { name: '消费购物' }));
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect(await screen.findByText('当前钱包没有权限，请切换正确钱包后重试。', { selector: '.activity-error p' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新同步' })).toBeTruthy();
  });

  it('tracks the Core winner candidate and rollover result instead of a blocked placeholder', async () => {
    const pending = seckillSession({
      phase: 'SETTLING',
      storedPhase: 'SETTLING',
      prizeSettlement: reviewPendingPrizeSettlement(),
    });
    const rolled = seckillSession({
      sessionId: `0x${'4'.repeat(64)}`,
      phase: 'SETTLED',
      storedPhase: 'SETTLED',
      prizePoolUsdt: '0',
      prizeSettlement: rolledOverPrizeSettlement(),
    });
    const user = userEvent.setup();
    renderAt('/assets/activity', readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(pending),
      listSeckillSessionHistory: vi.fn().mockResolvedValue({ items: [rolled], nextCursor: null }),
    }));

    const records = await screen.findByLabelText('秒杀奖项记录');
    expect(within(records).getByText('候选审核中')).toBeTruthy();
    expect(within(records).getByTitle(seckillCandidateOrderId)).toBeTruthy();
    expect(within(records).getByText('已滚入下一场')).toBeTruthy();
    expect(within(records).queryByText(/DecisionBlocked：秒杀奖项记录未发布/)).toBeNull();
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await waitFor(() => expect(within(records).getByText(/当前钱包是唯一冻结候选人/)).toBeTruthy());
  });

  it('loads anonymous CMS without identity input and reloads authenticated CMS with the session token', async () => {
    const user = userEvent.setup();
    const listPublicCms = vi.fn<CoreClient['listPublicCms']>().mockResolvedValue([publicCmsItem]);
    renderAt('/mall', readyServices({ listPublicCms }));
    await screen.findByRole('heading', { name: '结算中心已开放' });
    expect(screen.getByText('RELEASE_ANNOUNCEMENT · V2')).toBeTruthy();
    expect(listPublicCms).toHaveBeenCalledWith();

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await waitFor(() => expect(listPublicCms).toHaveBeenCalledWith('buyer-session'));
  });

  it('renders every transferable lifecycle state and submits a wallet-signed settlement request', async () => {
    const user = userEvent.setup();
    const createSettlementIntent = vi.fn<CoreClient['createSettlementIntent']>().mockResolvedValue(settlementIntent);
    const submitSettlementRequest = vi.fn<CoreClient['submitSettlementRequest']>().mockResolvedValue(requestedSettlement);
    const services = readyServices({
      listSettlements: vi.fn().mockResolvedValue(settlementProjection),
      createSettlementIntent,
      submitSettlementRequest,
    });
    renderAt('/assets/rewards', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByRole('heading', { name: 'NPL 收益' });
    for (const label of ['锁定中', '可用', '已申请', '已提交', '已结算']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(new RegExp(`${settlementTransferId.slice(0, 10)}…${settlementTransferId.slice(-8)}`))).toBeTruthy();
    expect(screen.getByTitle(finalExecutionTxHash)).toBeTruthy();
    for (const label of ['创世', '直推', '区县', '城市', '省', '大区', '运维', '取整余数']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByLabelText('BNM 账户总额').textContent).toContain('<0.01 BNM');
    await user.click(screen.getByRole('button', { name: '签名申请结算 <0.01 NPL' }));

    await waitFor(() => expect(createSettlementIntent).toHaveBeenCalledWith('buyer-session', {
      rail: 'REWARD_NPL',
      amount: '200',
      idempotencyKey: 'mall-test-idempotency',
    }));
    expect(services.wallet.signSettlementIntent).toHaveBeenCalledWith(settlementIntent);
    expect(submitSettlementRequest).toHaveBeenCalledWith('buyer-session', {
      intentId: settlementIntent.intent.intentId,
      signature: '0xsettlement-signature',
    });
    expect(document.body.textContent).not.toMatch(/申请退款|强制退款|无理由退款/i);
  });

  it('uses the existing PRIZE_USDT signed request for the published winner and exposes no action to a non-winner', async () => {
    const prizeProjection = {
      ...settlementProjection,
      balances: settlementProjection.balances.filter((balance) => balance.asset === 'USDT'),
      points: [],
      requests: [],
    };
    const createSettlementIntent = vi.fn<CoreClient['createSettlementIntent']>().mockResolvedValue(prizeSettlementIntent);
    const submitSettlementRequest = vi.fn<CoreClient['submitSettlementRequest']>().mockResolvedValue({
      ...requestedSettlement,
      rail: 'PRIZE_USDT',
      asset: 'USDT',
      asset_address: chainIdentity.usdtAddress,
      amount: '60',
    });
    const winnerSession = seckillSession({
      phase: 'SETTLED',
      storedPhase: 'SETTLED',
      winnerWallet: BUYER,
      prizeSettlement: approvedPrizeSettlement(),
    });
    const user = userEvent.setup();
    const winnerView = renderAt('/assets/rewards', readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(winnerSession),
      listSettlements: vi.fn().mockResolvedValue(prizeProjection),
      createSettlementIntent,
      submitSettlementRequest,
    }));
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await user.click(await screen.findByRole('button', { name: '签名申请结算 <0.01 USDT' }));
    await waitFor(() => expect(createSettlementIntent).toHaveBeenCalledWith('buyer-session', {
      rail: 'PRIZE_USDT',
      amount: '60',
      idempotencyKey: 'mall-test-idempotency',
    }));

    winnerView.unmount();
    const otherWinner = '0x2222222222222222222222222222222222222222';
    const nonWinnerSession = seckillSession({
      phase: 'SETTLED',
      storedPhase: 'SETTLED',
      winnerWallet: otherWinner,
      prizeSettlement: {
        ...approvedPrizeSettlement(),
        candidate: { ...approvedPrizeSettlement().candidate!, buyerWallet: otherWinner },
      },
    });
    renderAt('/assets/rewards', readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(nonWinnerSession),
      listSettlements: vi.fn().mockResolvedValue({
        ...settlementProjection,
        balances: settlementProjection.balances.filter((balance) => balance.asset !== 'USDT'),
        requests: settlementProjection.requests.filter((request) => request.rail !== 'PRIZE_USDT'),
      }),
    }));
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByRole('heading', { name: 'NPL 收益' });
    expect(screen.queryByRole('heading', { name: '秒杀 USDT 奖金' })).toBeNull();
    expect(screen.queryByRole('button', { name: /签名申请结算 <0.01 USDT/ })).toBeNull();
  });

  it('hides genesis attribution when Core does not project genesis eligibility', async () => {
    const withoutGenesis = {
      ...settlementProjection,
      balances: settlementProjection.balances.filter((balance) => balance.rewardSubtype !== 'GENESIS'),
    };
    const services = readyServices({ listSettlements: vi.fn().mockResolvedValue(withoutGenesis) });
    const user = userEvent.setup();
    renderAt('/assets/rewards', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByRole('heading', { name: 'NPL 收益' });
    expect(screen.queryByText('创世')).toBeNull();
    expect(screen.getByText('直推')).toBeTruthy();
  });

  it('loads the real notification inbox and registers the wallet-bound in-app endpoint', async () => {
    const user = userEvent.setup();
    const registerNotificationEndpoint = vi.fn<CoreClient['registerNotificationEndpoint']>().mockResolvedValue({
      endpointId: 'notification-endpoint-1',
      channel: 'IN_APP',
      provider: 'CORE',
      topics: ['*'],
      state: 'ACTIVE',
    });
    const notifications: readonly NotificationInboxItem[] = [
      notificationItem,
      { ...notificationItem },
      notification('settlement-submitted-message', 'SettlementTransferSubmitted', 'SETTLEMENT_SUBMITTED', {
        requestId: 'settlement-request-submitted', executionTxHash: `0x${'d'.repeat(64)}`,
      }),
      notification('payment-message', 'PaymentFinalized', 'PAYMENT_FINALIZED', { orderId: 'order-payment', state: 'LOCKED' }),
      notification('shipment-message', 'LogisticsUpdated', 'SHIPMENT_UPDATED', {
        orderId: 'order-shipment', provider: 'KUAIDI100', carrierCode: 'SF', trackingNumberHash: `0x${'5'.repeat(64)}`, status: 'IN_TRANSIT',
      }),
      notification('pickup-message', 'FulfillmentFinalized', 'FULFILLMENT_FINALIZED', {
        orderId: 'order-pickup', method: 'PICKUP_VERIFICATION', availableNplAmount: '20',
      }),
      notification('bnm-locked-message', 'BnmStateFinalized', 'BNM_LOCKED', { state: 'LOCKED', amount: '100', stateVersion: '1' }),
      notification('bnm-available-message', 'BnmStateFinalized', 'BNM_AVAILABLE', { state: 'AVAILABLE', amount: '100', stateVersion: '2' }),
      notification('activity-message', 'NotificationCampaignPublished', 'ACTIVITY', {
        titleKey: 'SECKILL_ACTIVITY', bodyKey: 'SECKILL_ACTIVITY_BODY', campaignId: 'campaign-24k', variables: { version: '2' },
      }),
    ];
    const services = readyServices({
      listNotifications: vi.fn().mockResolvedValue(notifications),
      registerNotificationEndpoint,
    });
    renderAt('/assets/notifications', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByRole('heading', { name: '结算已完成' });
    expect(screen.getAllByRole('heading', { name: '结算已完成' })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: '结算交易已提交' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '支付已确认' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '发货与物流已更新' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '自提履约已完成' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'BNM 已锁定' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'BNM 已可用' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '活动通知' })).toBeTruthy();
    expect(screen.getByText('物流单号凭证')).toBeTruthy();
    expect(screen.getByText('自提核销')).toBeTruthy();
    expect(screen.getAllByText('锁定中')).toHaveLength(2);
    expect(screen.getAllByText('可用')).toHaveLength(1);
    expect(screen.getByText('活动参数 · 版本')).toBeTruthy();
    expect(screen.getByText(finalExecutionTxHash)).toBeTruthy();
    expect(screen.getByRole('button', { name: `重新验证或切换钱包，当前 ${BUYER}` })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '启用站内通知' }));
    await waitFor(() => expect(registerNotificationEndpoint).toHaveBeenCalledWith('buyer-session', {
      channel: 'IN_APP',
      provider: 'CORE',
      endpointReference: `recipient://wallet/${BUYER}`,
      topics: ['*'],
    }));
    expect(await screen.findByText('CORE · ACTIVE')).toBeTruthy();
  });

  it('clears the prior wallet inbox immediately and ignores its late refresh response', async () => {
    const secondBuyer = '0x2222222222222222222222222222222222222222';
    const oldRefresh = deferred<readonly NotificationInboxItem[]>();
    const newInbox = deferred<readonly NotificationInboxItem[]>();
    const oldItem = notification('old-wallet-message', 'PaymentFinalized', 'PAYMENT_FINALIZED', { orderId: 'old-order' });
    const newItem = notification('new-wallet-message', 'ShipmentRecorded', 'SHIPMENT_UPDATED', { orderId: 'new-order' });
    let notificationCall = 0;
    const listNotifications = vi.fn<CoreClient['listNotifications']>().mockImplementation(() => {
      notificationCall += 1;
      if (notificationCall === 1) return Promise.resolve([oldItem]);
      if (notificationCall === 2) return oldRefresh.promise;
      return newInbox.promise;
    });
    const walletForToken = (token: string) => token === 'buyer-session-2' ? secondBuyer : BUYER;
    const services = readyServices({
      authenticate: vi.fn().mockImplementation((walletAddress: string) => Promise.resolve({
        token: walletAddress === secondBuyer ? 'buyer-session-2' : 'buyer-session',
        walletAddress,
        roles: ['BUYER'],
      })),
      getBuyerProfile: vi.fn().mockImplementation((token: string) => Promise.resolve({ ...buyerProfile, wallet: walletForToken(token) })),
      getBuyerOverview: vi.fn().mockImplementation((token: string) => Promise.resolve({ ...buyerOverview, wallet: walletForToken(token) })),
      listBuyerShoppingStatements: vi.fn().mockImplementation((token: string) => Promise.resolve({
        artifactVersion, buyerWallet: walletForToken(token), statements: [], nextCursor: null,
      })),
      listSettlements: vi.fn().mockImplementation((token: string) => Promise.resolve({
        artifactVersion, wallet: walletForToken(token), balances: [], points: [], requests: [],
      })),
      listNotifications,
    });
    services.wallet.connect = vi.fn()
      .mockResolvedValueOnce(BUYER)
      .mockResolvedValueOnce(secondBuyer);
    const user = userEvent.setup();
    render(<MallRuntimeProvider services={services}><NotificationConnectionProbe /></MallRuntimeProvider>);

    await user.click(screen.getByRole('button', { name: '连接测试钱包' }));
    expect(await screen.findByText('old-wallet-message')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '刷新测试通知' }));
    await waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: '连接测试钱包' }));
    expect(screen.queryByText('old-wallet-message')).toBeNull();
    await waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(3));

    oldRefresh.resolve([oldItem]);
    await waitFor(() => expect(screen.queryByText('old-wallet-message')).toBeNull());
    newInbox.resolve([newItem, { ...newItem }]);
    expect(await screen.findByText('new-wallet-message')).toBeTruthy();
    expect(screen.getAllByText('new-wallet-message')).toHaveLength(1);
  });

  it('fails closed without test notification fixtures when the Core inbox errors', async () => {
    const user = userEvent.setup();
    renderAt('/assets/notifications', readyServices({
      listNotifications: vi.fn().mockRejectedValue(new CoreClientError('ExternalBlocked', 'Notification inbox unavailable')),
    }));

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect(await screen.findByRole('heading', { name: '通知同步失败' })).toBeTruthy();
    expect(screen.queryByText(finalExecutionTxHash)).toBeNull();
    expect(screen.queryByRole('heading', { name: '结算已完成' })).toBeNull();
  });

  it('provides accessible names for every icon-only control', () => {
    renderAt('/assets');
    const iconOnlyControls = Array.from(document.querySelectorAll('button, a')).filter(
      (element) => !element.textContent?.trim(),
    );
    for (const element of iconOnlyControls) expect(element.getAttribute('aria-label')).toBeTruthy();
  });
});

const HASH_3 = `0x${'3'.repeat(64)}`;

const BLOCK_BURST_NPL = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const BLOCK_BURST_PROXY = '0x8151d38ea70Cd39A99872C50C861cDDEC00a6770';
const BLOCK_BURST_OWNER = '0x7003BBCE2b3f83F5b2dDC5A8C1b9b5b5289a1b83';
const BLOCK_BURST_APPROVE_TX = `0x${'a'.repeat(64)}`;
const BLOCK_BURST_DEPOSIT_TX = `0x${'b'.repeat(64)}`;
const blockBurstTestInterface = new Interface([
  'function getPoolState() view returns (tuple(address token,address owner,uint256 currentPhase,uint256 maxPhases,uint256 initialTarget,uint256 currentTarget,uint256 rewardBps,uint256 releaseDuration,uint256 accRewardPerShare,uint256 totalActivePrincipal,uint256 totalDeposited,uint256 reservedRewards,uint256 unallocatedNpl,bool pausedDeposit,bool pausedExplode,bool pausedClaimPrincipal,bool pausedClaimReward))',
  'function getNextExplosionState() view returns (tuple(uint256 phase,uint256 target,uint256 reward,uint256 activePrincipal,uint256 unallocatedNpl,bool principalReady,bool rewardReady,bool canExplode))',
  'function getUserState(address user) view returns (tuple(address wallet,uint256 activePrincipal,uint256 rewardCredit,uint256 rewardDebt,uint256 pendingReward,uint256 positionCount))',
  'function getUserPositions(address user) view returns (tuple(uint256 id,uint256 amount,uint256 claimedPrincipal,uint256 activePrincipal,uint256 depositedAt,uint256 joinedPhase,bool closed,uint256 claimablePrincipal)[])',
  'function deposit(uint256 amount) returns (uint256 positionId,uint256 received)',
  'function claimPrincipal(uint256[] positionIds) returns (uint256 amount)',
  'function claimReward() returns (uint256 amount)',
  'function explode() returns (uint256 phase,uint256 reward)',
]);
const blockBurstTokenInterface = new Interface([
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]);

function mockBlockBurstRpc(options: {
  wallet?: string;
  getAllowance?: () => bigint;
  getBalance?: () => bigint;
  initialTarget?: bigint;
  currentTarget?: bigint;
  currentPhase?: bigint;
  maxPhases?: bigint;
  activePrincipal?: bigint;
  nextCanExplode?: boolean;
  receiptForTx?: (txHash: string) => { transactionHash: string; status: string; blockNumber: string; from?: string; to?: string; blockHash?: string };
} = {}) {
  const {
    wallet = BUYER,
    getAllowance = () => blockBurstNpl(100n),
    getBalance = () => blockBurstNpl(100n),
    initialTarget = blockBurstNpl(100_000_000_000_000n),
    currentTarget = blockBurstNpl(200_000_000_000_000n),
    currentPhase = 2n,
    maxPhases = 10n,
    activePrincipal = blockBurstNpl(150n),
    nextCanExplode = false,
    receiptForTx = (txHash: string) => ({
      transactionHash: txHash,
      from: wallet,
      to: txHash === BLOCK_BURST_APPROVE_TX ? BLOCK_BURST_NPL : BLOCK_BURST_PROXY,
      status: '0x1',
      blockNumber: '0x1234',
      blockHash: `0x${'4'.repeat(64)}`,
    }),
  } = options;
  const selectors = {
    pool: blockBurstTestInterface.getFunction('getPoolState')!.selector,
    next: blockBurstTestInterface.getFunction('getNextExplosionState')!.selector,
    user: blockBurstTestInterface.getFunction('getUserState')!.selector,
    positions: blockBurstTestInterface.getFunction('getUserPositions')!.selector,
    allowance: blockBurstTokenInterface.getFunction('allowance')!.selector,
    balance: blockBurstTokenInterface.getFunction('balanceOf')!.selector,
  };
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; params?: unknown[] };
    let result: unknown;
    if (body.method === 'eth_chainId') {
      result = '0x38';
    } else if (body.method === 'eth_getTransactionReceipt') {
      result = receiptForTx(String(body.params?.[0] ?? ''));
    } else if (body.method === 'eth_getTransactionByHash') {
      const txHash = String(body.params?.[0] ?? '');
      result = {
        hash: txHash,
        from: wallet,
        to: txHash === BLOCK_BURST_APPROVE_TX ? BLOCK_BURST_NPL : BLOCK_BURST_PROXY,
        input: txHash === BLOCK_BURST_APPROVE_TX
          ? blockBurstTokenInterface.encodeFunctionData('approve', [BLOCK_BURST_PROXY, blockBurstNpl(10n)])
          : blockBurstTestInterface.encodeFunctionData('deposit', [blockBurstNpl(1n)]),
      };
    } else if (body.method === 'eth_call') {
      const call = body.params?.[0] as { data?: string; to?: string } | undefined;
      const to = call?.to?.toLowerCase();
      const data = call?.data ?? '';
      if (to === BLOCK_BURST_PROXY.toLowerCase() && data.startsWith(selectors.pool)) {
        result = blockBurstTestInterface.encodeFunctionResult('getPoolState', [[
          BLOCK_BURST_NPL,
          BLOCK_BURST_OWNER,
          currentPhase,
          maxPhases,
          initialTarget,
          currentTarget,
          1000n,
          8640000n,
          0n,
          activePrincipal,
          blockBurstNpl(160n),
          blockBurstNpl(20n),
          blockBurstNpl(4n),
          false,
          true,
          false,
          true,
        ]]);
      } else if (to === BLOCK_BURST_PROXY.toLowerCase() && data.startsWith(selectors.next)) {
        result = blockBurstTestInterface.encodeFunctionResult('getNextExplosionState', [[
          currentPhase >= maxPhases ? 0n : currentPhase + 1n,
          currentTarget,
          blockBurstNpl(20_000_000_000_000n),
          activePrincipal,
          blockBurstNpl(4n),
          nextCanExplode,
          nextCanExplode,
          nextCanExplode,
        ]]);
      } else if (to === BLOCK_BURST_PROXY.toLowerCase() && data.startsWith(selectors.user)) {
        result = blockBurstTestInterface.encodeFunctionResult('getUserState', [[
          wallet,
          blockBurstNpl(25n),
          0n,
          0n,
          blockBurstNpl(3n),
          1n,
        ]]);
      } else if (to === BLOCK_BURST_PROXY.toLowerCase() && data.startsWith(selectors.positions)) {
        result = blockBurstTestInterface.encodeFunctionResult('getUserPositions', [[[
          7n,
          blockBurstNpl(30n),
          blockBurstNpl(5n),
          blockBurstNpl(25n),
          1_721_000_000n,
          1n,
          false,
          blockBurstNpl(2n),
        ]]]);
      } else if (to === BLOCK_BURST_NPL.toLowerCase() && data.startsWith(selectors.allowance)) {
        result = blockBurstTokenInterface.encodeFunctionResult('allowance', [getAllowance()]);
      } else if (to === BLOCK_BURST_NPL.toLowerCase() && data.startsWith(selectors.balance)) {
        result = blockBurstTokenInterface.encodeFunctionResult('balanceOf', [getBalance()]);
      } else {
        throw new Error(`unexpected block burst calldata ${data}`);
      }
    } else {
      throw new Error(`unexpected block burst rpc method ${body.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function blockBurstNpl(amount: bigint) {
  return amount * (10n ** 18n);
}


function offlineServices(): MallServices {
  return servicesWith({
    getBootstrap: vi.fn().mockResolvedValue(bootstrap(false)),
    listCatalog: vi.fn().mockResolvedValue([]),
  });
}

function readyServices(overrides: Partial<CoreClient> = {}): MallServices {
  return servicesWith({
    getBootstrap: vi.fn().mockResolvedValue(bootstrap(true)),
    listCatalog: vi.fn().mockResolvedValue([product]),
    listCatalogCategories: vi.fn().mockResolvedValue(catalogCategories),
    listCatalogTags: vi.fn().mockResolvedValue(catalogTags),
    createPublicMediaReadAccess: vi.fn((assetId: string) => Promise.resolve(publicMediaAccess(assetId))),
    listStores: vi.fn().mockResolvedValue([store]),
    listBuyerAddresses: vi.fn().mockResolvedValue([buyerSavedAddress]),
    createBuyerAddressTarget: vi.fn().mockResolvedValue(deliveryTarget),
    ...overrides,
  });
}

function servicesWith(overrides: Partial<CoreClient>): MallServices {
  let pendingSubmission: PendingSubmission | null = null;
  const core: CoreClient = {
    getBootstrap: vi.fn().mockResolvedValue(bootstrap(false)),
    listCatalog: vi.fn().mockResolvedValue([]),
    listCatalogCategories: vi.fn().mockResolvedValue([]),
    listCatalogTags: vi.fn().mockResolvedValue([]),
    createPublicMediaReadAccess: vi.fn().mockRejectedValue(new Error('not configured')),
    createAuthenticatedMediaReadAccess: vi.fn().mockRejectedValue(new Error('not configured')),
    createMediaUploadIntent: vi.fn().mockRejectedValue(new Error('not configured')),
    uploadMediaFile: vi.fn().mockRejectedValue(new Error('not configured')),
    completeMediaUpload: vi.fn().mockRejectedValue(new Error('not configured')),
    authenticate: vi.fn().mockResolvedValue({ token: 'buyer-session', walletAddress: BUYER, roles: ['BUYER'] }),
    getBuyerProfile: vi.fn().mockResolvedValue({
      artifactVersion, wallet: BUYER, accountId: '10001',
      nickname: null, avatarAssetId: null, version: 0, updatedAt: null,
    }),
    updateBuyerProfile: vi.fn().mockRejectedValue(new Error('not configured')),
    parseBuyerAddress: vi.fn().mockRejectedValue(new Error('not configured')),
    listBuyerAddresses: vi.fn().mockResolvedValue([]),
    createBuyerAddress: vi.fn().mockRejectedValue(new Error('not configured')),
    updateBuyerAddress: vi.fn().mockRejectedValue(new Error('not configured')),
    deleteBuyerAddress: vi.fn().mockRejectedValue(new Error('not configured')),
    setDefaultBuyerAddress: vi.fn().mockRejectedValue(new Error('not configured')),
    createBuyerAddressTarget: vi.fn().mockRejectedValue(new Error('not configured')),
    getBuyerOverview: vi.fn().mockResolvedValue({
      artifactVersion,
      wallet: BUYER,
      orderCounts: {
        pendingPayment: { status: 'DecisionBlocked', count: null, blocker: 'BUYER_PENDING_PAYMENT_PROJECTION' },
        pendingShipment: { status: 'AVAILABLE', count: '0' },
        pendingReceipt: { status: 'AVAILABLE', count: '0' },
        afterSale: { status: 'AVAILABLE', count: '0' },
        total: { status: 'AVAILABLE', count: '0' },
      },
    }),
    getBuyerTakeoverTimeline: vi.fn().mockImplementation((_token: string, orderId: string) => Promise.resolve({
      artifactVersion, orderId, historyStatus: 'COMPLETE', transitions: [],
    })),
    listBuyerShoppingStatements: vi.fn().mockResolvedValue({
      artifactVersion,
      buyerWallet: BUYER,
      statements: [],
      nextCursor: null,
    }),
    createOrdinaryQuote: vi.fn().mockRejectedValue(new Error('not configured')),
    createSeckillQuote: vi.fn().mockRejectedValue(new Error('not configured')),
    submitPayment: vi.fn().mockRejectedValue(new Error('not configured')),
    getPayment: vi.fn().mockRejectedValue(new Error('not configured')),
    getCurrentSeckillSession: vi.fn().mockResolvedValue(null),
    listSeckillSessionHistory: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getSeckillSession: vi.fn().mockRejectedValue(new Error('not configured')),
    listSeckillSessionEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: '0' }),
    listStores: vi.fn().mockResolvedValue([]),
    createDeliveryTarget: vi.fn().mockResolvedValue(deliveryTarget),
    createPickupTarget: vi.fn().mockResolvedValue(pickupTarget),
    listOrders: vi.fn().mockResolvedValue({ orders: [], nextCursor: null }),
    getOrder: vi.fn().mockRejectedValue(new Error('not configured')),
    getOrderTarget: vi.fn().mockRejectedValue(new Error('not configured')),
    getOrderAllowedActions: vi.fn().mockResolvedValue([]),
    createOrderActionEvidence: vi.fn().mockRejectedValue(new Error('not configured')),
    requestExchange: vi.fn().mockRejectedValue(new Error('not configured')),
    requestDelay: vi.fn().mockRejectedValue(new Error('not configured')),
    confirmReceipt: vi.fn().mockRejectedValue(new Error('not configured')),
    openArbitration: vi.fn().mockRejectedValue(new Error('not configured')),
    listSettlements: vi.fn().mockResolvedValue({ artifactVersion, wallet: BUYER, balances: [], points: [], requests: [] }),
    createSettlementIntent: vi.fn().mockRejectedValue(new Error('not configured')),
    submitSettlementRequest: vi.fn().mockRejectedValue(new Error('not configured')),
    listPublicCms: vi.fn().mockResolvedValue([]),
    listNotifications: vi.fn().mockResolvedValue([]),
    registerNotificationEndpoint: vi.fn().mockRejectedValue(new Error('not configured')),
    ...overrides,
  };
  const wallet: WalletGateway = {
    connect: vi.fn().mockResolvedValue(BUYER),
    signMessage: vi.fn().mockResolvedValue('0xsigned'),
    signSettlementIntent: vi.fn().mockResolvedValue('0xsettlement-signature'),
    inspectApprovals: vi.fn().mockResolvedValue([
      { currentAllowance: '0', sufficient: false },
      { currentAllowance: '999999999999999999999', sufficient: true },
    ]),
    broadcastPayment: vi.fn().mockResolvedValue(HASH_3),
    revokeApproval: vi.fn().mockResolvedValue(HASH_3),
  };
  return {
    core,
    wallet,
    createIdempotencyKey: () => 'mall-test-idempotency',
    hashEvidenceFile: vi.fn().mockResolvedValue(HASH_3),
    submissionStore: {
      load: (walletAddress) => pendingSubmission?.walletAddress === walletAddress.toLowerCase() ? pendingSubmission : null,
      save: (submission) => { pendingSubmission = submission; },
      clear: () => { pendingSubmission = null; },
    },
    realtime: {
      subscribe: () => ({ close() {} }),
    },
    walletWritesAuthorized: false,
  };
}

async function prepareDeliveryTarget(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '使用默认地址' }));
  await screen.findByText('收货信息已验证');
}

async function openProductCheckout(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('link', { name: `查看 ${product.title} 商品详情` }));
  expect(screen.getByRole('heading', { name: '商品详情' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '购买' }));
}

function pendingRecord(orderId: string, txHash: string, phase: PendingSubmission['phase'] = 'PENDING_CORE_SUBMISSION'): PendingSubmission {
  return {
    artifactVersion,
    chainId: 56,
    walletAddress: BUYER,
    phase,
    orderId,
    txHash,
  };
}

function bootstrap(writesEnabled: boolean): CorePaymentAvailability {
  return {
    artifactVersion,
    writesEnabled,
    runtimeBlockers: writesEnabled ? [] : ['SIGNER_UNAVAILABLE'],
    blockCode: writesEnabled ? null : 'ExternalBlocked',
  };
}

function notification(
  messageId: string,
  sourceEventType: string,
  topic: string,
  templateData: NotificationInboxItem['templateData'],
): NotificationInboxItem {
  return {
    messageId,
    sourceEventType,
    topic,
    templateData,
    deliveryState: 'DELIVERED',
    createdAt: '2033-05-18T05:10:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

const BUYER = '0x1111111111111111111111111111111111111111';
const BLOCK_BURST_GUEST = '0x2222222222222222222222222222222222222222';
