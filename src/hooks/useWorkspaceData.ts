import { useState, useEffect } from 'react';
import { api } from '../services/api';
import type { Document, Folder, Note, ChatSession } from '../types';
import { parseDateValue, toChatSession, sortChatSessionsByRecent } from '../utils/chat';

export function useWorkspaceData(currentView: string) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<Note[]>(() => {
    try {
      const saved = localStorage.getItem('notestack-notes');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.error("Failed to load notes", e);
      return [];
    }
  });
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [accountFirstName, setAccountFirstName] = useState('');
  const [accountLastName, setAccountLastName] = useState('');
  const [accountEmail, setAccountEmail] = useState('');

  useEffect(() => {
    if (currentView !== 'workspace') return;

    let cancelled = false;

    const hydrateWorkspace = async () => {
      try {
        const user = await api.getMe();

        const [docs, folderList, noteList, sessionList] = await Promise.all([
          api.getDocuments().catch(() => []),
          api.getFolders().catch(() => []),
          api.getNotes().catch(() => []),
          api.getChatSessions().catch(() => []),
        ]);

        if (cancelled) return;

        setAccountFirstName(user.first_name || '');
        setAccountLastName(user.last_name || '');
        setAccountEmail(user.email || '');

        setDocuments(
          (docs || []).map((doc: any) => ({
            id: String(doc.id),
            name: doc.name,
            mimeType: doc.mime_type,
            folderId: doc.folder_id ? String(doc.folder_id) : undefined,
            size: doc.size ?? undefined,
            timestamp: parseDateValue(doc.created_at),
          }))
        );

        setFolders(
          (folderList || []).map((f: any) => ({
            id: String(f.id),
            name: f.name,
            timestamp: parseDateValue(f.created_at),
          }))
        );

        setNotes(
          (noteList || []).map((note: any) => ({
            id: String(note.id),
            title: note.title,
            content: note.content,
            timestamp: parseDateValue(note.updated_at) ?? parseDateValue(note.created_at) ?? Date.now(),
          }))
        );

        setChatSessions(sortChatSessionsByRecent((sessionList || []).map(toChatSession)));
      } catch (err: any) {
        if (!cancelled) {
          console.error('Workspace hydration failed:', err);
        }
      }
    };

    hydrateWorkspace();

    return () => {
      cancelled = true;
    };
  }, [currentView]);

  return {
    documents, setDocuments,
    folders, setFolders,
    notes, setNotes,
    chatSessions, setChatSessions,
    accountFirstName, setAccountFirstName,
    accountLastName, setAccountLastName,
    accountEmail, setAccountEmail
  };
}
