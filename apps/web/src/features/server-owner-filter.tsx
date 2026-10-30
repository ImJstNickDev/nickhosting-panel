import { useId, useRef, useState } from 'react';
import { useT } from '../app/i18n.js';

type OwnerOption = { id: string; name: string };
const selectionLimit = 100;
const searchText = (value: string) =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim();

export function ServerOwnerFilter({
  owners,
  value,
  onChange,
  loading,
}: {
  owners: OwnerOption[];
  value: string[];
  onChange: (value: string[]) => void;
  loading: boolean;
}) {
  const t = useT();
  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const matches = owners.filter((owner) => searchText(owner.name).includes(searchText(query)));
  const full = value.length >= selectionLimit;
  return (
    <fieldset className="server-owner-filter">
      <legend>{t('platform.owner')}</legend>
      <label className="visually-hidden" htmlFor={id}>
        {t('platform.searchOwners')}
      </label>
      <input
        id={id}
        ref={search}
        type="search"
        autoComplete="off"
        placeholder={t('platform.searchOwners')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {value.length > 0 && (
        <ul className="server-owner-selected" aria-label={t('platform.selectedOwners')}>
          {value.map((ownerId) => {
            const name = owners.find((owner) => owner.id === ownerId)?.name ?? t('platform.owner');
            return (
              <li key={ownerId}>
                <button
                  type="button"
                  className="secondary"
                  aria-label={t('platform.removeOwner', { name })}
                  onClick={() => {
                    onChange(value.filter((id) => id !== ownerId));
                    search.current?.focus();
                  }}
                >
                  <span>{name}</span>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="m4 4 8 8m0-8-8 8" />
                  </svg>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="server-owner-options" aria-busy={loading}>
        {loading ? (
          <p role="status">{t('web.loading')}</p>
        ) : matches.length ? (
          matches.map((owner) => (
            <label className="server-owner-option" key={owner.id}>
              <input
                type="checkbox"
                checked={value.includes(owner.id)}
                disabled={full && !value.includes(owner.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...value, owner.id]
                      : value.filter((id) => id !== owner.id),
                  )
                }
              />
              <span>{owner.name}</span>
            </label>
          ))
        ) : (
          <p role="status">{t('platform.noMatchingOwners')}</p>
        )}
      </div>
      {full && (
        <p className="muted" role="status">
          {t('platform.ownerSelectionLimit', { count: selectionLimit })}
        </p>
      )}
    </fieldset>
  );
}
