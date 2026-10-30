import { hashKey } from '@tanstack/react-query';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { queryClient } from '../api/client.js';
import { validFilename } from './inline-file-rename-model.js';
import { getFileDirectoryIcon } from './integrations.js';
import { fileDirectoryQuery, type ServerFile } from './service-contracts.js';
import { readViewerBytes, viewerPath } from './viewer-engine/core/access.js';

const iconByteLimit = 256 * 1024;
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

/** Bound decoding work before creating an image; the browser validates the remaining PNG. */
export function validDirectoryIconPng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 33 || bytes.byteLength > iconByteLimit) return false;
  if (pngSignature.some((value, index) => bytes[index] !== value)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return false;
  const width = view.getUint32(16),
    height = view.getUint32(20);
  return width > 0 && height > 0 && width <= 512 && height <= 512;
}

interface DirectoryIconProps {
  serverId: string;
  gameId: string;
  runtimeId: string;
  path: string;
  children: ReactNode;
}

function DirectoryAsset({
  icon,
  children,
}: {
  icon: ReturnType<typeof getFileDirectoryIcon>;
  children: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return icon?.src && !failed ? (
    <img
      className="fm-icon fm-type-directory-asset"
      data-directory-asset={icon.assetId}
      src={icon.src}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
    />
  ) : (
    children
  );
}

/** Only visible rows retain metadata observers or fetch optional artwork. */
export function FileDirectoryIcon(props: DirectoryIconProps) {
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const icon = getFileDirectoryIcon(props.gameId, props.runtimeId, props.path, []);
  useEffect(() => {
    if (!element.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  return (
    <span ref={element} className="fm-icon fm-directory-icon-shell" aria-hidden="true">
      {visible ? (
        <VisibleDirectoryIcon {...props} />
      ) : (
        <DirectoryAsset key={icon?.src} icon={icon}>
          {props.children}
        </DirectoryAsset>
      )}
    </span>
  );
}

function VisibleDirectoryIcon({ serverId, gameId, runtimeId, path, children }: DirectoryIconProps) {
  const query = fileDirectoryQuery(serverId, path, { prepareDownloads: false });
  // Observe metadata without creating queries: a new idle query during a prefetch would
  // invalidate its captured state and prevent Fileman's guarded cache write.
  const queryHash = hashKey(query.queryKey);
  const subscribe = useCallback(
    (listener: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryHash === queryHash) listener();
      }),
    [queryHash],
  );
  const listing = useSyncExternalStore(
    subscribe,
    () => queryClient.getQueryCache().get<ServerFile[]>(queryHash)?.state,
    () => undefined,
  );
  const valid = Boolean(listing?.data && !listing.isInvalidated && listing.status === 'success');
  const icon = getFileDirectoryIcon(gameId, runtimeId, path, valid ? (listing?.data ?? []) : []);
  const name = icon?.file;
  const entry = name ? listing?.data?.find((item) => item.name === name) : undefined;
  const safe =
    valid &&
    typeof name === 'string' &&
    validFilename(name) &&
    entry?.is_file &&
    !entry.is_symlink &&
    entry.size > 0 &&
    entry.size <= iconByteLimit;
  const source = safe
    ? viewerPath(serverId, { path: `${path}/${name}`, name, size: entry.size })
    : undefined;
  const revision = JSON.stringify([
    queryHash,
    gameId,
    runtimeId,
    source,
    entry?.modified_at,
    entry?.size,
    listing?.dataUpdatedAt,
    valid,
  ]);
  const [image, setImage] = useState<{ revision: string; url: string }>();
  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    let url: string | undefined;
    void (async () => {
      try {
        const bytes = await readViewerBytes(source, iconByteLimit, controller.signal);
        if (controller.signal.aborted || !validDirectoryIconPng(bytes)) return;
        url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
        const decoded = new Image();
        decoded.src = url;
        await decoded.decode();
        if (!controller.signal.aborted) setImage({ revision, url });
      } catch {
        // Optional artwork failure retains the integration's bundled icon or ordinary folder.
        if (url) URL.revokeObjectURL(url);
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, revision]);
  return image?.revision === revision ? (
    <img
      className="fm-icon fm-type-directory-artwork"
      src={image.url}
      alt=""
      draggable={false}
      onError={() => setImage(undefined)}
    />
  ) : (
    <DirectoryAsset key={icon?.src} icon={icon}>
      {children}
    </DirectoryAsset>
  );
}
