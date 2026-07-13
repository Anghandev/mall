import { Pressable, StyleSheet, Text, View } from 'react-native';
import { WalletCards } from 'lucide-react-native';
import { colors, radius } from '../theme/tokens';
import { shortAddress } from '../services/orderMath';

type Props = {
  address?: string;
  chainId?: string;
  isConnected: boolean;
  isProjectConfigured: boolean;
  onPress: () => void;
};

export function WalletPill({ address, chainId, isConnected, isProjectConfigured, onPress }: Props) {
  const status = !isProjectConfigured
    ? '配置 Reown Project ID'
    : isConnected
      ? `${shortAddress(address)} · BSC ${chainId || ''}`
      : '连接钱包';

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.wrap, pressed && styles.pressed]}>
      <View style={styles.icon}><WalletCards size={18} color={colors.accent} /></View>
      <Text style={styles.text}>{status}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    borderRadius: radius.round,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  pressed: {
    opacity: 0.7
  },
  icon: {
    width: 26,
    height: 26,
    borderRadius: radius.round,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center'
  },
  text: {
    color: colors.accentDeep,
    fontSize: 13,
    fontWeight: '800'
  }
});
