import { StyleSheet, View, type ViewProps } from 'react-native';
import { colors, radius, shadow } from '../theme/tokens';

export function SectionCard({ style, ...props }: ViewProps) {
  return <View {...props} style={[styles.card, style]} />;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    ...shadow.soft
  }
});
