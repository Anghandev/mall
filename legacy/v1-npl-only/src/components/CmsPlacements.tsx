import { useEffect, useRef, useState } from 'react';
import { Image, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import { BookOpen, ChevronRight, Download, FileText, Megaphone, X } from 'lucide-react-native';
import { fetchCmsPlacements } from '../services/api';
import type { CmsPlacement } from '../services/api';
import { colors, radius, shadow, spacing } from '../theme/tokens';

type Props = {
  regionCode?: string;
};

const APP_VERSION = Application.nativeApplicationVersion || '0.1.0';
const CMS_IMPRESSION_PREFIX = '@24k/cms-impression';

export function CmsPlacements({ regionCode }: Props) {
  const [banner, setBanner] = useState<CmsPlacement | null>(null);
  const [faq, setFaq] = useState<CmsPlacement | null>(null);
  const [legal, setLegal] = useState<CmsPlacement | null>(null);
  const [dialog, setDialog] = useState<CmsPlacement | null>(null);
  const [actionError, setActionError] = useState('');
  const automaticDialogShownRef = useRef(false);
  const shownThisSessionRef = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    fetchCmsPlacements({ regionCode, appVersion: APP_VERSION })
      .then(async ({ placements }) => {
        if (!active) return;
        const ordered = [...placements].sort((left, right) => regionalPriority(right, regionCode) - regionalPriority(left, regionCode));
        const forceUpdate = ordered.find((placement) => placement.kind === 'update' && placement.forceUpdate) || null;
        const nextFaq = ordered.find((placement) => placement.kind === 'faq') || null;
        const nextLegal = ordered.find((placement) => placement.kind === 'legal') || null;
        const nextBanner = await firstEligible(ordered.filter((placement) => placement.kind === 'banner'), shownThisSessionRef.current);
        if (!active) return;
        setFaq(nextFaq);
        setLegal(nextLegal);
        setBanner(nextBanner);
        if (nextBanner) await markPresented(nextBanner, shownThisSessionRef.current);
        if (forceUpdate) {
          setActionError('');
          setDialog(forceUpdate);
          return;
        }
        if (automaticDialogShownRef.current) return;
        const automatic = await firstEligible(
          ordered.filter((placement) => placement.kind === 'update' || placement.kind === 'popup'),
          shownThisSessionRef.current
        );
        if (!active || !automatic) return;
        automaticDialogShownRef.current = true;
        await markPresented(automatic, shownThisSessionRef.current);
        setActionError('');
        setDialog(automatic);
      })
      .catch(() => {
        if (!active) return;
        setBanner(null);
        setFaq(null);
        setLegal(null);
      });
    return () => { active = false; };
  }, [regionCode]);

  const hasUtilityLinks = Boolean(faq || legal);
  const forceUpdateOpen = dialog?.kind === 'update' && dialog.forceUpdate;

  function openContent(placement: CmsPlacement) {
    setActionError('');
    setDialog(placement);
  }

  function dismissDialog() {
    if (forceUpdateOpen) return;
    setActionError('');
    setDialog(null);
  }

  async function openAction() {
    if (!dialog?.actionUrl) return;
    try {
      setActionError('');
      await Linking.openURL(dialog.actionUrl);
    } catch {
      setActionError('更新或内容链接无法打开，请检查系统浏览器。');
    }
  }

  return (
    <>
      {banner || hasUtilityLinks ? (
        <View style={[styles.bar, !banner && styles.barCompact]}>
          {banner ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`查看公告 ${banner.title}`} onPress={() => openContent(banner)} style={({ pressed }) => [styles.bannerButton, pressed && styles.pressed]}>
              {banner.mediaUrl ? <Image source={{ uri: banner.mediaUrl }} resizeMode="cover" style={styles.bannerImage} /> : <View style={styles.bannerIcon}><Megaphone size={20} color={colors.gold} /></View>}
              <View style={styles.bannerCopy}>
                <Text style={styles.bannerEyebrow}>24K NOTICE</Text>
                <Text numberOfLines={1} style={styles.bannerTitle}>{banner.title || '商城公告'}</Text>
                {banner.body ? <Text numberOfLines={1} style={styles.bannerBody}>{banner.body}</Text> : null}
              </View>
              <ChevronRight size={17} color={colors.champagne} />
            </Pressable>
          ) : <Text style={styles.utilityTitle}>24K 服务</Text>}
          {hasUtilityLinks ? (
            <View style={styles.utilityLinks}>
              {faq ? <Pressable accessibilityRole="button" accessibilityLabel="打开常见问题" onPress={() => openContent(faq)} style={styles.utilityButton}><BookOpen size={17} color={colors.champagne} /><Text style={styles.utilityText}>FAQ</Text></Pressable> : null}
              {legal ? <Pressable accessibilityRole="button" accessibilityLabel="打开服务协议和隐私政策" onPress={() => openContent(legal)} style={styles.utilityButton}><FileText size={17} color={colors.champagne} /><Text style={styles.utilityText}>条款</Text></Pressable> : null}
            </View>
          ) : null}
        </View>
      ) : null}

      <Modal visible={dialog !== null} transparent animationType="fade" onRequestClose={dismissDialog}>
        <View style={[styles.backdrop, forceUpdateOpen && styles.backdropBlocking]}>
          <View style={[styles.dialog, forceUpdateOpen && styles.dialogBlocking]}>
            {!forceUpdateOpen ? <Pressable accessibilityRole="button" accessibilityLabel="关闭内容" onPress={dismissDialog} style={styles.closeButton}><X size={19} color={colors.ink} /></Pressable> : null}
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.dialogContent}>
              <View style={[styles.dialogIcon, forceUpdateOpen && styles.dialogIconBlocking]}>{dialog?.kind === 'update' ? <Download size={22} color={forceUpdateOpen ? colors.pageDeep : colors.accentDeep} /> : dialog?.kind === 'legal' ? <FileText size={22} color={colors.accentDeep} /> : <Megaphone size={22} color={colors.accentDeep} />}</View>
              <Text style={[styles.dialogEyebrow, forceUpdateOpen && styles.dialogEyebrowBlocking]}>{forceUpdateOpen ? '必须更新' : placementLabel(dialog?.kind)}</Text>
              <Text style={[styles.dialogTitle, forceUpdateOpen && styles.dialogTitleBlocking]}>{dialog?.title || '内容详情'}</Text>
              {dialog?.minimumAppVersion || dialog?.version ? <Text style={[styles.version, forceUpdateOpen && styles.versionBlocking]}>{dialog.minimumAppVersion ? `要求 ${dialog.minimumAppVersion}` : `内容版本 ${dialog.version}`} · 当前 {APP_VERSION}</Text> : null}
              <Text style={[styles.dialogBody, forceUpdateOpen && styles.dialogBodyBlocking]}>{dialog?.body || '后台暂未提供详细内容。'}</Text>
              {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}
              {dialog?.actionUrl ? <Pressable accessibilityRole="link" onPress={() => { void openAction(); }} style={[styles.primaryAction, forceUpdateOpen && styles.primaryActionBlocking]}><Text style={[styles.primaryActionText, forceUpdateOpen && styles.primaryActionTextBlocking]}>{dialog.actionLabel || (dialog.kind === 'update' ? '立即更新' : '查看详情')}</Text><ChevronRight size={18} color={forceUpdateOpen ? colors.pageDeep : colors.white} /></Pressable> : forceUpdateOpen ? <View style={styles.missingUpdate}><Text style={styles.missingUpdateText}>后台未配置更新地址，当前版本保持锁定。</Text></View> : null}
              {!forceUpdateOpen && dialog?.kind === 'update' ? <Pressable accessibilityRole="button" onPress={dismissDialog} style={styles.secondaryAction}><Text style={styles.secondaryActionText}>稍后提醒</Text></Pressable> : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

async function firstEligible(placements: CmsPlacement[], shownThisSession: Set<string>) {
  for (const placement of placements) {
    if (await shouldPresent(placement, shownThisSession)) return placement;
  }
  return null;
}

async function shouldPresent(placement: CmsPlacement, shownThisSession: Set<string>) {
  if (placement.forceUpdate || placement.frequency === 'always') return true;
  const key = impressionKey(placement);
  if (shownThisSession.has(key)) return true;
  const previous = await AsyncStorage.getItem(key);
  if (placement.frequency === 'once') return !previous;
  return previous !== localDayKey();
}

async function markPresented(placement: CmsPlacement, shownThisSession: Set<string>) {
  const key = impressionKey(placement);
  shownThisSession.add(key);
  if (placement.forceUpdate || placement.frequency === 'always') return;
  await AsyncStorage.setItem(key, placement.frequency === 'daily' ? localDayKey() : new Date().toISOString());
}

function impressionKey(placement: CmsPlacement) {
  return `${CMS_IMPRESSION_PREFIX}/${placement.kind}/${placement.id}/${placement.version || '1'}`;
}

function localDayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function placementLabel(kind?: CmsPlacement['kind']) {
  if (kind === 'faq') return '常见问题';
  if (kind === 'legal') return '服务与隐私';
  if (kind === 'update') return '版本更新';
  if (kind === 'banner') return '商城公告';
  return '活动通知';
}

function regionalPriority(placement: CmsPlacement, regionCode?: string) {
  return regionCode && placement.regionCodes.includes(regionCode) ? 1 : 0;
}

const styles = StyleSheet.create({
  bar: { minHeight: 74, backgroundColor: colors.surfaceDark, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.lineDark, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  barCompact: { minHeight: 46, justifyContent: 'space-between' },
  bannerButton: { flex: 1, minWidth: 0, minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  bannerImage: { width: 48, height: 48, borderRadius: radius.sm, backgroundColor: colors.surfaceDarkElevated },
  bannerIcon: { width: 48, height: 48, borderRadius: radius.sm, backgroundColor: colors.surfaceDarkElevated, alignItems: 'center', justifyContent: 'center' },
  bannerCopy: { flex: 1, minWidth: 0 },
  bannerEyebrow: { color: colors.gold, fontSize: 9, fontWeight: '900' },
  bannerTitle: { color: colors.white, marginTop: 2, fontSize: 13, fontWeight: '900' },
  bannerBody: { color: colors.champagne, marginTop: 2, fontSize: 10, fontWeight: '700' },
  utilityTitle: { color: colors.champagne, fontSize: 12, fontWeight: '900' },
  utilityLinks: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  utilityButton: { minWidth: 44, minHeight: 44, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center', gap: 2 },
  utilityText: { color: colors.champagne, fontSize: 9, fontWeight: '900' },
  pressed: { opacity: 0.72 },
  backdrop: { flex: 1, backgroundColor: 'rgba(8,7,4,0.62)', justifyContent: 'center', padding: spacing.lg },
  backdropBlocking: { backgroundColor: 'rgba(8,7,4,0.94)' },
  dialog: { width: '100%', maxWidth: 540, maxHeight: '86%', alignSelf: 'center', borderRadius: radius.lg, backgroundColor: colors.surface, padding: spacing.xl, ...shadow.deep },
  dialogBlocking: { backgroundColor: colors.surfaceDarkElevated, borderWidth: 1, borderColor: colors.gold },
  dialogContent: { flexGrow: 1 },
  closeButton: { position: 'absolute', top: 12, right: 12, zIndex: 2, width: 44, height: 44, borderRadius: radius.round, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  dialogIcon: { width: 46, height: 46, borderRadius: radius.md, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  dialogIconBlocking: { backgroundColor: colors.gold },
  dialogEyebrow: { color: colors.accentDeep, marginTop: spacing.md, fontSize: 10, fontWeight: '900' },
  dialogEyebrowBlocking: { color: colors.gold },
  dialogTitle: { color: colors.ink, marginTop: 4, paddingRight: 42, fontSize: 23, lineHeight: 29, fontWeight: '900' },
  dialogTitleBlocking: { color: colors.white, paddingRight: 0 },
  version: { color: colors.inkMuted, marginTop: 6, fontSize: 11, fontWeight: '800' },
  versionBlocking: { color: colors.champagne },
  dialogBody: { color: colors.inkMuted, marginTop: spacing.md, fontSize: 14, lineHeight: 22, fontWeight: '700' },
  dialogBodyBlocking: { color: colors.white },
  actionError: { color: colors.danger, marginTop: spacing.md, fontSize: 12, lineHeight: 18, fontWeight: '800' },
  primaryAction: { minHeight: 50, marginTop: spacing.lg, borderRadius: radius.md, backgroundColor: colors.pageDeep, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  primaryActionBlocking: { backgroundColor: colors.gold },
  primaryActionText: { color: colors.white, fontSize: 14, fontWeight: '900' },
  primaryActionTextBlocking: { color: colors.pageDeep },
  secondaryAction: { minHeight: 46, marginTop: spacing.sm, alignItems: 'center', justifyContent: 'center' },
  secondaryActionText: { color: colors.inkMuted, fontSize: 13, fontWeight: '900' },
  missingUpdate: { marginTop: spacing.lg, borderRadius: radius.md, backgroundColor: colors.brownDeep, padding: spacing.md },
  missingUpdateText: { color: colors.champagne, fontSize: 12, lineHeight: 18, fontWeight: '800', textAlign: 'center' }
});
