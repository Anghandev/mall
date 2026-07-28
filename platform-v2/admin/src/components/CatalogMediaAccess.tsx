import type { MediaReadAccessProjection } from '@abu24k/core-artifacts';
import { Ban, ExternalLink, FileImage, LoaderCircle, Video } from 'lucide-react';
import { useState } from 'react';
import { fetchMediaReadAccess } from '../catalogAdminApi';
import { CoreApiError } from '../coreApi';
import { humanizeError } from '../display';

export function CatalogMediaAccess({ assetId, label, token }: { assetId: string; label: string; token: string }) {
  const [access, setAccess] = useState<MediaReadAccessProjection | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setAccess(await fetchMediaReadAccess(assetId, token));
    } catch (cause) {
      setAccess(null);
      setError(cause instanceof CoreApiError ? cause : new CoreApiError({
        code: 'ExternalBlocked', message: '媒体授权读取失败', status: 503,
      }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <article className="catalog-media-item">
      <div className="catalog-media-meta">
        <span>{label}</span>
        <code title={assetId}>{shortHash(assetId)}</code>
      </div>
      {!access ? (
        <button className="button button-quiet" type="button" onClick={() => void load()} disabled={loading}>
          {loading ? <LoaderCircle className="spin" aria-hidden="true" /> : <FileImage aria-hidden="true" />}
          {loading ? '获取中' : '查看媒体'}
        </button>
      ) : (
        <>
          <div className="catalog-media-frame">
            {access.contentType === 'video/mp4'
              ? <video aria-label={`${label}，平台校验视频`} controls preload="metadata" src={access.readUrl} />
              : <img src={access.readUrl} alt={`${label}，平台校验媒体`} loading="lazy" />}
          </div>
          <div className="catalog-media-access">
            {access.contentType === 'video/mp4' ? <Video aria-hidden="true" /> : <FileImage aria-hidden="true" />}
            <span>{access.contentType} · {access.accessScope}</span>
            <a href={access.readUrl} target="_blank" rel="noreferrer">新窗口<ExternalLink aria-hidden="true" /></a>
          </div>
          <small>有效至 {formatDate(access.expiresAt)}</small>
        </>
      )}
      {error ? <div className="catalog-inline-error" role="alert"><Ban aria-hidden="true" /><span>{humanizeError(error)}</span></div> : null}
    </article>
  );
}

function shortHash(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}
