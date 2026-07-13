import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAppKit, useProvider } from '@reown/appkit-react-native';
import { Boxes, CheckCircle2, ClipboardPaste, Clock3, Coins, FileSearch, Gift, LockKeyhole, PackageCheck, RefreshCw, ShieldAlert, Truck, WalletCards, X } from 'lucide-react-native';
import { ProductThumb } from '../components/ProductThumb';
import { WalletPill } from '../components/WalletPill';
import { BSC_CHAIN_ID } from '../config/web3';
import {
  createClaimIntent,
  createBuyerActionIntent,
  createCompleteOrderIntent,
  deleteAddress,
  fetchArbitrationTxStatus,
  fetchClaimTxStatus,
  fetchCompleteTxStatus,
  fetchDappAssetsState,
  parseAddressText,
  requestAfterSale,
  requestTimeoutRefund,
  saveAddress,
  setDefaultAddress,
  updateAddress,
  submitClaimRequest
} from '../services/api';
import type { AddressMutationAuth, AddressParseResponse, AddressWriteInput, AfterSaleRequestRecord, AfterSaleRequestType, AfterSaleTransactionIntent, ArbitrationTxStatusResponse, AssetOrder, BuyerActionIntent, BuyerAuthSession, ClaimTxStatusResponse, DappAssetSummary, SeckillRecord, ShoppingRecord, TxStatusResponse } from '../services/api';
import { ensureBuyerSession as ensurePersistentBuyerSession } from '../services/buyerAuth';
import { isOnBsc, personalSign, sendWalletTransaction } from '../services/payment';
import type { WalletProvider } from '../services/payment';
import { formatNpl, shortAddress } from '../services/orderMath';
import { colors, radius, shadow, spacing } from '../theme/tokens';
import type { AddressBookEntry, AssetBucket, ClaimRecord, RewardLedgerEntry } from '../types';

type Props = {
  address?: string;
  chainId?: string;
  isConnected: boolean;
  isProjectConfigured: boolean;
  onConnectPress: () => void;
  selectedAddressId?: string;
  onSelectAddress?: (entry: AddressBookEntry) => void;
};

type ApiState = 'idle' | 'loading' | 'ready' | 'error';
type StatusTone = 'normal' | 'error' | 'success';
type TxProgress = { kind: 'claim' | 'complete' | 'arbitration'; title: string; txHash: string; status: string };

