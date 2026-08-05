import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

type Props = {
  label: string;
  value: string;
};

export function CopyableWallet({ label, value }: Props) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    let didCopy = false;
    try {
      if (typeof navigator.clipboard?.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        didCopy = true;
      }
    } catch {
      didCopy = false;
    }
    if (!didCopy) didCopy = copyWithLegacyInput(value);
    if (didCopy) setCopied(true);
  };
  return (
    <span className="copyable-wallet">
      <code title={value}>{value}</code>
      <button className="copyable-wallet-button" type="button" onClick={() => void copy()} aria-label={`复制${label}`}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? '已复制' : '复制'}
      </button>
    </span>
  );
}

function copyWithLegacyInput(value: string) {
  if (typeof document.execCommand !== 'function') return false;
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', 'true');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    input.remove();
  }
}
