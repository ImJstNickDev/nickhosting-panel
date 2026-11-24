import { useState } from 'react';
import type { OpenworldRuleAction } from '../../../../../games/openworld/src/rules.js';
import { SearchField } from '../../components/workspace-controls.js';
import type { FormField, OpenRuleForm } from './rules-action.js';
import {
  type Group,
  RuleIcon,
  type RuleSnapshot,
  SettingRow,
  tintStyle,
  useRuleText,
} from './rules-fields.js';

function ancestors(group: Group, groups: Group[]) {
  const chain: Group[] = [group],
    visited = new Set([group.key]);
  let parent = group.parent;
  while (parent && !visited.has(parent)) {
    const next = groups.find((g) => g.key === parent);
    if (!next) break;
    visited.add(next.key);
    chain.unshift(next);
    parent = next.parent;
  }
  return { chain, complete: !parent && chain.every((g) => g.permissions !== null) };
}
function GroupSettings({
  group,
  groups,
  defaultRole,
  canEdit,
  edit,
}: {
  group: Group;
  groups: Group[];
  defaultRole: string;
  canEdit: boolean;
  edit: OpenRuleForm;
}) {
  const r = useRuleText(),
    role = group.key,
    protectedGroup = role === 'superadmin';
  function change(field: FormField, make: (value: string) => OpenworldRuleAction) {
    edit({
      title: field.label,
      subject: group.name,
      fields: [{ ...field, name: 'value' }],
      action: (v) => (v.value === (field.initial ?? '') ? null : make(v.value ?? '')),
    });
  }
  const parentName = groups.find((g) => g.key === group.parent)?.name ?? group.parent;
  const children = new Map<string, string[]>();
  for (const other of groups) {
    if (!other.parent) continue;
    const siblings = children.get(other.parent) ?? [];
    siblings.push(other.key);
    children.set(other.parent, siblings);
  }
  const descendants = new Set([role]);
  for (const key of descendants)
    for (const child of children.get(key) ?? []) descendants.add(child);
  const possibleParents = groups.filter((g) => !descendants.has(g.key));
  return (
    <div>
      <SettingRow
        label={r('groupName')}
        value={group.name}
        edit={
          canEdit
            ? () =>
                change(
                  { name: 'value', label: r('groupName'), initial: group.name, maxLength: 64 },
                  (value) => ({ kind: 'roleName', role, value }),
                )
            : undefined
        }
      />
      <SettingRow
        label={r('colour')}
        value={
          <span className="ow-role-colour" style={tintStyle(group.color)}>
            {group.color ?? '—'}
          </span>
        }
        edit={
          canEdit
            ? () =>
                change(
                  {
                    name: 'value',
                    label: r('colour'),
                    kind: 'color',
                    initial: group.color ?? '#396554',
                  },
                  (value) => ({ kind: 'roleColor', role, value }),
                )
            : undefined
        }
      />
      <SettingRow
        label={r('parentGroup')}
        value={parentName ?? r('none')}
        edit={
          canEdit
            ? () =>
                change(
                  {
                    name: 'value',
                    label: r('parentGroup'),
                    kind: 'select',
                    initial: group.parent ?? '',
                    optional: true,
                    options: [
                      { value: '', label: r('none') },
                      ...possibleParents.map((p) => ({ value: p.key, label: p.name })),
                    ],
                  },
                  (v) => ({ kind: 'roleParent', role, value: v || null }),
                )
            : undefined
        }
      />
      <SettingRow
        label={r('rank')}
        value={group.priority}
        hint={r('groupPriorityHelp')}
        edit={
          canEdit && !protectedGroup
            ? () =>
                change(
                  {
                    name: 'value',
                    label: r('rank'),
                    kind: 'number',
                    min: 0,
                    max: 99,
                    step: 1,
                    initial: String(group.priority),
                  },
                  (v) => ({ kind: 'rolePriority', role, value: Number(v) }),
                )
            : undefined
        }
      />
      <SettingRow
        label={r('homeLimit')}
        value={
          group.maxHomes == null
            ? r('unavailable')
            : group.maxHomes === -1
              ? r('inherit')
              : group.maxHomes
        }
        edit={
          canEdit
            ? () =>
                change(
                  {
                    name: 'value',
                    label: r('homeLimit'),
                    hint: r('homeLimitHelp'),
                    kind: 'number',
                    min: -1,
                    max: 1000,
                    step: 1,
                    initial: String(group.maxHomes ?? -1),
                  },
                  (v) => ({ kind: 'roleHomes', role, value: Number(v) }),
                )
            : undefined
        }
      />
      {defaultRole === role ? (
        <p className="ow-rule-empty">{r('defaultGroupHelp')}</p>
      ) : (
        canEdit &&
        !protectedGroup && (
          <button
            className="ow-rule-text"
            type="button"
            onClick={() =>
              edit({
                title: r('makeDefault'),
                subject: group.name,
                description: r('makeDefaultHelp'),
                confirm: r('makeDefault'),
                action: () => ({ kind: 'roleDefault', role }),
              })
            }
          >
            {r('makeDefault')}
          </button>
        )
      )}
      {canEdit && !protectedGroup && defaultRole !== role && (
        <button
          type="button"
          className="ow-rule-danger"
          onClick={() =>
            edit({
              title: r('deleteGroup'),
              subject: group.name,
              description: r('deleteGroupHelp'),
              confirm: r('deleteGroup'),
              destructive: true,
              action: () => ({ kind: 'roleDelete', role }),
            })
          }
        >
          <RuleIcon name="trash" />
          {r('deleteGroup')}
        </button>
      )}
    </div>
  );
}
function PermissionList({
  group,
  groups,
  nodes,
  edit,
  manage,
}: {
  group: Group;
  groups: Group[];
  nodes?: string[] | null;
  edit: OpenRuleForm;
  manage: boolean;
}) {
  const r = useRuleText();
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'all' | 'direct'>('all');
  const [limit, setLimit] = useState(32);
  const { chain, complete } = ancestors(group, groups);
  const all = chain.flatMap((source) =>
    (source.permissions ?? []).map((signed, index) => ({
      source,
      signed,
      index,
      deny: signed.startsWith('-'),
      node: signed.replace(/^-/, ''),
    })),
  );
  const term = search.toLowerCase().trim();
  const known = Boolean(term && nodes?.includes(term));
  const matches = (pattern: string) =>
    pattern === term ||
    pattern === '*' ||
    (pattern.endsWith('.*') && term.startsWith(pattern.slice(0, -1)));
  const decisive = known && complete ? all.findLast((item) => matches(item.node)) : undefined;
  const rows = all.filter(
    (item) =>
      (scope === 'all' || item.source.key === group.key) &&
      (item.node.includes(term) || (known && matches(item.node))),
  );
  const askDelete = (permission: string) =>
    edit({
      title: r('removePermission'),
      subject: `${group.name} · ${permission}`,
      description: r('removePermissionHelp'),
      confirm: r('remove'),
      destructive: true,
      action: () => ({ kind: 'rolePermission', role: group.key, permission, add: false }),
    });
  const askAdd = (preset = '', decision: 'allow' | 'deny' = 'allow') =>
    edit({
      title: r(preset ? 'addOverride' : 'addPermission'),
      subject: group.name,
      fields: [
        {
          name: 'node',
          label: r('node'),
          initial: preset,
          suggestions: nodes ?? [],
          maxLength: 128,
          hint: r('nodeHelp'),
        },
        {
          name: 'decision',
          label: r('permissionValue'),
          kind: 'choice',
          initial: decision,
          options: [
            { value: 'allow', label: r('allow') },
            { value: 'deny', label: r('deny') },
          ],
        },
      ],
      action: (v) => {
        const node = v.node?.trim();
        if (!node || node.startsWith('-')) return null;
        const permission = v.decision === 'deny' ? `-${node}` : node;
        return group.permissions?.includes(permission)
          ? null
          : { kind: 'rolePermission', role: group.key, permission, add: true };
      },
    });
  return (
    <>
      <div className="ow-perm-tools">
        <SearchField
          label={r('filterNodes')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setLimit(32);
          }}
        />
        {manage && group.permissions !== null && (
          <button type="button" className="ow-add-perm" onClick={() => askAdd()}>
            <RuleIcon name="plus" size={15} />
            {r('addPermission')}
          </button>
        )}
      </div>
      <div className="ow-perm-filters">
        <button
          type="button"
          aria-pressed={scope === 'all'}
          onClick={() => {
            setScope('all');
            setLimit(32);
          }}
        >
          {r('allNodes')}
        </button>
        <button
          type="button"
          aria-pressed={scope === 'direct'}
          onClick={() => {
            setScope('direct');
            setLimit(32);
          }}
        >
          {r('directOnly')}
        </button>
      </div>
      {decisive && (
        <p className="ow-perm-result">
          <RuleIcon name={decisive.deny ? 'minus' : 'check'} size={14} />
          {r('matchedPermission', {
            value: r(decisive.deny ? 'deny' : 'allow'),
            role: decisive.source.name,
            node: term,
          })}
        </p>
      )}
      {rows.length > 0 && (
        <div className="ow-perm-table-scroll">
          <table className="ow-perm-table">
            <thead>
              <tr>
                <th scope="col">{r('node')}</th>
                <th scope="col">{r('permissionValue')}</th>
                <th scope="col">{r('source')}</th>
                {manage && (
                  <th scope="col">
                    <span className="visually-hidden">{r('edit')}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((row) => (
                <tr key={JSON.stringify([row.source.key, row.index, row.signed])}>
                  <td>
                    <code>{row.node}</code>
                  </td>
                  <td>
                    <span className="ow-perm-decision" data-tone={row.deny ? 'deny' : 'allow'}>
                      <RuleIcon size={12} name={row.deny ? 'minus' : 'check'} />
                      {r(row.deny ? 'deny' : 'allow')}
                    </span>
                  </td>
                  <td>
                    <span className="ow-perm-source">
                      {row.source.key !== group.key && <RuleIcon name="inherit" size={13} />}{' '}
                      {row.source.name}
                    </span>
                  </td>
                  {manage && (
                    <td>
                      {row.source.key === group.key ? (
                        <button
                          type="button"
                          className="ow-rule-icon"
                          aria-label={r('removeNode', { node: row.signed })}
                          onClick={() => askDelete(row.signed)}
                        >
                          <RuleIcon name="close" size={14} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="ow-rule-icon"
                          aria-label={r('overrideNode', { node: row.node })}
                          onClick={() => askAdd(row.node, row.deny ? 'allow' : 'deny')}
                        >
                          <RuleIcon name="edit" size={13} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > limit && (
        <button className="ow-rule-text" type="button" onClick={() => setLimit((n) => n + 32)}>
          {r('moreNodes')}
        </button>
      )}
      {!rows.length && (
        <p className="ow-rule-empty">
          {r(search ? 'noMatches' : group.permissions === null ? 'unavailable' : 'noGroupNodes')}
        </p>
      )}
      {!complete && <p className="ow-rule-empty">{r('incompleteGroup')}</p>}
      {scope === 'all' && rows.length > 1 && <p className="ow-perm-note">{r('orderHelp')}</p>}
    </>
  );
}

export function Groups({
  data,
  edit,
  manage,
}: {
  data: RuleSnapshot;
  edit: OpenRuleForm;
  manage: boolean;
}) {
  const r = useRuleText(),
    roles = data.roles;
  const [selected, setSelected] = useState(roles?.defaultRole ?? '');
  const [search, setSearch] = useState(''),
    [settings, setSettings] = useState(false),
    [mobileDetail, setMobileDetail] = useState(false);
  if (!roles?.entries.length)
    return (
      <section className="ow-rule-panel">
        <h2>{r('groups')}</h2>
        <p className="ow-rule-empty">{r(roles ? 'noRoles' : 'unavailable')}</p>
      </section>
    );
  const groups = roles.entries,
    group =
      groups.find((g) => g.key === selected) ??
      groups.find((g) => g.key === roles.defaultRole) ??
      groups[0];
  if (!group) return null;
  const filtered = groups.filter((g) =>
    `${g.name} ${g.key}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const canEdit = !!(manage && data.capabilities.roles);
  const choose = (key: string) => {
    setSelected(key);
    setSettings(false);
    setMobileDetail(true);
  };
  const askNew = () =>
    edit({
      title: r('newGroup'),
      applied: (action) => {
        if (action.kind === 'roleCreate') choose(action.role);
      },
      confirm: r('createGroup'),
      fields: [
        {
          name: 'role',
          label: r('groupKey'),
          maxLength: 32,
          hint: r('groupKeyHelp'),
          pattern: '[a-z0-9_\\-]{1,32}',
        },
        {
          name: 'parent',
          kind: 'select',
          label: r('parentGroup'),
          initial: roles.defaultRole,
          optional: true,
          options: [
            { value: '', label: r('none') },
            ...groups.map((g) => ({ value: g.key, label: g.name })),
          ],
        },
      ],
      action: (v) =>
        !v.role || groups.some((g) => g.key === v.role)
          ? null
          : { kind: 'roleCreate', role: v.role, ...(v.parent ? { parent: v.parent } : {}) },
    });
  return (
    <section className="ow-group-studio" data-detail={mobileDetail}>
      <aside className="ow-group-index">
        <header>
          <h2>{r('groups')}</h2>
          {canEdit && (
            <button
              type="button"
              className="ow-rule-icon"
              aria-label={r('newGroup')}
              title={r('newGroup')}
              onClick={askNew}
            >
              <RuleIcon name="plus" />
            </button>
          )}
        </header>
        <SearchField
          label={r('findGroup')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ul>
          {filtered.map((g) => (
            <li key={g.key}>
              <button
                className="ow-group-switch"
                style={tintStyle(g.color)}
                type="button"
                aria-pressed={group.key === g.key}
                aria-label={g.name}
                onClick={() => choose(g.key)}
              >
                <span className="ow-group-mark" />
                <span>
                  <strong>{g.name}</strong>
                  {g.key === roles.defaultRole && <small>{r('defaultRole')}</small>}
                </span>
                <RuleIcon name="arrow" size={12} />
              </button>
            </li>
          ))}
        </ul>
        {!filtered.length && <p className="ow-rule-empty">{r('noMatches')}</p>}
      </aside>
      <article className="ow-group-detail" key={group.key}>
        <button
          type="button"
          className="ow-rule-text ow-group-back"
          onClick={() => setMobileDetail(false)}
        >
          <RuleIcon name="back" size={13} />
          {r('allGroups')}
        </button>
        <header className="ow-group-title">
          <span className="ow-group-swatch" style={tintStyle(group.color)}>
            <RuleIcon name="groups" size={25} />
          </span>
          <div>
            <h2>{group.name}</h2>
            <small>
              {r('priority', { priority: group.priority })}
              {group.key === roles.defaultRole ? ` · ${r('defaultRole')}` : ''}
            </small>
          </div>
        </header>
        {group.parent && (
          <div className="ow-inheritance">
            <RuleIcon name="inherit" size={14} />
            <span>{r('inheritsFrom')}</span>
            {ancestors(group, groups)
              .chain.slice(0, -1)
              .reverse()
              .map((g, i) => (
                <span className="ow-parent-link" key={g.key}>
                  {i > 0 && <RuleIcon name="back" size={11} />}
                  <button type="button" className="ow-rule-text" onClick={() => choose(g.key)}>
                    {g.name}
                  </button>
                </span>
              ))}
          </div>
        )}
        <div className="ow-subnav">
          <button type="button" aria-pressed={!settings} onClick={() => setSettings(false)}>
            {r('nodes')}
          </button>
          <button type="button" aria-pressed={settings} onClick={() => setSettings(true)}>
            {r('groupDetails')}
          </button>
        </div>
        {settings ? (
          <GroupSettings {...{ group, groups, defaultRole: roles.defaultRole, canEdit, edit }} />
        ) : (
          <PermissionList
            group={group}
            groups={groups}
            nodes={data.permissionNodes}
            edit={edit}
            manage={canEdit}
          />
        )}
      </article>
    </section>
  );
}
