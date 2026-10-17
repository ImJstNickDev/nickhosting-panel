import { useState } from 'react';
import type { Allocation } from '../../../../packages/pterodactyl-adapter/src/types.js';
import { useT } from '../app/i18n.js';
import { Check, Input, Select } from '../components/ui.js';
import {
  type AllocationSelection,
  allocationDraft,
  canSelectAllocation,
  changeAllocationRange,
} from './allocation-pool-model.js';
import { TableRegion } from './servers.js';

const pageSize = 25;
export function AllocationPoolEditor({
  rows,
  selected,
  retained,
  onChange,
}: {
  rows: Allocation[];
  selected: AllocationSelection;
  retained: AllocationSelection;
  onChange: (selection: AllocationSelection) => void;
}) {
  const t = useT();
  const [address, setAddress] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [onlySelected, setOnlySelected] = useState(false);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<number>();
  const addresses = [...new Set(rows.map((row) => row.ip))].sort();
  const filtered = rows
    .filter(
      (row) =>
        (!address || row.ip === address) &&
        (!onlySelected || selected.has(row.id)) &&
        `${row.id} ${row.ip} ${row.port}`.includes(search.trim()),
    )
    .sort((a, b) => a.ip.localeCompare(b.ip) || a.port - b.port || a.id - b.id);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const validRange =
    Boolean(address) &&
    /^\d+$/.test(from) &&
    /^\d+$/.test(to) &&
    Number(from) >= 1 &&
    Number(to) <= 65535 &&
    Number(from) <= Number(to);
  const edit = editing === undefined ? undefined : selected.get(editing);
  function updatePin(change: Partial<NonNullable<typeof edit>>) {
    if (!edit) return;
    const next = new Map(selected);
    next.set(edit.allocationId, { ...edit, ...change });
    onChange(next);
  }
  return (
    <div className="form" data-testid="allocation-pool-editor">
      <div className="columns">
        <Select
          label={t('infra.address')}
          value={address}
          onChange={(event) => {
            setAddress(event.target.value);
            setPage(0);
          }}
        >
          <option value="">{t('infra.allAddresses')}</option>
          {addresses.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
        <Input
          label={t('infra.searchAllocations')}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
        />
      </div>
      <fieldset>
        <legend>{t('infra.selectRange')}</legend>
        <div className="columns">
          <Input
            label={t('infra.rangeFrom')}
            inputMode="numeric"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
          <Input
            label={t('infra.rangeTo')}
            inputMode="numeric"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={!validRange}
            onClick={() =>
              onChange(
                changeAllocationRange(
                  selected,
                  rows,
                  retained,
                  address,
                  Number(from),
                  Number(to),
                  true,
                ),
              )
            }
          >
            {t('infra.includeRange')}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!validRange}
            onClick={() =>
              onChange(
                changeAllocationRange(
                  selected,
                  rows,
                  retained,
                  address,
                  Number(from),
                  Number(to),
                  false,
                ),
              )
            }
          >
            {t('infra.removeRange')}
          </button>
        </div>
      </fieldset>
      <p role="status">
        {t('infra.selectionCount', { selected: selected.size, total: rows.length })}
      </p>
      <Check
        label={t('infra.onlySelected')}
        checked={onlySelected}
        onChange={(event) => {
          setOnlySelected(event.target.checked);
          setPage(0);
        }}
      />
      <div style={{ maxHeight: '26rem', overflow: 'auto' }}>
        <TableRegion label={t('infra.pool')}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t('web.actions')}</th>
                <th scope="col">{t('infra.address')}</th>
                <th scope="col">{t('infra.port')}</th>
                <th scope="col">{t('web.status')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((allocation) => (
                <tr key={allocation.id}>
                  <td>
                    <Check
                      label={t('infra.selectAllocation', { id: allocation.id })}
                      checked={selected.has(allocation.id)}
                      disabled={!canSelectAllocation(allocation, retained)}
                      onChange={(event) => {
                        const next = new Map(selected);
                        if (event.target.checked)
                          next.set(
                            allocation.id,
                            retained.get(allocation.id) ?? allocationDraft(allocation),
                          );
                        else next.delete(allocation.id);
                        onChange(next);
                      }}
                    />
                    {selected.has(allocation.id) && (
                      <button
                        type="button"
                        className="secondary"
                        aria-expanded={editing === allocation.id}
                        onClick={() =>
                          setEditing(editing === allocation.id ? undefined : allocation.id)
                        }
                      >
                        {t('infra.editEndpoint', { id: allocation.id })}
                      </button>
                    )}
                  </td>
                  <td>{allocation.ip}</td>
                  <td>{allocation.port}</td>
                  <td>{t(allocation.assigned ? 'infra.assigned' : 'infra.available')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableRegion>
      </div>
      <nav className="actions" aria-label={t('infra.allocationPages')}>
        <button
          type="button"
          className="secondary"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          {t('web.previous')}
        </button>
        <span>
          {t('infra.allocationPage', { page: currentPage + 1, pages, count: filtered.length })}
        </span>
        <button
          type="button"
          className="secondary"
          disabled={currentPage + 1 >= pages}
          onClick={() => setPage(currentPage + 1)}
        >
          {t('web.next')}
        </button>
      </nav>
      {edit && (
        <fieldset className="direct-allocation-fields">
          <legend>
            {t('infra.directEndpoint')} ·{' '}
            <code>
              {edit.address}:{edit.port}
            </code>
          </legend>
          <div className="columns">
            <Input
              label={t('infra.directHost', { id: edit.allocationId })}
              name={`directHost-${edit.allocationId}`}
              value={edit.hostname}
              onChange={(event) => updatePin({ hostname: event.target.value })}
            />
            <Input
              label={t('infra.directPort', { id: edit.allocationId })}
              name={`directPort-${edit.allocationId}`}
              type="number"
              min={1}
              max={65535}
              value={edit.directPort}
              onChange={(event) => updatePin({ directPort: event.target.value })}
            />
          </div>
          <Check
            label={t('infra.directOnly', { id: edit.allocationId })}
            name={`directOnly-${edit.allocationId}`}
            checked={edit.directOnly}
            onChange={(event) => updatePin({ directOnly: event.target.checked })}
          />
          <button type="button" className="secondary" onClick={() => setEditing(undefined)}>
            {t('web.close')}
          </button>
        </fieldset>
      )}
    </div>
  );
}