export function AssetsScreen({ address, chainId, isConnected, isProjectConfigured, onConnectPress, selectedAddressId, onSelectAddress }: Props) {
  const { provider } = useProvider();
  const { switchNetwork } = useAppKit();
  const walletProvider = provider as WalletProvider | undefined;
  const [summary, setSummary] = useState<DappAssetSummary | null>(null);
  const [apiState, setApiState] = useState<ApiState>('idle');
  const [addressText, setAddressText] = useState('');
  const [addressReview, setAddressReview] = useState<AddressParseResponse | null>(null);
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [buyerSession, setBuyerSession] = useState<BuyerAuthSession | null>(null);
  const [addressBusy, setAddressBusy] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [supportOrder, setSupportOrder] = useState<AssetOrder | null>(null);
  const [afterSaleResults, setAfterSaleResults] = useState<Record<string, AfterSaleRequestRecord>>({});
  const [txProgress, setTxProgress] = useState<TxProgress | null>(null);
  const [status, setStatus] = useState('连接钱包后同步当前地址的订单、收益与 Claim 状态。');
  const [statusTone, setStatusTone] = useState<StatusTone>('normal');

  useEffect(() => {
    let mounted = true;
    setAddressReview(null);
    setEditingAddressId(null);
    setBuyerSession(null);
    setTxProgress(null);
    setSupportOrder(null);
    setAfterSaleResults({});
    if (!isConnected || !address) {
      setSummary(null);
      setApiState('idle');
      setStatus('连接钱包后同步当前地址的订单、收益与 Claim 状态。');
      setStatusTone('normal');
      return () => { mounted = false; };
    }

    setSummary(null);
    setApiState('loading');
    setStatus('正在读取当前钱包的 assets-state。');
    setStatusTone('normal');
    if (!walletProvider) {
      setApiState('error');
      setStatus('钱包 Provider 未就绪，无法建立 Buyer 会话。');
      setStatusTone('error');
      return () => { mounted = false; };
    }
    ensurePersistentBuyerSession(walletProvider, address)
      .then((session) => {
        if (!mounted) throw new Error('ASSETS_VIEW_UNMOUNTED');
        setBuyerSession(session);
        return fetchDappAssetsState(address, session.token);
      })
      .then((payload) => {
        if (!mounted) return;
        if (payload.connectedAddress?.toLowerCase() !== address.toLowerCase()) throw new Error('资产响应钱包地址不匹配。');
        setSummary(payload.summary);
        setAfterSaleResults(afterSaleResultMap(payload.summary));
        setApiState('ready');
        setStatus(`已同步 assets-state：${payload.generatedAt}`);
        setStatusTone('success');
      })
      .catch((error) => {
        if (!mounted) return;
        setSummary(null);
        setApiState('error');
        setStatus(errorMessage(error, '资产状态同步失败。'));
        setStatusTone('error');
      });
    return () => { mounted = false; };
  }, [address, isConnected, walletProvider]);

  const nplTotals = useMemo(() => (summary?.buckets || []).filter((bucket) => bucket.assetSymbol === 'NPL').reduce((acc, bucket) => ({
    cumulative: acc.cumulative + bucket.cumulative,
    available: acc.available + bucket.available,
    locked: acc.locked + bucket.locked
  }), { cumulative: 0, available: 0, locked: 0 }), [summary?.buckets]);

  async function refreshAssets(message?: string, preserveStatus = false) {
    if (!address || !isConnected) return;
    setApiState('loading');
    try {
      const session = await ensureBuyerSession(false);
      const payload = await fetchDappAssetsState(address, session.token);
      if (payload.connectedAddress?.toLowerCase() !== address.toLowerCase()) throw new Error('资产响应钱包地址不匹配。');
      setSummary(payload.summary);
      setAfterSaleResults(afterSaleResultMap(payload.summary));
      setApiState('ready');
      if (!preserveStatus) {
        setStatus(message || `资产状态已刷新：${payload.generatedAt}`);
        setStatusTone('success');
      }
    } catch (error) {
      setApiState('error');
      setStatus(errorMessage(error, '资产状态刷新失败。'));
      setStatusTone('error');
    }
  }

  async function handleParseAddress() {
    if (!isConnected || !address) {
      onConnectPress();
      return;
    }
    if (!addressText.trim()) {
      setStatus('请先粘贴收货人、手机号与完整地址。');
      setStatusTone('error');
      return;
    }
    setAddressBusy(true);
    setStatus('正在调用后端地址解析。');
    setStatusTone('normal');
    try {
      const parsed = await parseAddressText(address, addressText.trim());
      setAddressReview(parsed);
      setStatus(parsed.missing.length ? parsed.warning : '地址解析完成，请在弹窗内复核后保存。');
      setStatusTone(parsed.missing.length ? 'error' : 'success');
    } catch (error) {
      setStatus(errorMessage(error, '地址解析失败。'));
      setStatusTone('error');
    } finally {
      setAddressBusy(false);
    }
  }

  async function handleSaveAddress() {
    if (!addressReview || !address) return;
    const parsed = addressReview.parsed;
    const missing = requiredAddressFields(parsed);
    if (addressReview.missing.length || missing.length) {
      setStatus(`地址缺少 ${[...new Set([...addressReview.missing, ...missing])].join(' / ')}，未执行保存。请修改原文后重新解析。`);
      setStatusTone('error');
      return;
    }
    if (!/^\d{6}$/.test(String(parsed.regionCode)) || parsed.regionCode === '000000') {
      setStatus('行政区编码未准确解析，不能用占位编码保存。');
      setStatusTone('error');
      return;
    }

    setAddressBusy(true);
    setStatus(editingAddressId ? '正在授权修改地址。' : '正在授权保存地址。');
    setStatusTone('normal');
    try {
      const existing = editingAddressId ? summary?.addresses.find((entry) => entry.id === editingAddressId) : undefined;
      const input: AddressWriteInput = {
        name: String(parsed.name),
        phone: String(parsed.phone),
        province: String(parsed.province),
        city: String(parsed.city),
        district: String(parsed.district),
        detail: String(parsed.detail),
        regionCode: String(parsed.regionCode),
        isDefault: existing?.isDefault ?? (summary?.addresses.length || 0) === 0
      };
      const auth = await authorizeAddressAction('buyer.address.upsert', editingAddressId ? { ...input, id: editingAddressId } : { ...input });
      const saved = editingAddressId
        ? await updateAddress(editingAddressId, input, auth)
        : await saveAddress(input, auth);
      setAddressReview(null);
      setAddressText('');
      setEditingAddressId(null);
      await refreshAssets(`地址已${editingAddressId ? '修改' : '保存'}：${saved.name} · ${saved.regionCode}`);
    } catch (error) {
      reportAddressMutationError(error, editingAddressId ? '修改' : '保存');
    } finally {
      setAddressBusy(false);
    }
  }

  async function ensureBuyerSession(requireBsc = true) {
    if (!address || !walletProvider) throw new Error('钱包 Provider 未就绪，无法建立 Buyer 会话。');
    if (requireBsc) await ensureBsc('签名操作');
    if (buyerSession && buyerSession.address.toLowerCase() === address.toLowerCase() && buyerSession.expiresAt > Date.now() + 30_000) return buyerSession;
    setStatus('请在钱包签署 Buyer SIWE 登录消息。');
    const session = await ensurePersistentBuyerSession(walletProvider, address);
    setBuyerSession(session);
    return session;
  }

  async function authorizeAddressAction(action: BuyerActionIntent['action'], payload: Record<string, unknown>, label = '地址操作'): Promise<AddressMutationAuth> {
    const session = await ensureBuyerSession();
    setStatus(`正在创建${label}二次授权消息。`);
    const intent = await createBuyerActionIntent(session.token, action, payload);
    if (intent.action !== action || intent.chainId !== BSC_CHAIN_ID || intent.signatureKind !== 'personal_sign' || intent.walletAddress.toLowerCase() !== session.address.toLowerCase()) {
      throw new Error('地址操作授权消息与当前钱包、网络或操作不匹配。');
    }
    setStatus(`请在钱包签署${label}二次授权消息。`);
    const secondarySignature = await personalSign(walletProvider!, session.address, intent.secondaryMessage);
    return { token: session.token, secondaryMessage: intent.secondaryMessage, secondarySignature };
  }

  function startAddressEdit(entry: AddressBookEntry) {
    setEditingAddressId(entry.id);
    setAddressReview(null);
    setAddressText(`${entry.name} ${entry.phone} ${entry.province}${entry.city}${entry.district}${entry.detail}`);
    setStatus('已载入待修改地址。修改上方原文后重新解析、复核并签名保存。');
    setStatusTone('normal');
  }

  function cancelAddressEdit() {
    setEditingAddressId(null);
    setAddressReview(null);
    setAddressText('');
    setStatus('已取消地址修改，未向后端提交变更。');
    setStatusTone('normal');
  }

  function confirmAddressDelete(entry: AddressBookEntry) {
    Alert.alert('删除收货地址', `确认删除 ${entry.name} 的地址？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => { void handleDeleteAddress(entry); } }
    ]);
  }

  async function handleDeleteAddress(entry: AddressBookEntry) {
    setAddressBusy(true);
    setStatus('正在授权删除地址。');
    setStatusTone('normal');
    try {
      const auth = await authorizeAddressAction('buyer.address.delete', { id: entry.id });
      const result = await deleteAddress(entry.id, auth);
      if (!result.deleted || result.id !== entry.id) throw new Error('地址删除响应不完整。');
      if (editingAddressId === entry.id) {
        setEditingAddressId(null);
        setAddressReview(null);
        setAddressText('');
      }
      await refreshAssets(`地址已删除：${entry.name}`);
    } catch (error) {
      reportAddressMutationError(error, '删除');
    } finally {
      setAddressBusy(false);
    }
  }

  async function handleSetDefaultAddress(entry: AddressBookEntry) {
    if (entry.isDefault) {
      setStatus(`${entry.name} 已是默认地址。`);
      setStatusTone('success');
      return;
    }
    setAddressBusy(true);
    setStatus('正在授权设置默认地址。');
    setStatusTone('normal');
    try {
      const auth = await authorizeAddressAction('buyer.address.default', { id: entry.id });
      const saved = await setDefaultAddress(entry.id, auth);
      if (!saved.isDefault || saved.id !== entry.id) throw new Error('默认地址响应不完整。');
      await refreshAssets(`默认地址已设置：${saved.name}`);
    } catch (error) {
      reportAddressMutationError(error, '设为默认');
    } finally {
      setAddressBusy(false);
    }
  }

  function reportAddressMutationError(error: unknown, action: string) {
    const message = errorMessage(error, `地址${action}失败，未更改地址仓。`);
    if (/JWT_REQUIRED|INVALID_JWT|JWT_EXPIRED/i.test(message)) setBuyerSession(null);
    setStatus(isWalletRejection(error) ? `钱包已拒绝网络切换或 personal_sign，地址未${action}。` : message);
    setStatusTone('error');
  }

  function availableReward(bucketId?: string) {
    return summary?.ledger.find((entry) => entry.state === 'Available' && (!bucketId || entry.bucketId === bucketId));
  }

  async function ensureBsc(operation: string) {
    if (!walletProvider) throw new Error('钱包 Provider 未就绪，无法确认当前网络。');
    const currentChainId = await walletProvider.request<string>({ method: 'eth_chainId' });
    if (isOnBsc(currentChainId)) return;
    setStatus(`${operation}需要 BSC，正在请求钱包切换网络。`);
    setStatusTone('normal');
    await switchNetwork(`eip155:${BSC_CHAIN_ID}`);
    const switchedChainId = await walletProvider.request<string>({ method: 'eth_chainId' });
    if (!isOnBsc(switchedChainId)) throw new Error(`钱包当前链为 ${switchedChainId}，未切换到 BSC。`);
    setStatus('钱包已切换到 BSC，继续执行当前操作。');
  }

  async function handleClaim(input: { bucketId: string; rewardId: string; title: string }) {
    if (!isConnected || !address) {
      onConnectPress();
      return;
    }
    if (!isProjectConfigured || !walletProvider) {
      setStatus('钱包 Provider 未就绪，无法签名 Claim。');
      setStatusTone('error');
      return;
    }

    setBusyAction(`claim:${input.rewardId}`);
    setTxProgress(null);
    let phase: 'switching' | 'intent' | 'signing' | 'submitting' | 'transaction' | 'polling' = 'switching';
    let requestSubmitted = false;
    try {
      await ensureBsc('Claim');
      const session = await ensureBuyerSession(false);
      phase = 'intent';
      setStatus(`正在为 ${input.title} 创建 claim-intent。`);
      setStatusTone('normal');
      const intent = await createClaimIntent({ walletAddress: address, bucketId: input.bucketId, rewardId: input.rewardId }, session.token);
      if (
        intent.chainId !== BSC_CHAIN_ID
        || intent.signatureKind !== 'personal_sign'
        || intent.walletAddress.toLowerCase() !== address.toLowerCase()
        || intent.rewardId !== input.rewardId
        || intent.bucketId !== input.bucketId
      ) throw new Error('Claim intent 与当前钱包、奖励或网络不匹配。');

      phase = 'signing';
      setStatus('请在钱包签署 Claim 二次确认消息。');
      const signature = await personalSign(walletProvider, address, intent.secondaryMessage);
      if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new Error('钱包未返回有效签名。');

      phase = 'submitting';
      setStatus('签名已完成，正在提交 Claim 请求。');
      await submitClaimRequest(intent, signature, session.token);
      requestSubmitted = true;

      if (!intent.claimTransaction) {
        setStatus(`Claim 请求已接收，但后端未返回链上 claim 交易；状态保持 PendingClaim，不标记成功。原因：${intent.unavailableReason || 'CLAIM_TRANSACTION_UNAVAILABLE'}`);
        setStatusTone('error');
        await refreshAssets(undefined, true);
        return;
      }

      phase = 'transaction';
      setStatus('请在钱包确认 RewardLedger.claim 交易。');
      const txHash = requireTxHash(await sendWalletTransaction(walletProvider, intent.claimTransaction), 'RewardLedger.claim');
      setTxProgress({ kind: 'claim', title: input.title, txHash, status: 'pending' });
      setStatus(`Claim 交易已广播，正在等待打包。TxHash：${txHash}`);

      phase = 'polling';
      const result = await pollClaimUntilFinal(address, intent.rewardId, txHash, session.token, (next) => {
        setTxProgress({ kind: 'claim', title: input.title, txHash, status: next.status });
        setStatus(`${claimStatusCopy(next)} TxHash：${txHash}`);
        setStatusTone(next.status === 'confirmed' ? 'success' : next.status === 'failed' || next.status === 'mismatch' || next.status === 'unavailable' ? 'error' : 'normal');
      });
      if (result.status === 'confirmed') {
        await refreshAssets(`Claim 已确认并同步资产。TxHash：${txHash}`);
      } else if (!result.retryable) {
        throw new Error(claimStatusCopy(result));
      } else {
        setStatus(`${claimStatusCopy(result)} 已保留 TxHash：${txHash}`);
        setStatusTone('normal');
      }
    } catch (error) {
      const rejected = isWalletRejection(error);
      if (rejected && phase === 'signing') {
        setStatus('钱包已拒绝 personal_sign，Claim 请求未提交。');
      } else if (rejected && phase === 'transaction' && requestSubmitted) {
        setStatus('钱包已拒绝 RewardLedger.claim 交易；已提交的请求保持 PendingClaim，不标记成功。');
        await refreshAssets(undefined, true);
      } else if (rejected && phase === 'switching') {
        setStatus('钱包已拒绝切换到 BSC，Claim 未发起。');
      } else {
        setStatus(errorMessage(error, 'Claim 流程失败。'));
      }
      setStatusTone('error');
    } finally {
      setBusyAction('');
    }
  }

  async function handleCompleteOrder(order: AssetOrder) {
    if (!address || !walletProvider) {
      onConnectPress();
      return;
    }
    setBusyAction(`order:${order.orderId}`);
    setTxProgress(null);
    let phase: 'switching' | 'transaction' | 'polling' = 'switching';
    try {
      await ensureBsc('确认收货');
      const session = await ensureBuyerSession(false);
      setStatus('正在向后端请求 complete-order-intent。');
      const intent = await createCompleteOrderIntent(address, order.orderId, session.token);
      if (intent.chainId !== BSC_CHAIN_ID || intent.order.orderId !== order.orderId || intent.order.buyerAddress.toLowerCase() !== address.toLowerCase()) {
        throw new Error('complete-order-intent 与当前订单、买家或网络不匹配。');
      }
      if (!intent.confirmability.canComplete || !intent.completeOrderTransaction) throw new Error(intent.unavailableReason || intent.confirmability.reason || 'ORDER_NOT_CONFIRMABLE');
      phase = 'transaction';
      setStatus('请在钱包确认 completeOrder 交易；确认后托管放行且 BNM 转为 Available。');
      const txHash = requireTxHash(await sendWalletTransaction(walletProvider, intent.completeOrderTransaction), 'completeOrder');
      setTxProgress({ kind: 'complete', title: `订单 ${shortId(order.orderId)}`, txHash, status: 'pending' });
      phase = 'polling';
      const result = await pollCompleteUntilFinal(order.orderId, address, txHash, session.token, (next) => {
        setTxProgress({ kind: 'complete', title: `订单 ${shortId(order.orderId)}`, txHash, status: next.status });
        setStatus(`${completeStatusCopy(next)} TxHash：${txHash}`);
      });
      if (result.status === 'confirmed') {
        await refreshAssets(`确认收货已上链并同步。TxHash：${txHash}`);
      } else if (!result.retryable) {
        throw new Error(completeStatusCopy(result));
      } else {
        setStatus(`${completeStatusCopy(result)} 已保留 TxHash：${txHash}`);
      }
    } catch (error) {
      if (isWalletRejection(error)) {
        setStatus(phase === 'switching' ? '钱包已拒绝切换 BSC，确认收货未发起。' : '钱包已拒绝 completeOrder，订单未放行。');
      } else {
        setStatus(errorMessage(error, '确认收货失败。'));
      }
      setStatusTone('error');
    } finally {
      setBusyAction('');
    }
  }

  async function handleAfterSale(order: AssetOrder, type: AfterSaleRequestType) {
    if (!address || !walletProvider) {
      onConnectPress();
      return;
    }
    const current = orderAfterSale(order, afterSaleResults[order.orderId]);
    if (isAfterSaleActive(order, current)) {
      setStatus(`订单 ${shortId(order.orderId)} 已在 Arbitration / Locked 处理中，不能重复申请。`);
      setStatusTone('error');
      return;
    }
    if (!canRequestAfterSale(order)) {
      setStatus('只有待收货的快递或自提订单可申请换货/延期。');
      setStatusTone('error');
      return;
    }

    const reason = type === 'exchange' ? '商品故障，申请换货' : '申请延迟自动签收';
    const payload = { buyerAddress: address, orderId: order.orderId, type, reason };
    setBusyAction(`after-sale:${order.orderId}`);
    setStatus(`正在准备${type === 'exchange' ? '换货' : '延期'}申请。`);
    setStatusTone('normal');
    let phase: 'signing' | 'submitting' | 'transaction' = 'signing';
    try {
      const auth = await authorizeAddressAction('buyer.after-sale.request', payload, '售后申请');
      phase = 'submitting';
      const response = await requestAfterSale(payload, auth);
      if (!response.ok) throw new Error(response.message || '后端未接受售后申请。');
      const request: AfterSaleRequestRecord = {
        ...response.request,
        status: response.request.status || response.order?.status || (type === 'exchange' ? 'AwaitingDisputeTransaction' : 'Open'),
        lockState: response.request.lockState || 'Locked',
        result: response.request.result || (type === 'exchange' ? '等待钱包发送 disputeOrder' : '延期申请已受理，等待平台决定')
      };
      setAfterSaleResults((currentResults) => ({ ...currentResults, [order.orderId]: request }));
      if (type === 'exchange') {
        if (!response.transactionIntent) throw new Error('换货申请已登记，但后端未返回 disputeOrder 交易意图。');
        phase = 'transaction';
        await sendDisputeOrder(order, response.transactionIntent);
        return;
      }
      await refreshAssets(`延期申请已提交：${request.status} / ${request.lockState}`);
    } catch (error) {
      if (isWalletRejection(error)) {
        setStatus(phase === 'signing'
          ? '钱包已拒绝售后二次签名，未提交申请。'
          : '换货工单已登记，但钱包未发送 disputeOrder；可在订单卡片中重试。');
      } else {
        setStatus(errorMessage(error, phase === 'transaction' ? '仲裁交易发送或状态同步失败，可稍后重试。' : '售后申请失败。'));
      }
      setStatusTone('error');
      if (phase !== 'signing') await refreshAssets(undefined, true);
    } finally {
      setBusyAction('');
    }
  }

  async function sendDisputeOrder(order: AssetOrder, intent?: AfterSaleTransactionIntent | null) {
    if (!address || !walletProvider) throw new Error('钱包 Provider 未就绪，无法发送 disputeOrder。');
    await ensureBsc('换货仲裁');
    const session = await ensureBuyerSession(false);
    const transactionIntent = intent || order.afterSale?.transactionIntent;
    if (!transactionIntent) throw new Error('后端未返回可重试的 disputeOrder 交易意图。');
    if (transactionIntent.chainId !== BSC_CHAIN_ID || transactionIntent.orderId.toLowerCase() !== order.orderId.toLowerCase()) {
      throw new Error('disputeOrder 交易意图与当前订单或网络不匹配。');
    }
    setStatus('请在钱包确认 disputeOrder 交易；链上确认前订单不会进入 Arbitration。');
    const txHash = requireTxHash(await sendWalletTransaction(walletProvider, transactionIntent), 'disputeOrder');
    setTxProgress({ kind: 'arbitration', title: `换货 ${shortId(order.orderId)}`, txHash, status: 'pending' });
    const result = await pollArbitrationUntilFinal(order.orderId, address, txHash, session.token, (next) => {
      setTxProgress({ kind: 'arbitration', title: `换货 ${shortId(order.orderId)}`, txHash, status: next.status });
      setStatus(`${arbitrationStatusCopy(next)} TxHash：${txHash}`);
      setStatusTone(next.status === 'confirmed' ? 'success' : ['failed', 'mismatch'].includes(next.status) ? 'error' : 'normal');
    });
    if (result.status === 'confirmed') {
      await refreshAssets(`OrderArbitration 已确认，平台仲裁工单已开启。TxHash：${txHash}`);
    } else if (!result.retryable) {
      throw new Error(arbitrationStatusCopy(result));
    } else {
      setStatus(`${arbitrationStatusCopy(result)} 已保留 TxHash：${txHash}`);
    }
  }

  async function handleRetryDispute(order: AssetOrder) {
    setBusyAction(`after-sale:${order.orderId}`);
    setTxProgress(null);
    setStatus('正在恢复待发送的 disputeOrder。');
    setStatusTone('normal');
    try {
      await sendDisputeOrder(order);
    } catch (error) {
      setStatus(isWalletRejection(error) ? '钱包未发送 disputeOrder，工单仍保持待交易，可再次重试。' : errorMessage(error, 'disputeOrder 重试失败。'));
      setStatusTone('error');
      await refreshAssets(undefined, true);
    } finally {
      setBusyAction('');
    }
  }

  async function handleOrderAction(order: AssetOrder) {
    const action = order.primaryAction?.key;
    if (action === 'completeOrder') {
      await handleCompleteOrder(order);
      return;
    }
    if (action === 'requestTimeoutRefund') {
      if (!address) return;
      setBusyAction(`order:${order.orderId}`);
      setStatus('正在提交 7 天未发货强制退款申请。');
      try {
        const payload = { buyerAddress: address, orderId: order.orderId, reason: '7 天未发货' };
        const auth = await authorizeAddressAction('buyer.timeout-refund.request', payload);
        const result = await requestTimeoutRefund(address, order.orderId, auth);
        await refreshAssets(`后端已记录 ${result.status}，等待平台链上 forceRefund。`);
      } catch (error) {
        setStatus(errorMessage(error, '强制退款申请失败。'));
        setStatusTone('error');
      } finally {
        setBusyAction('');
      }
      return;
    }
    if (action === 'claimRewards') {
      const reward = availableReward();
      if (reward) await handleClaim({ bucketId: reward.bucketId || 'bnm', rewardId: reward.id, title: '订单可用收益' });
      else {
        setStatus('后端未返回可用 rewardId，未发起 Claim。');
        setStatusTone('error');
      }
      return;
    }
    if (action === 'trackFulfillment') {
      await refreshAssets(`订单 ${shortId(order.orderId)} 履约状态已刷新。`);
      return;
    }
    if (action === 'payOrder') {
      setStatus('待付款订单必须返回终核结算页重做库存与 final-check，资产页未直接广播付款。');
      setStatusTone('error');
      return;
    }
    await refreshAssets(`订单 ${shortId(order.orderId)} 状态已刷新。`);
  }

  const counts = summary?.orderStateCounts || {};
  const visibleBuckets = (summary?.buckets || []).filter((bucket) => bucket.visible);
  const activeSupportOrder = supportOrder ? summary?.orders.find((order) => order.orderId === supportOrder.orderId) || supportOrder : null;
  const activeSupportRequest = activeSupportOrder ? orderAfterSale(activeSupportOrder, afterSaleResults[activeSupportOrder.orderId]) : null;
  const supportCanRequest = Boolean(activeSupportOrder && canRequestAfterSale(activeSupportOrder, activeSupportRequest));

  return (
    <View style={styles.shell}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <View style={styles.heroTop}>
            <ProductThumb logo size={54} />
            <View style={styles.heroIdentity}>
              <Text style={styles.kicker}>ACCOUNT CENTER</Text>
              <Text style={styles.title}>我的资产</Text>
              <Text style={styles.walletLine}>{address ? shortAddress(address) : '未连接钱包'}</Text>
            </View>
          </View>
          <WalletPill address={address} chainId={chainId} isConnected={isConnected} isProjectConfigured={isProjectConfigured} onPress={onConnectPress} />
          <View style={styles.totalGrid}>
            <HeroMetric label="累计 NPL" value={summary ? formatNpl(nplTotals.cumulative) : '--'} />
            <HeroMetric label="待领 NPL" value={summary ? formatNpl(nplTotals.available) : '--'} />
            <HeroMetric label="锁定 NPL" value={summary ? formatNpl(nplTotals.locked) : '--'} />
          </View>
        </View>

        <View style={[styles.statusCard, statusTone === 'error' && styles.statusCardError, statusTone === 'success' && styles.statusCardSuccess]}>
          <FileSearch size={18} color={statusTone === 'error' ? colors.danger : colors.accentDeep} />
          <Text style={[styles.statusText, statusTone === 'error' && styles.statusTextError]}>{status}</Text>
        </View>

        {apiState !== 'ready' ? (
          <View style={[styles.stateNotice, apiState === 'error' && styles.stateNoticeError]}>
            {apiState === 'loading' ? <ActivityIndicator color={colors.gold} /> : null}
            <Text style={styles.stateTitle}>{apiState === 'idle' ? '请先连接钱包' : apiState === 'loading' ? '正在同步 assets-state' : '资产接口加载失败'}</Text>
            <Text style={styles.stateText}>{apiState === 'idle' ? '未连接时不显示任何余额或订单。' : apiState === 'loading' ? '仅显示服务端返回的当前钱包数据。' : '已保持错误状态，未使用本地账本替代。'}</Text>
          </View>
        ) : null}

        {txProgress ? (
          <View style={styles.txProgress}>
            <Text style={styles.txProgressTitle}>{txProgress.title} · {txProgress.status}</Text>
            <Text selectable style={styles.txHash}>{txProgress.txHash}</Text>
          </View>
        ) : null}

        <Section title="个人中心与地址仓" action="API 解析 / SIWE CRUD">
          <TextInput
            value={addressText}
            onChangeText={setAddressText}
            multiline
            placeholder="粘贴收货人、电话、省市区与详细地址"
            placeholderTextColor={colors.inkSoft}
            style={styles.addressInput}
            accessibilityLabel="粘贴收货地址"
          />
          {editingAddressId ? (
            <View style={styles.addressActions}>
              <Text style={styles.regionText}>正在修改地址 {shortId(editingAddressId)}</Text>
              <Pressable accessibilityRole="button" disabled={addressBusy} onPress={cancelAddressEdit} style={[styles.addressAction, addressBusy && styles.buttonDisabled]}><Text style={styles.addressActionText}>取消修改</Text></Pressable>
            </View>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel="调用 API 解析地址" disabled={addressBusy} onPress={handleParseAddress} style={({ pressed }) => [styles.parseButton, (pressed || addressBusy) && styles.pressed]}>
            {addressBusy ? <ActivityIndicator color={colors.pageDeep} /> : <ClipboardPaste size={17} color={colors.pageDeep} />}
            <Text style={styles.parseButtonText}>{addressBusy ? '处理中' : '一键粘贴智能识别'}</Text>
          </Pressable>
          {apiState === 'ready' && summary?.addresses.length ? summary.addresses.map((entry) => (
            <AddressRow
              key={entry.id}
              entry={entry}
              busy={addressBusy}
              selected={selectedAddressId === entry.id}
              onEdit={() => startAddressEdit(entry)}
              onDelete={() => confirmAddressDelete(entry)}
              onSetDefault={() => { void handleSetDefaultAddress(entry); }}
              onSelect={() => onSelectAddress?.(entry)}
            />
          )) : <InlineEmpty text={apiState === 'ready' ? '当前钱包暂无已保存地址。' : '地址列表尚未成功加载。'} />}
        </Section>

        <Section title="订单中心" action="assets-state">
          <View style={styles.orderGrid}>
            <OrderState icon={<WalletCards size={20} color={colors.accentDeep} />} label="待付款" value={apiState === 'ready' ? String(counts.pendingPayment || 0) : '--'} />
            <OrderState icon={<Boxes size={20} color={colors.accentDeep} />} label="待发货" value={apiState === 'ready' ? String(counts.pendingShipment || 0) : '--'} />
            <OrderState icon={<Truck size={20} color={colors.accentDeep} />} label="待收货" value={apiState === 'ready' ? String(counts.pendingReceipt || 0) : '--'} />
            <OrderState icon={<ShieldAlert size={20} color={colors.danger} />} label="售后/仲裁" value={apiState === 'ready' ? String((counts.arbitration || 0) + (counts.refunding || 0)) : '--'} />
          </View>
          {apiState === 'ready' && summary?.orders.length ? summary.orders.map((order) => (
            <OrderCard
              key={order.orderId}
              order={order}
              afterSale={afterSaleResults[order.orderId]}
              busy={busyAction === `order:${order.orderId}` || busyAction === `after-sale:${order.orderId}`}
              onAction={() => handleOrderAction(order)}
              onSupport={() => setSupportOrder(order)}
              onAfterSale={(type) => { void handleAfterSale(order, type); }}
              onRetryDispute={() => { void handleRetryDispute(order); }}
            />
          )) : <InlineEmpty text={apiState === 'ready' ? '当前钱包暂无订单。' : '订单列表尚未成功加载。'} />}
        </Section>

        <Section title="双轨业务记录" action="链上 / 订单事件">
          {apiState === 'ready' && summary?.seckillRecords.length ? summary.seckillRecords.map((record, index) => (
            <SeckillRecordRow
              key={`${record.sessionId}:${record.orderId || index}`}
              record={record}
              busy={Boolean(record.prizeClaim?.rewardId && busyAction === `claim:${record.prizeClaim.rewardId}`)}
              onClaim={record.prizeClaim?.claimable && record.prizeClaim.rewardId ? () => handleClaim({ bucketId: 'seckill-prize', rewardId: record.prizeClaim!.rewardId!, title: '秒杀中奖 NPL' }) : undefined}
            />
          )) : <InlineEmpty text={apiState === 'ready' ? '暂无秒杀链上记录。' : '秒杀记录尚未成功加载。'} />}
          <View style={styles.divider} />
          {apiState === 'ready' && summary?.shoppingRecords.length ? summary.shoppingRecords.map((record, index) => <ShoppingRecordRow key={`${record.orderId}:${record.productId}:${index}`} record={record} />) : <InlineEmpty text={apiState === 'ready' ? '暂无常规购物记录。' : '购物记录尚未成功加载。'} />}
        </Section>

        <Section title="四大收益分红中心" action="Pull-based Claims">
          <View style={styles.claimGuard}>
            <View style={styles.claimGuardTextBlock}>
              <Text style={styles.claimGuardTitle}>Locked / Available / PendingClaim / Claimed</Text>
              <Text style={styles.claimGuardText}>Claim 状态以 assets-state 和 claim-tx-status 为准；后端 Circuit Breaker 拒绝时会直接报错。</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="刷新资产状态" disabled={apiState === 'loading'} onPress={() => refreshAssets()} style={styles.refreshButton}>
              {apiState === 'loading' ? <ActivityIndicator color={colors.pageDeep} /> : <RefreshCw size={18} color={colors.pageDeep} />}
            </Pressable>
          </View>
          {apiState === 'ready' && visibleBuckets.length ? visibleBuckets.map((bucket) => {
            const reward = availableReward(bucket.id);
            return (
              <BucketCard
                key={bucket.id}
                bucket={bucket}
                rewardId={reward?.id}
                busy={Boolean(reward && busyAction === `claim:${reward.id}`)}
                onClaim={reward ? () => handleClaim({ bucketId: bucket.id, rewardId: reward.id, title: bucket.title }) : undefined}
              />
            );
          }) : <InlineEmpty text={apiState === 'ready' ? '当前钱包暂无真实奖励流水，因此不显示余额池。' : '收益池尚未成功加载。'} />}
        </Section>

        <Section title="资产流水与 Claim 记录" action="TxHash 溯源">
          {apiState === 'ready' && summary?.ledger.length ? summary.ledger.map((entry) => <LedgerRow key={entry.id} entry={entry} />) : <InlineEmpty text={apiState === 'ready' ? '暂无真实资产流水。' : '资产流水尚未成功加载。'} />}
          <View style={styles.divider} />
          {apiState === 'ready' && summary?.claims.length ? summary.claims.map((record) => <ClaimRow key={record.id} record={record} />) : <InlineEmpty text={apiState === 'ready' ? '暂无 Claim 记录。' : 'Claim 记录尚未成功加载。'} />}
        </Section>
      </ScrollView>

      <Modal visible={addressReview !== null} transparent animationType="fade" onRequestClose={() => { if (!addressBusy) setAddressReview(null); }}>
        <View style={styles.modalBackdrop}>
          <View style={styles.reviewCard}>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭地址复核" disabled={addressBusy} onPress={() => setAddressReview(null)} style={styles.modalClose}><X size={18} color={colors.ink} /></Pressable>
            <Text style={styles.reviewEyebrow}>ADDRESS REVIEW</Text>
            <Text style={styles.reviewTitle}>{editingAddressId ? '修改地址二次确认' : '地址仓二次确认'}</Text>
            <ReviewLine label="姓名" value={addressReview?.parsed.name} />
            <ReviewLine label="电话" value={addressReview?.parsed.phone} />
            <ReviewLine label="省 / 市 / 区" value={[addressReview?.parsed.province, addressReview?.parsed.city, addressReview?.parsed.district].filter(Boolean).join(' ')} />
            <ReviewLine label="详细地址" value={addressReview?.parsed.detail} />
            <ReviewLine label="行政区编码" value={addressReview?.parsed.regionCode} />
            {addressReview?.missing.length ? <Text style={styles.reviewWarning}>{addressReview.warning} 缺失：{addressReview.missing.join(' / ')}</Text> : null}
            <View style={styles.reviewActions}>
              <Pressable accessibilityRole="button" disabled={addressBusy} onPress={() => setAddressReview(null)} style={styles.reviewCancel}><Text style={styles.reviewCancelText}>返回修改</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={editingAddressId ? '修改复核后的地址' : '保存复核后的地址'} disabled={addressBusy || Boolean(addressReview?.missing.length)} onPress={handleSaveAddress} style={[styles.reviewSave, (addressBusy || Boolean(addressReview?.missing.length)) && styles.buttonDisabled]}>
                {addressBusy ? <ActivityIndicator color={colors.pageDeep} /> : <Text style={styles.reviewSaveText}>{editingAddressId ? '确认修改' : '确认保存'}</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={supportOrder !== null} transparent animationType="fade" onRequestClose={() => { if (!busyAction.startsWith('after-sale:')) setSupportOrder(null); }}>
        <View style={styles.modalBackdrop}>
          <View style={styles.reviewCard}>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭售后客服" disabled={busyAction.startsWith('after-sale:')} onPress={() => setSupportOrder(null)} style={styles.modalClose}><X size={18} color={colors.ink} /></Pressable>
            <Text style={styles.reviewEyebrow}>AFTER SALE</Text>
            <Text style={styles.reviewTitle}>联系客服 · {activeSupportOrder ? shortId(activeSupportOrder.orderId) : ''}</Text>
            <Text style={styles.supportPolicy}>实物订单仅处理商品故障换货或延迟自动签收，不提供无理由退款。申请后相关收益保持 Locked，直到平台完成 Arbitration。</Text>
            {activeSupportOrder ? <AfterSaleStatus order={activeSupportOrder} request={activeSupportRequest} /> : null}
            <View style={styles.supportActions}>
              {activeSupportRequest?.status === 'AwaitingDisputeTransaction' ? <Pressable accessibilityRole="button" disabled={busyAction.startsWith('after-sale:')} onPress={() => { if (activeSupportOrder) void handleRetryDispute(activeSupportOrder); }} style={[styles.supportAction, busyAction.startsWith('after-sale:') && styles.buttonDisabled]}><RefreshCw size={17} color={colors.pageDeep} /><Text style={styles.supportActionText}>重试链上仲裁</Text></Pressable> : <Pressable accessibilityRole="button" disabled={!supportCanRequest || busyAction.startsWith('after-sale:')} onPress={() => { if (activeSupportOrder) void handleAfterSale(activeSupportOrder, 'exchange'); }} style={[styles.supportAction, (!supportCanRequest || busyAction.startsWith('after-sale:')) && styles.buttonDisabled]}><RefreshCw size={17} color={colors.pageDeep} /><Text style={styles.supportActionText}>申请换货</Text></Pressable>}
              <Pressable accessibilityRole="button" disabled={!supportCanRequest || busyAction.startsWith('after-sale:')} onPress={() => { if (activeSupportOrder) void handleAfterSale(activeSupportOrder, 'delay'); }} style={[styles.supportAction, (!supportCanRequest || busyAction.startsWith('after-sale:')) && styles.buttonDisabled]}><Clock3 size={17} color={colors.pageDeep} /><Text style={styles.supportActionText}>申请延期</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Section({ title, action, children }: { title: string; action: string; children: React.ReactNode }) {
  return <View style={styles.sectionCard}><View style={styles.sectionHead}><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.sectionAction}>{action}</Text></View>{children}</View>;
}

function InlineEmpty({ text }: { text: string }) {
  return <View style={styles.inlineEmpty}><Text style={styles.inlineEmptyText}>{text}</Text></View>;
}

function HeroMetric({ label, value }: { label: string; value: string }) {
  return <View style={styles.heroMetric}><Text style={styles.heroMetricValue}>{value}</Text><Text style={styles.heroMetricLabel}>{label}</Text></View>;
}

function AddressRow({ entry, busy, selected, onEdit, onDelete, onSetDefault, onSelect }: { entry: AddressBookEntry; busy: boolean; selected: boolean; onEdit: () => void; onDelete: () => void; onSetDefault: () => void; onSelect: () => void }) {
  return (
    <View style={styles.addressRow}>
      <View style={styles.mapIcon}><CheckCircle2 size={18} color={colors.green} /></View>
      <View style={styles.addressBody}>
        <Text style={styles.addressName}>{entry.name} · {entry.phone}</Text>
        <Text style={styles.addressDetail}>{entry.province}{entry.city}{entry.district}{entry.detail}</Text>
        <Text style={styles.regionText}>行政区划 {entry.regionCode}{entry.isDefault ? ' · 默认地址' : ''}</Text>
        <View style={styles.addressActions}>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onEdit} style={[styles.addressAction, busy && styles.buttonDisabled]}><Text style={styles.addressActionText}>修改</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onDelete} style={[styles.addressAction, busy && styles.buttonDisabled]}><Text style={styles.addressActionText}>删除</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={busy || entry.isDefault} onPress={onSetDefault} style={[styles.addressAction, (busy || entry.isDefault) && styles.buttonDisabled]}><Text style={styles.addressActionText}>{entry.isDefault ? '已默认' : '设为默认'}</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityState={{ selected }} disabled={busy || selected} onPress={onSelect} style={[styles.addressSelectAction, selected && styles.addressSelectActionActive, busy && styles.buttonDisabled]}><Text style={[styles.addressSelectActionText, selected && styles.addressSelectActionTextActive]}>{selected ? '配送已选' : '用于配送'}</Text></Pressable>
        </View>
      </View>
    </View>
  );
}

function OrderState({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <View style={styles.orderState}><View style={styles.orderIcon}>{icon}</View><Text style={styles.orderValue}>{value}</Text><Text style={styles.orderLabel}>{label}</Text></View>;
}

function OrderCard({ order, afterSale, busy, onAction, onSupport, onAfterSale, onRetryDispute }: { order: AssetOrder; afterSale?: AfterSaleRequestRecord; busy: boolean; onAction: () => void; onSupport: () => void; onAfterSale: (type: AfterSaleRequestType) => void; onRetryDispute: () => void }) {
  const action = order.primaryAction;
  const currentAfterSale = orderAfterSale(order, afterSale);
  const afterSaleActive = isAfterSaleActive(order, currentAfterSale);
  const actionConflicts = afterSaleActive && (action?.key === 'completeOrder' || action?.key === 'requestTimeoutRefund');
  const actionEnabled = action?.enabled !== false && Boolean(action?.key) && !actionConflicts;
  const afterSaleEnabled = canRequestAfterSale(order, currentAfterSale);
  const showSupport = canContactSupport(order) || afterSaleActive;
  const fulfillmentStatus = stringField(order.fulfillment, 'status') || order.confirmability?.fulfillmentStatus || '待同步';
  return (
    <View style={styles.orderCard}>
      <View style={styles.orderCardHeader}>
        <PackageCheck size={21} color={afterSaleActive ? colors.danger : colors.accentDeep} />
        <View style={styles.orderCardBody}>
          <Text style={styles.orderCardTitle}>订单 {shortId(order.orderId)} · {order.status}</Text>
          <Text style={styles.orderCardText}>{order.fulfillmentMode === 'pickup' ? '门店自提' : '快递履约'} · {fulfillmentStatus} · {order.amountNpl} NPL</Text>
          {order.releasePreview?.availableIncrease ? <Text style={styles.releaseText}>确认后可用 BNM +{order.releasePreview.availableIncrease}</Text> : null}
        </View>
      </View>
      <AfterSaleStatus order={order} request={currentAfterSale} />
      {currentAfterSale?.status === 'AwaitingDisputeTransaction' ? <Pressable accessibilityRole="button" disabled={busy} onPress={onRetryDispute} style={[styles.orderAction, busy && styles.buttonDisabled]}>{busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.orderActionText}>发送 / 重试 disputeOrder</Text>}</Pressable> : null}
      {showSupport ? (
        <View style={styles.orderSupportActions}>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onSupport} style={[styles.orderSupportButton, busy && styles.buttonDisabled]}><FileSearch size={15} color={colors.accentDeep} /><Text style={styles.orderSupportText}>联系客服</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={busy || !afterSaleEnabled} onPress={() => onAfterSale('exchange')} style={[styles.orderSupportButton, (busy || !afterSaleEnabled) && styles.buttonDisabled]}><RefreshCw size={15} color={colors.accentDeep} /><Text style={styles.orderSupportText}>申请换货</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={busy || !afterSaleEnabled} onPress={() => onAfterSale('delay')} style={[styles.orderSupportButton, (busy || !afterSaleEnabled) && styles.buttonDisabled]}><Clock3 size={15} color={colors.accentDeep} /><Text style={styles.orderSupportText}>申请延期</Text></Pressable>
        </View>
      ) : null}
      {action?.label ? (
        <Pressable accessibilityRole="button" accessibilityHint={actionConflicts ? '售后仲裁期间不能确认收货或申请退款' : undefined} disabled={busy || !actionEnabled} onPress={onAction} style={[styles.orderAction, (!actionEnabled || busy) && styles.buttonDisabled]}>
          {busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.orderActionText}>{action.label}</Text>}
        </Pressable>
      ) : null}
    </View>
  );
}

function AfterSaleStatus({ order, request }: { order: AssetOrder; request?: AfterSaleRequestRecord | null }) {
  const current = orderAfterSale(order, request || undefined);
  if (!current && order.status !== 'Arbitration' && !order.afterSale?.active) return null;
  const status = current?.status || order.status;
  const lockState = current?.lockState || order.afterSale?.assetState || (order.status === 'Arbitration' ? 'Locked' : '');
  return (
    <View style={styles.afterSaleStatus}>
      <View style={styles.afterSaleStatusHead}><ShieldAlert size={15} color={colors.danger} /><Text style={styles.afterSaleStatusTitle}>{status}{lockState ? ` / ${lockState}` : ''}</Text></View>
      <Text style={styles.afterSaleStatusText}>{current?.type === 'exchange' ? '换货申请' : current?.type === 'delay' ? '延期申请' : '售后仲裁'} · 处理结果：{afterSaleResultCopy(current?.result)}</Text>
    </View>
  );
}

function ShoppingRecordRow({ record }: { record: ShoppingRecord }) {
  return <View style={styles.trackCard}><PackageCheck size={20} color={colors.green} /><View style={styles.trackBody}><Text style={styles.trackTitle}>{record.title}</Text><Text style={styles.trackText}>{record.skuName || '默认 SKU'} × {record.quantity} · {record.amountNpl} NPL · {record.status}</Text></View></View>;
}

function SeckillRecordRow({ record, busy, onClaim }: { record: SeckillRecord; busy: boolean; onClaim?: () => void }) {
  return (
    <View style={styles.trackCard}>
      <Gift size={20} color={colors.accentDeep} />
      <View style={styles.trackBody}>
        <Text style={styles.trackTitle}>秒杀 {shortId(record.sessionId)} · {record.eventName}</Text>
        <Text style={styles.trackText}>{record.prizeClaim ? `奖金状态 ${record.prizeClaim.status}${record.prizeClaim.amount === undefined ? '' : ` · ${formatNpl(record.prizeClaim.amount)} NPL`}` : '等待场次结算'}</Text>
        {record.txHash ? <Text selectable style={styles.inlineTx}>{record.txHash}</Text> : null}
      </View>
      {onClaim ? <Pressable accessibilityRole="button" disabled={busy} onPress={onClaim} style={[styles.claimMiniButton, busy && styles.buttonDisabled]}>{busy ? <ActivityIndicator color={colors.pageDeep} /> : <Text style={styles.claimMini}>提取奖金</Text>}</Pressable> : null}
    </View>
  );
}

function BucketCard({ bucket, rewardId, busy, onClaim }: { bucket: AssetBucket; rewardId?: string; busy: boolean; onClaim?: () => void }) {
  return (
    <View style={styles.bucketCard}>
      <View style={styles.bucketTop}>
        <View style={styles.bucketIcon}><Coins size={20} color={colors.accentDeep} /></View>
        <View style={styles.bucketTitleBlock}><Text style={styles.bucketTitle}>{bucket.title}</Text><Text style={styles.bucketSymbol}>{bucket.assetSymbol} · 自理 Gas</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={`提取 ${bucket.title}`} disabled={!rewardId || busy} onPress={onClaim} style={[styles.claimButton, (!rewardId || busy) && styles.buttonDisabled]}>
          {busy ? <ActivityIndicator color={colors.white} /> : <Text style={styles.claimButtonText}>{rewardId ? 'Claim' : '暂无可领'}</Text>}
        </Pressable>
      </View>
      <View style={styles.bucketStats}><MiniStat label="累计" value={bucket.cumulative} /><MiniStat label="待领取" value={bucket.available} active /><MiniStat label="锁定中" value={bucket.locked} locked /></View>
      {bucket.unlockPolicy ? <Text style={styles.bucketPolicy}>{bucket.unlockPolicy}</Text> : null}
    </View>
  );
}

function MiniStat({ label, value, active = false, locked = false }: { label: string; value: number; active?: boolean; locked?: boolean }) {
  return <View style={[styles.miniStat, active && styles.miniStatActive]}>{locked ? <LockKeyhole size={13} color={colors.inkMuted} /> : null}<Text style={[styles.miniStatValue, active && styles.miniStatValueActive]}>{formatNpl(value)}</Text><Text style={[styles.miniStatLabel, active && styles.miniStatLabelActive]}>{label}</Text></View>;
}

function LedgerRow({ entry }: { entry: RewardLedgerEntry }) {
  return <View style={styles.ledgerRow}><Clock3 size={16} color={entry.state === 'Available' ? colors.green : colors.inkMuted} /><View style={styles.ledgerBody}><Text style={styles.ledgerTitle}>{entry.source}</Text><Text style={styles.ledgerMeta}>{entry.state}</Text>{entry.txHash ? <Text selectable style={styles.inlineTx}>{entry.txHash}</Text> : null}</View><Text style={styles.ledgerAmount}>{formatNpl(entry.amount)} {entry.assetSymbol}</Text></View>;
}

function ClaimRow({ record }: { record: ClaimRecord }) {
  return <View style={styles.ledgerRow}><CheckCircle2 size={16} color={record.status === 'success' ? colors.green : record.status === 'failed' ? colors.danger : colors.warning} /><View style={styles.ledgerBody}><Text style={styles.ledgerTitle}>Claim {record.assetSymbol} · {record.status}</Text><Text style={styles.ledgerMeta}>{record.createdAt || '时间待同步'}</Text>{record.txHash ? <Text selectable style={styles.inlineTx}>{record.txHash}</Text> : null}</View><Text style={styles.ledgerAmount}>{formatNpl(record.amount)} {record.assetSymbol}</Text></View>;
}

function ReviewLine({ label, value }: { label: string; value: unknown }) {
  const text = String(value || '');
  return <View style={styles.reviewLine}><Text style={styles.reviewLabel}>{label}</Text><Text style={[styles.reviewValue, !text && styles.reviewValueMissing]}>{text || '缺失'}</Text></View>;
}

function requiredAddressFields(parsed: Partial<AddressBookEntry>) {
  return (['name', 'phone', 'province', 'city', 'district', 'detail', 'regionCode'] as const).filter((key) => !String(parsed[key] || '').trim());
}

async function pollClaimUntilFinal(walletAddress: string, rewardId: string, txHash: string, token: string, onUpdate: (status: ClaimTxStatusResponse) => void) {
  let latest = await fetchClaimTxStatus(walletAddress, rewardId, txHash, token);
  onUpdate(latest);
  for (let attempt = 0; latest.retryable && attempt < 29; attempt += 1) {
    await delay(3_000);
    latest = await fetchClaimTxStatus(walletAddress, rewardId, txHash, token);
    onUpdate(latest);
  }
  return latest;
}

async function pollCompleteUntilFinal(orderId: string, buyerAddress: string, txHash: string, token: string, onUpdate: (status: TxStatusResponse) => void) {
  let latest = await fetchCompleteTxStatus(orderId, buyerAddress, txHash, token);
  onUpdate(latest);
  for (let attempt = 0; latest.retryable && attempt < 29; attempt += 1) {
    await delay(3_000);
    latest = await fetchCompleteTxStatus(orderId, buyerAddress, txHash, token);
    onUpdate(latest);
  }
  return latest;
}

async function pollArbitrationUntilFinal(orderId: string, buyerAddress: string, txHash: string, token: string, onUpdate: (status: ArbitrationTxStatusResponse) => void) {
  let latest = await fetchArbitrationTxStatus(orderId, buyerAddress, txHash, token);
  onUpdate(latest);
  for (let attempt = 0; latest.retryable && attempt < 29; attempt += 1) {
    await delay(3_000);
    latest = await fetchArbitrationTxStatus(orderId, buyerAddress, txHash, token);
    onUpdate(latest);
  }
  return latest;
}

function claimStatusCopy(status: ClaimTxStatusResponse) {
  if (status.status === 'pending') return 'Claim 交易正在打包。';
  if (status.status === 'confirmed') return 'RewardClaimed 已确认。';
  if (status.status === 'failed') return `Claim 链上执行失败：${status.error || 'CHAIN_EVENT_TX_FAILED'}`;
  if (status.status === 'mismatch') return `Claim 事件与 rewardId 不匹配：${status.error || 'REWARD_EVENT_MISMATCH'}`;
  if (status.status === 'unavailable') return `该 rewardId 不是可轮询的链上 entry：${status.error || 'REWARD_ID_NOT_ONCHAIN_ENTRY'}`;
  return `Claim RPC 暂不可用：${status.error || 'RPC_UNAVAILABLE'}`;
}

function completeStatusCopy(status: TxStatusResponse) {
  if (status.status === 'pending') return 'completeOrder 交易正在打包。';
  if (status.status === 'confirming') return 'completeOrder 已打包，正在等待安全确认数。';
  if (status.status === 'confirmed') return 'OrderCompleted 已确认，托管与奖励已按后端状态流转。';
  if (status.status === 'failed') return `completeOrder 链上执行失败：${status.error || 'CHAIN_EVENT_TX_FAILED'}`;
  if (status.status === 'mismatch') return `OrderCompleted 事件不匹配：${status.error || 'CHAIN_EVENT_MISMATCH'}`;
  return `completeOrder RPC 暂不可用：${status.error || 'RPC_UNAVAILABLE'}`;
}

function arbitrationStatusCopy(status: ArbitrationTxStatusResponse) {
  if (status.status === 'pending') return 'disputeOrder 交易正在打包。';
  if (status.status === 'confirming') return 'disputeOrder 已打包，正在等待安全确认数。';
  if (status.status === 'confirmed') return 'OrderArbitration 已确认。';
  if (status.status === 'failed') return `disputeOrder 链上执行失败：${status.error || 'CHAIN_EVENT_TX_FAILED'}`;
  if (status.status === 'mismatch') return `OrderArbitration 事件不匹配：${status.error || 'CHAIN_EVENT_MISMATCH'}`;
  return `disputeOrder RPC 暂不可用：${status.error || 'RPC_UNAVAILABLE'}`;
}

function requireTxHash(value: string, action: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${action} 未返回有效 TxHash。`);
  return value;
}

function isWalletRejection(error: unknown) {
  return /4001|user rejected|rejected|denied|cancelled|canceled|拒绝|取消/i.test(error instanceof Error ? error.message : String(error || ''));
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function shortId(value: string) {
  return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function stringField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return '';
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : '';
}

function orderAfterSale(order: AssetOrder, local?: AfterSaleRequestRecord): AfterSaleRequestRecord | null {
  if (local) return local;
  return order.afterSale?.case || null;
}

function afterSaleResultMap(summary: DappAssetSummary) {
  return Object.fromEntries(summary.orders.flatMap((order) => order.afterSale?.case ? [[order.orderId, order.afterSale.case] as const] : []));
}

function isAfterSaleActive(order: AssetOrder, request?: AfterSaleRequestRecord | null) {
  if (order.status === 'Arbitration' || order.afterSale?.active) return true;
  const status = String(request?.status || '').toLowerCase();
  if (['resolved', 'rejected', 'closed', 'completed', 'cancelled', 'canceled'].includes(status)) return false;
  return ['arbitration', 'locked', 'pending', 'submitted', 'processing', 'reviewing', 'open', 'awaitingdisputetransaction', 'exchangeapproved', 'delayapproved', 'awaitingcompletiontransaction', 'awaitingrefundtransaction'].includes(status);
}

function canRequestAfterSale(order: AssetOrder, request?: AfterSaleRequestRecord | null) {
  const backendAvailable = order.afterSale?.available;
  return (backendAvailable ?? ['Shipped', 'PickupReady'].includes(order.status)) && !isAfterSaleActive(order, request);
}

function canContactSupport(order: AssetOrder) {
  return ['PaidLocked', 'AwaitingShipment', 'Shipped', 'PickupReady', 'Arbitration'].includes(order.status);
}

function afterSaleResultCopy(result?: string) {
  if (!result) return '等待平台处理';
  if (result === 'exchange') return '已批准换货';
  if (result === 'delay') return '已批准延期';
  if (result === 'resume') return '已恢复原订单流程';
  if (result === 'complete') return '已转入确认收货处理';
  if (result === 'refund') return '已转入平台退款处理';
  return result;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.page },
  screen: { flex: 1 },
  content: { paddingBottom: 118 },
  hero: { margin: spacing.lg, borderRadius: radius.xl, padding: spacing.lg, backgroundColor: colors.pageDeep, ...shadow.deep },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: spacing.lg },
  heroIdentity: { flex: 1 },
  kicker: { color: colors.accent, fontSize: 11, fontWeight: '900' },
  title: { color: colors.white, fontSize: 31, lineHeight: 36, fontWeight: '900' },
  walletLine: { marginTop: 3, color: '#D8D0C4', fontSize: 12, fontWeight: '800' },
  totalGrid: { flexDirection: 'row', gap: 9, marginTop: spacing.lg },
  heroMetric: { flex: 1, borderRadius: radius.md, backgroundColor: 'rgba(255,248,234,0.08)', borderWidth: 1, borderColor: 'rgba(255,248,234,0.10)', padding: spacing.md },
  heroMetricValue: { color: colors.accent, fontSize: 16, fontWeight: '900' },
  heroMetricLabel: { marginTop: 4, color: '#D8D0C4', fontSize: 11, fontWeight: '800' },
  statusCard: { marginHorizontal: spacing.lg, marginBottom: spacing.md, flexDirection: 'row', gap: 9, borderRadius: radius.lg, backgroundColor: colors.accentSoft, padding: spacing.md },
  statusCardError: { backgroundColor: '#FFF0EC' },
  statusCardSuccess: { backgroundColor: colors.greenSoft },
  statusText: { flex: 1, color: colors.accentDeep, fontSize: 12, lineHeight: 18, fontWeight: '700' },
  statusTextError: { color: colors.danger },
  stateNotice: { marginHorizontal: spacing.lg, marginBottom: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surfaceDark, padding: spacing.md },
  stateNoticeError: { backgroundColor: colors.brownDeep },
  stateTitle: { color: colors.gold, marginTop: 6, fontSize: 13, fontWeight: '900' },
  stateText: { color: colors.champagne, marginTop: 4, fontSize: 12, lineHeight: 17, fontWeight: '700' },
  txProgress: { marginHorizontal: spacing.lg, marginBottom: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surfaceDark, padding: spacing.md },
  txProgressTitle: { color: colors.gold, fontSize: 13, fontWeight: '900' },
  txHash: { color: colors.champagne, marginTop: 5, fontSize: 11, lineHeight: 17, fontWeight: '700' },
  sectionCard: { marginHorizontal: spacing.lg, marginBottom: spacing.md, borderRadius: radius.xl, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, padding: spacing.lg, ...shadow.soft },
  sectionHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing.sm, marginBottom: spacing.md },
  sectionTitle: { flex: 1, color: colors.ink, fontSize: 18, fontWeight: '900' },
  sectionAction: { color: colors.accentDeep, fontSize: 11, fontWeight: '900' },
  addressInput: { minHeight: 82, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted, color: colors.ink, padding: spacing.md, fontSize: 13, lineHeight: 19, fontWeight: '700', textAlignVertical: 'top' },
  parseButton: { marginTop: spacing.md, minHeight: 48, borderRadius: radius.round, backgroundColor: colors.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  parseButtonText: { color: colors.pageDeep, fontSize: 14, fontWeight: '900' },
  inlineEmpty: { borderRadius: radius.lg, backgroundColor: colors.surfaceMuted, padding: spacing.md, marginTop: spacing.sm },
  inlineEmptyText: { color: colors.inkMuted, fontSize: 12, lineHeight: 17, fontWeight: '800', textAlign: 'center' },
  addressRow: { marginTop: spacing.md, flexDirection: 'row', gap: 10, borderRadius: radius.lg, backgroundColor: colors.greenSoft, padding: spacing.md },
  mapIcon: { width: 34, height: 34, borderRadius: radius.round, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  addressBody: { flex: 1 },
  addressName: { color: colors.ink, fontSize: 14, fontWeight: '900' },
  addressDetail: { marginTop: 4, color: colors.inkMuted, fontSize: 12, lineHeight: 17, fontWeight: '700' },
  regionText: { marginTop: 5, color: colors.greenDeep, fontSize: 11, fontWeight: '900' },
  addressActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: spacing.sm },
  addressAction: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 8 },
  addressActionText: { color: colors.accentDeep, fontSize: 11, fontWeight: '900' },
  addressSelectAction: { minHeight: 40, borderRadius: radius.round, backgroundColor: colors.pageDeep, justifyContent: 'center', paddingHorizontal: 12 },
  addressSelectActionActive: { backgroundColor: colors.green },
  addressSelectActionText: { color: colors.white, fontSize: 11, fontWeight: '900' },
  addressSelectActionTextActive: { color: colors.pageDeep },
  orderGrid: { flexDirection: 'row', gap: 8 },
  orderState: { flex: 1, alignItems: 'center', borderRadius: radius.md, backgroundColor: colors.surfaceMuted, paddingVertical: spacing.md },
  orderIcon: { width: 34, height: 34, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
  orderValue: { marginTop: 7, color: colors.ink, fontSize: 16, fontWeight: '900' },
  orderLabel: { marginTop: 3, color: colors.inkMuted, fontSize: 10, fontWeight: '800' },
  orderCard: { marginTop: spacing.md, gap: 10, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted, padding: spacing.md },
  orderCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  orderCardBody: { flex: 1 },
  orderCardTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  orderCardText: { color: colors.inkMuted, marginTop: 4, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  releaseText: { color: colors.greenDeep, marginTop: 4, fontSize: 11, fontWeight: '900' },
  afterSaleStatus: { borderRadius: radius.md, backgroundColor: '#FFF0EC', padding: spacing.sm },
  afterSaleStatusHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  afterSaleStatusTitle: { color: colors.danger, fontSize: 11, fontWeight: '900' },
  afterSaleStatusText: { color: colors.danger, marginTop: 4, fontSize: 10, lineHeight: 15, fontWeight: '700' },
  orderSupportActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  orderSupportButton: { minHeight: 44, borderRadius: radius.round, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  orderSupportText: { color: colors.accentDeep, fontSize: 10, fontWeight: '900' },
  orderAction: { minHeight: 44, borderRadius: radius.round, backgroundColor: colors.pageDeep, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  orderActionText: { color: colors.white, fontSize: 11, lineHeight: 15, fontWeight: '900', textAlign: 'center' },
  trackCard: { flexDirection: 'row', gap: 10, alignItems: 'center', borderRadius: radius.lg, backgroundColor: colors.surfaceMuted, padding: spacing.md, marginBottom: 9 },
  trackBody: { flex: 1 },
  trackTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  trackText: { marginTop: 4, color: colors.inkMuted, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  inlineTx: { marginTop: 4, color: colors.accentDeep, fontSize: 10, lineHeight: 15, fontWeight: '700' },
  claimMiniButton: { minHeight: 40, borderRadius: radius.round, backgroundColor: colors.accent, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  claimMini: { color: colors.pageDeep, fontSize: 10, fontWeight: '900' },
  claimGuard: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: radius.lg, backgroundColor: colors.accentSoft, padding: spacing.md, marginBottom: 10 },
  claimGuardTextBlock: { flex: 1, minWidth: 0 },
  claimGuardTitle: { color: colors.pageDeep, fontSize: 12, fontWeight: '900' },
  claimGuardText: { marginTop: 4, color: colors.accentDeep, fontSize: 11, lineHeight: 16, fontWeight: '800' },
  refreshButton: { width: 44, height: 44, borderRadius: radius.round, borderWidth: 1, borderColor: colors.pageDeep, alignItems: 'center', justifyContent: 'center' },
  bucketCard: { borderRadius: radius.lg, backgroundColor: colors.surfaceMuted, padding: spacing.md, marginBottom: 10 },
  bucketTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bucketIcon: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  bucketTitleBlock: { flex: 1, minWidth: 0 },
  bucketTitle: { color: colors.ink, fontSize: 14, fontWeight: '900' },
  bucketSymbol: { marginTop: 3, color: colors.inkMuted, fontSize: 11, fontWeight: '800' },
  claimButton: { minHeight: 42, borderRadius: radius.round, backgroundColor: colors.pageDeep, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  claimButtonText: { color: colors.white, fontSize: 11, fontWeight: '900' },
  bucketStats: { flexDirection: 'row', gap: 8, marginTop: spacing.md },
  miniStat: { flex: 1, minHeight: 62, borderRadius: radius.md, backgroundColor: colors.surface, padding: spacing.sm, justifyContent: 'center' },
  miniStatActive: { backgroundColor: colors.greenSoft },
  miniStatValue: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  miniStatValueActive: { color: colors.greenDeep },
  miniStatLabel: { marginTop: 3, color: colors.inkMuted, fontSize: 10, fontWeight: '800' },
  miniStatLabelActive: { color: colors.greenDeep },
  bucketPolicy: { marginTop: spacing.sm, color: colors.inkMuted, fontSize: 10, lineHeight: 15, fontWeight: '700' },
  ledgerRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  ledgerBody: { flex: 1, minWidth: 0 },
  ledgerTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  ledgerMeta: { marginTop: 3, color: colors.inkMuted, fontSize: 11, fontWeight: '700' },
  ledgerAmount: { color: colors.accentDeep, fontSize: 11, fontWeight: '900' },
  divider: { height: 8 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.62)', justifyContent: 'center', padding: spacing.lg },
  reviewCard: { width: '100%', maxWidth: 540, alignSelf: 'center', borderRadius: radius.xl, backgroundColor: colors.surface, padding: spacing.xl },
  modalClose: { position: 'absolute', top: 12, right: 12, width: 44, height: 44, borderRadius: radius.round, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  reviewEyebrow: { color: colors.accentDeep, fontSize: 11, fontWeight: '900' },
  reviewTitle: { color: colors.ink, marginTop: 5, marginBottom: spacing.md, paddingRight: 48, fontSize: 22, fontWeight: '900' },
  reviewLine: { paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  reviewLabel: { color: colors.inkMuted, fontSize: 10, fontWeight: '900' },
  reviewValue: { color: colors.ink, marginTop: 4, fontSize: 13, lineHeight: 18, fontWeight: '800' },
  reviewValueMissing: { color: colors.danger },
  reviewWarning: { marginTop: spacing.md, borderRadius: radius.md, backgroundColor: '#FFF0EC', color: colors.danger, padding: spacing.md, fontSize: 12, lineHeight: 18, fontWeight: '800' },
  supportPolicy: { color: colors.inkMuted, marginBottom: spacing.md, fontSize: 13, lineHeight: 20, fontWeight: '700' },
  supportActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  supportAction: { flex: 1, minHeight: 48, borderRadius: radius.md, backgroundColor: colors.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  supportActionText: { color: colors.pageDeep, fontSize: 12, fontWeight: '900' },
  reviewActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  reviewCancel: { flex: 1, minHeight: 48, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  reviewCancelText: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  reviewSave: { flex: 1.4, minHeight: 48, borderRadius: radius.md, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  reviewSaveText: { color: colors.pageDeep, fontSize: 13, fontWeight: '900' },
  buttonDisabled: { opacity: 0.48 },
  pressed: { opacity: 0.72 }
});
