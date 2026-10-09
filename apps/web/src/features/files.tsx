import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, download, readText, upload } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import {
  ActionForm,
  Check,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  Section,
  Textarea,
  Time,
  text,
} from '../components/ui.js';
import { type ServerFile, serverPath, useServer, useTransfers } from './service-contracts.js';

const join = (directory: string, name: string) => [directory, name].filter(Boolean).join('/');
export function FilesPage({ serverId }: { serverId: string }) {
  const t = useT(),
    format = useFormat();
  const server = useServer(serverId),
    transfers = useTransfers(serverId);
  const [directory, setDirectory] = useState('');
  const [selected, setSelected] = useState<ServerFile>();
  const [mode, setMode] = useState<'mkdir' | 'new' | 'edit' | 'rename' | 'delete'>();
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [readError, setReadError] = useState<unknown>();
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false),
    [progress, setProgress] = useState<{ sent: number; total: number }>();
  const [uploadError, setUploadError] = useState<unknown>();
  const [uploaded, setUploaded] = useState(false);
  const [file, setFile] = useState<File>();
  const abort = useRef<AbortController | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const readAbort = useRef<AbortController | undefined>(undefined),
    readSequence = useRef(0);
  const files = useQuery({
    queryKey: ['files', serverId, directory],
    queryFn: ({ signal }) =>
      api<ServerFile[]>(`${serverPath(serverId)}/files?path=${encodeURIComponent(directory)}`, {
        signal,
      }),
  });
  useEffect(() => () => abort.current?.abort(), []);
  const cancelRead = useCallback(() => {
    readSequence.current++;
    readAbort.current?.abort();
    readAbort.current = undefined;
    setReading(false);
  }, []);
  function closeEditor() {
    if (dirty && !window.confirm(t('service.discardEdits'))) return;
    setDirty(false);
    cancelRead();
    setMode(undefined);
    setSelected(undefined);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: cancel outstanding reads on server or directory changes.
  useEffect(() => {
    cancelRead();
    setMode(undefined);
    setSelected(undefined);
    return () => {
      readSequence.current++;
      readAbort.current?.abort();
    };
  }, [serverId, directory, cancelRead]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const canManage = server.data?.permissions.manage === true;
  async function edit(entry: ServerFile) {
    cancelRead();
    const sequence = ++readSequence.current;
    const controller = new AbortController();
    readAbort.current = controller;
    setDirty(false);
    setSelected(entry);
    setMode('edit');
    setReading(true);
    setReadError(undefined);
    setContent('');
    try {
      const value = await readText(
        `${serverPath(serverId)}/files/content?path=${encodeURIComponent(join(directory, entry.name))}`,
        controller.signal,
      );
      if (sequence === readSequence.current && !controller.signal.aborted) setContent(value);
    } catch (error) {
      if (sequence === readSequence.current && !controller.signal.aborted) setReadError(error);
    } finally {
      if (sequence === readSequence.current) setReading(false);
    }
  }
  async function mutation(body: unknown) {
    await api(`${serverPath(serverId)}/files`, { body });
    setDirty(false);
    setMode(undefined);
    await files.refetch();
  }
  async function sendFile() {
    if (!file || uploading) return;
    setUploading(true);
    setProgress({ sent: 0, total: file.size });
    setUploadError(undefined);
    setUploaded(false);
    const controller = new AbortController();
    abort.current = controller;
    try {
      await upload(
        `${serverPath(serverId)}/files/upload?path=${encodeURIComponent(join(directory, file.name))}`,
        file,
        { signal: controller.signal, onProgress: (sent, total) => setProgress({ sent, total }) },
      );
      setUploaded(true);
      setFile(undefined);
      if (fileInput.current) fileInput.current.value = '';
      await files.refetch();
    } catch (error) {
      setUploadError(
        error instanceof DOMException && error.name === 'AbortError'
          ? { messageKey: 'service.uploadCancelled' }
          : error,
      );
    } finally {
      setUploading(false);
      abort.current = undefined;
    }
  }
  return (
    <>
      <Section>
        <div className="toolbar">
          <form
            className="path-form"
            onSubmit={(event) => {
              event.preventDefault();
              setDirectory(
                text(new FormData(event.currentTarget), 'path').replace(/^\/+|\/+$/g, ''),
              );
            }}
          >
            <Input key={directory} label={t('web.path')} name="path" defaultValue={directory} />
            <button type="submit" className="secondary">
              {t('service.openFolder')}
            </button>
          </form>
          {directory && (
            <button
              type="button"
              className="secondary"
              onClick={() => setDirectory(directory.split('/').slice(0, -1).join('/'))}
            >
              {t('service.parentFolder')}
            </button>
          )}
          {canManage && (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  cancelRead();
                  setMode('mkdir');
                }}
              >
                {t('service.newFolder')}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  cancelRead();
                  setContent('');
                  setMode('new');
                }}
              >
                {t('service.newFile')}
              </button>
            </>
          )}
        </div>
        {files.isPending ? (
          <Loading />
        ) : files.error ? (
          <ErrorNotice error={files.error} retry={() => void files.refetch()} />
        ) : files.data.length === 0 ? (
          <Empty text={t('service.folderEmpty')} />
        ) : (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll the file table horizontally.
          <section className="table-scroll" aria-label={t('web.files')} tabIndex={0}>
            <table className="file-table">
              <thead>
                <tr>
                  <th>{t('web.name')}</th>
                  <th>{t('web.size')}</th>
                  <th>{t('web.updated')}</th>
                  <th>{t('web.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {files.data.map((entry) => (
                  <tr key={entry.name}>
                    <td>
                      {!entry.is_file && !entry.is_symlink ? (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setDirectory(join(directory, entry.name))}
                        >
                          {entry.name}/
                        </button>
                      ) : (
                        <span>{entry.name}</span>
                      )}
                      {entry.is_symlink && <small> · {t('service.symlink')}</small>}
                    </td>
                    <td>{entry.is_file ? format.bytes(entry.size) : '—'}</td>
                    <td>
                      <Time value={entry.modified_at} />
                    </td>
                    <td>
                      <div className="actions">
                        {entry.is_file && !entry.is_symlink && (
                          <>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() =>
                                download(
                                  `${serverPath(serverId)}/files/content?path=${encodeURIComponent(join(directory, entry.name))}`,
                                )
                              }
                            >
                              {t('web.download')}
                            </button>
                            {canManage && entry.size <= 240000 && (
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => void edit(entry)}
                              >
                                {t('web.edit')}
                              </button>
                            )}
                          </>
                        )}
                        {canManage && !entry.is_symlink && (
                          <>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => {
                                setSelected(entry);
                                setMode('rename');
                              }}
                            >
                              {t('service.rename')}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => {
                                setSelected(entry);
                                setMode('delete');
                              }}
                            >
                              {t('web.delete')}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </Section>
      {canManage && (
        <Section title={t('web.upload')}>
          {transfers.isPending ? (
            <Loading />
          ) : transfers.error ? (
            <ErrorNotice error={transfers.error} />
          ) : !transfers.data?.upload.available ? (
            <Notice>{t('service.uploadUnavailable')}</Notice>
          ) : (
            <>
              <p className="muted">
                {t('service.uploadLimit', {
                  limit: format.bytes(
                    Math.min(
                      transfers.data.upload.serverDiskBytes,
                      transfers.data.upload.providerMaxFileBytes ?? Infinity,
                    ),
                  ),
                })}
              </p>
              <form
                className="form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendFile();
                }}
              >
                <Input
                  ref={fileInput}
                  label={t('service.selectFile')}
                  type="file"
                  disabled={uploading}
                  onChange={(event) => {
                    setFile(event.target.files?.[0]);
                    setUploaded(false);
                  }}
                  required
                />
                {file && files.data?.some((entry) => entry.name === file.name) && (
                  <Check
                    key={file.name}
                    label={t('service.replaceFile', { name: file.name })}
                    required
                    disabled={uploading}
                  />
                )}
                <div className="actions">
                  <button disabled={uploading || !file} type="submit">
                    {t('web.upload')}
                  </button>
                  {uploading && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => abort.current?.abort()}
                    >
                      {t('web.cancel')}
                    </button>
                  )}
                </div>
              </form>
            </>
          )}
          {uploading && progress && (
            <div role="status">
              <progress
                className="progress"
                value={progress.sent}
                max={Math.max(1, progress.total)}
                aria-label={t('web.upload')}
              />
              <small>
                {t('service.uploadProgress', {
                  sent: format.bytes(progress.sent),
                  total: format.bytes(progress.total),
                })}
              </small>
              {progress.sent === progress.total && <p>{t('service.confirmingUpload')}</p>}
            </div>
          )}
          {Boolean(uploadError) && <ErrorNotice error={uploadError} />}{' '}
          {uploaded && <Notice>{t('service.uploadComplete')}</Notice>}
        </Section>
      )}
      <Dialog
        open={Boolean(mode)}
        title={t(
          mode === 'mkdir'
            ? 'service.newFolder'
            : mode === 'new'
              ? 'service.newFile'
              : mode === 'delete'
                ? 'web.delete'
                : mode === 'rename'
                  ? 'service.rename'
                  : 'web.edit',
        )}
        onClose={closeEditor}
      >
        {mode === 'edit' && reading ? (
          <Loading />
        ) : mode === 'edit' && readError ? (
          <ErrorNotice error={readError} />
        ) : (
          <ActionForm
            key={`${mode}:${selected?.name}`}
            success={false}
            submitLabel={t(mode === 'delete' ? 'web.delete' : 'web.save')}
            onSubmit={async (data) => {
              if (mode === 'mkdir')
                await mutation({ action: 'mkdir', root: directory, name: text(data, 'name') });
              else if (mode === 'delete' && selected)
                await mutation({
                  action: 'delete',
                  root: directory,
                  files: [selected.name],
                  confirm: true,
                });
              else if (mode === 'rename' && selected)
                await mutation({
                  action: 'rename',
                  root: directory,
                  files: [{ from: selected.name, to: text(data, 'name') }],
                });
              else
                await mutation({
                  action: 'write',
                  path: join(directory, mode === 'edit' ? selected!.name : text(data, 'name')),
                  content: String(data.get('content')),
                });
            }}
          >
            {mode !== 'delete' && mode !== 'edit' && (
              <Input
                label={t('web.name')}
                name="name"
                required
                pattern="[^/\\\\]+"
                defaultValue={mode === 'rename' ? selected?.name : ''}
              />
            )}
            {(mode === 'new' || mode === 'edit') && (
              <Textarea
                label={t('service.content')}
                name="content"
                defaultValue={content}
                onChange={() => setDirty(true)}
                maxLength={60000}
                spellCheck={false}
                className="file-editor"
              />
            )}
            {mode === 'new' && <Check required label={t('service.writeFileWarning')} />}
            {mode === 'delete' && (
              <>
                <p>{t('service.deleteFileWarning', { name: selected?.name ?? '' })}</p>
                <Check label={t('web.confirm')} required />
              </>
            )}
          </ActionForm>
        )}
      </Dialog>
    </>
  );
}
