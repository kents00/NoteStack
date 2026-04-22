import type { ChatSession } from '../types';

export const parseDateValue = (value?: string | number | null): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

export const toChatSession = (session: any): ChatSession => {
  const createdAt = parseDateValue(session?.created_at) ?? Date.now();
  const updatedAt = parseDateValue(session?.updated_at) ?? createdAt;
  const rawTitle = typeof session?.title === 'string' ? session.title.trim() : '';

  return {
    id: String(session?.id),
    title: rawTitle || 'New chat',
    createdAt,
    updatedAt,
  };
};

export const sortChatSessionsByRecent = (sessions: ChatSession[]) => {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
};
