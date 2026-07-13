import { Pressable, StyleSheet, Text, View } from 'react-native';
import { FlameKindling, MapPinHouse, ShoppingBag, WalletCards } from 'lucide-react-native';
import { colors, radius } from '../theme/tokens';
import type { TabKey } from '../types';

type Props = {
  active: TabKey;
  onChange: (tab: TabKey) => void;
};

const tabs = [
  { key: 'seckill' as const, label: '秒杀大厅', Icon: FlameKindling, badge: 'LIVE' },
  { key: 'mall' as const, label: '常规商城', Icon: ShoppingBag },
  { key: 'stores' as const, label: '线下门店', Icon: MapPinHouse },
  { key: 'assets' as const, label: '我的资产', Icon: WalletCards }
];

export function BottomTabs({ active, onChange }: Props) {
  return (
    <View style={styles.wrap}>
      {tabs.map(({ key, label, Icon, badge }) => {
        const selected = active === key;
        return (
          <Pressable
            key={key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={label}
            onPress={() => onChange(key)}
            style={({ pressed }) => [styles.item, selected && styles.itemActive, pressed && styles.pressed]}
          >
            <View style={[styles.iconWrap, selected && styles.iconWrapActive]}>
              <Icon size={selected ? 25 : 24} strokeWidth={selected ? 2.55 : 2.05} color={selected ? colors.obsidian : 'rgba(247,231,189,0.72)'} />
              {badge ? <Text style={styles.badge}>{badge}</Text> : null}
            </View>
            <Text style={[styles.label, selected && styles.labelActive]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(215,163,71,0.20)',
    backgroundColor: colors.surfaceDark,
    paddingTop: 7,
    paddingBottom: 7
  },
  item: {
    flex: 1,
    minHeight: 62,
    marginHorizontal: 4,
    marginVertical: 3,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4
  },
  itemActive: {
    backgroundColor: colors.gold,
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3
  },
  pressed: {
    opacity: 0.72
  },
  iconWrap: {
    width: 50,
    height: 34,
    borderRadius: radius.round,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconWrapActive: {},
  badge: {
    position: 'absolute',
    top: -6,
    right: -4,
    height: 16,
    overflow: 'hidden',
    borderRadius: radius.round,
    backgroundColor: colors.danger,
    color: colors.white,
    fontSize: 8,
    lineHeight: 16,
    paddingHorizontal: 5,
    textAlign: 'center',
    fontWeight: '900'
  },
  label: {
    color: 'rgba(247,231,189,0.66)',
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: -0.2
  },
  labelActive: {
    color: colors.obsidian,
    fontWeight: '900'
  }
});
