import { roles, type Role } from './contracts.js';

/** Complete artifact dependencies while preserving the Producer's affected scope. */
export function productionRoles(selected: Role[], intent: string, hasGame: boolean): Role[] {
  if (intent === 'consult') return [];
  if (!hasGame) return [...roles];
  if (selected.includes('planner'))
    return roles.filter((role) => role !== 'research' || selected.includes('research'));
  const affected = new Set(selected);
  if (affected.has('art') || affected.has('audio')) affected.add('game');
  if (affected.has('level-design')) affected.add('level-code');
  return roles.filter((role) => affected.has(role));
}
