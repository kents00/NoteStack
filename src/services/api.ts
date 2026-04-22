const API_BASE_URL = 'http://localhost:8000/api';

type ApiError = Error & { status?: number };
export type CloudApiProvider = 'gemini' | 'openai' | 'anthropic' | 'cerebras' | 'openrouter' | 'openai_compatible';

export type CloudProviderValidationResult = {
  provider: CloudApiProvider;
  valid: boolean;
  message: string;
  available_models: string[];
  default_model?: string;
  selected_model?: string;
  selected_model_accessible: boolean;
  resolved_model?: string;
  fallback_applied: boolean;
};

export type LocalEndpointType = 'ollama' | 'lm_studio' | 'openai_compatible';

export type LocalLLMDiscoveryResult = {
  status: string;
  endpoint: string;
  endpoint_type: LocalEndpointType;
  available: boolean;
  detected_model?: string;
  available_models: string[];
  message: string;
  docker_hint?: string;
  fallback_applied: boolean;
  probe_url?: string;
};

const toApiError = (message: string, status?: number): ApiError => {
  const error = new Error(message) as ApiError;
  error.status = status;
  return error;
};

const parseErrorMessageFromResponse = async (res: Response, fallback: string): Promise<string> => {
  const payload = await res.text().catch(() => '');
  const normalized = payload.trim();

  if (!normalized) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(normalized);

    if (typeof parsed?.detail === 'string' && parsed.detail.trim()) {
      return parsed.detail;
    }

    if (Array.isArray(parsed?.detail)) {
      const firstValidationError = parsed.detail.find((entry: any) => typeof entry?.msg === 'string' && entry.msg.trim());
      if (firstValidationError?.msg) {
        return firstValidationError.msg;
      }
    }

    if (typeof parsed?.message === 'string' && parsed.message.trim()) {
      return parsed.message;
    }
  } catch {
    // Non-JSON payload; use raw text.
  }

  return normalized;
};

const getToken = (): string | null => {
  try {
    return localStorage.getItem('nb_auth_token');
  } catch {
    return null;
  }
};

export const api = {
  // --- Auth ---
  login: async (email: string, password: string) => {
    // FastAPI OAuth2PasswordRequestForm expects form data, not JSON
    const formData = new URLSearchParams();
    formData.append('username', email); // OAuth2 expects 'username'
    formData.append('password', password);

    const res = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData,
    });
    if (!res.ok) {
      const detail = await parseErrorMessageFromResponse(res, 'Login failed');
      throw toApiError(detail, res.status);
    }
    return res.json();
  },

  register: async (data: any) => {
    const res = await fetch(`${API_BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const detail = await parseErrorMessageFromResponse(res, 'Registration failed');
      throw toApiError(detail, res.status);
    }
    return res.json();
  },

  // --- Users ---
  getMe: async () => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      let detail = 'Failed to fetch user';
      try {
        const data = await res.json();
        if (typeof data?.detail === 'string' && data.detail.trim()) {
          detail = data.detail;
        }
      } catch {
        // Fall back to default detail when body is not JSON.
      }
      const err = new Error(detail) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return res.json();
  },

  updateMe: async (payload: {
    email?: string;
    first_name?: string;
    last_name?: string;
    password?: string;
  }) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/users/me`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let detail = 'Failed to update account';
      try {
        const data = await res.json();
        if (typeof data?.detail === 'string' && data.detail.trim()) {
          detail = data.detail;
        }
      } catch {
        // Fall back to default detail when body is not JSON.
      }
      const err = new Error(detail) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    return res.json();
  },

  // --- Documents ---
  getDocuments: async () => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/documents/`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Failed to fetch documents');
    return res.json();
  },

  uploadDocument: async (file: File, folderId?: string) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const formData = new FormData();
    formData.append('file', file);
    if (folderId) formData.append('folder_id', folderId);

    const res = await fetch(`${API_BASE_URL}/documents/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    if (!res.ok) throw new Error('Upload failed');
    return res.json();
  },

  updateDocument: async (documentId: string, payload: { name?: string; folder_id?: string | null }) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/documents/${documentId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Update failed');
    return res.json();
  },

  deleteDocument: async (documentId: string) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/documents/${documentId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Delete failed');
    return res.json();
  },

  getDocumentContent: async (documentId: string) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/documents/${documentId}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const detail = await parseErrorMessageFromResponse(res, 'Failed to fetch document content');
      throw toApiError(detail, res.status);
    }
    return res.json(); // { content: "base64..." }
  },

  // --- Folders ---
  getFolders: async () => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/folders/`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Failed to fetch folders');
    return res.json();
  },

  createFolder: async (name: string) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/folders/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error('Failed to create folder');
    return res.json();
  },

  updateFolder: async (folderId: string, name: string) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/folders/${folderId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error('Failed to update folder');
    return res.json();
  },

  deleteFolder: async (folderId: string) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/folders/${folderId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Failed to delete folder');
    return res.json();
  },

  // --- Notes ---
  getNotes: async () => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/notes/`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Failed to fetch notes');
    return res.json();
  },

  upsertNote: async (note: { id?: string; title: string; content: string; timestamp: number }) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/notes/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(note),
    });
    if (!res.ok) throw new Error('Failed to save note');
    return res.json();
  },

  deleteNote: async (noteId: string) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/notes/${noteId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Failed to delete note');
    return res.json();
  },

  // --- Persisted chat sessions/messages ---
  getChatSessions: async () => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/chat/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Failed to fetch chat sessions');
    return res.json();
  },

  createChatSession: async (title?: string) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/chat/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error('Failed to create chat session');
    return res.json();
  },

  deleteChatSession: async (sessionId: string) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/chat/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Failed to delete chat session');
    return res.json();
  },

  clearAllChatSessions: async () => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/chat/sessions`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Failed to clear chat history');
    return res.json();
  },

  clearChatSessionMessages: async (sessionId: string) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/chat/sessions/${sessionId}/messages`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Failed to clear chat history');
    return res.json();
  },

  getChatMessages: async (sessionId: string) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/chat/sessions/${sessionId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Failed to fetch messages');
    return res.json();
  },

  createChatMessage: async (
    sessionId: string,
    message: {
      id?: string;
      role: string;
      text: string;
      attached_files?: unknown[];
      citations?: Array<{
        citation_number: number;
        document_id: string;
        document_name: string;
        snippet: string;
        chunk_index: number;
        chunk_indices?: number[];
        source_label?: string;
      }>;
      created_at?: string;
    }
  ) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const detail = await parseErrorMessageFromResponse(res, 'Failed to persist message');
      throw toApiError(detail, res.status);
    }
    return res.json();
  },

  setMessageFeedback: async (messageId: string, feedback: 'like' | 'dislike' | null) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE_URL}/chat/messages/${messageId}/feedback`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ feedback }),
    });
    if (!res.ok) throw new Error('Failed to save feedback');
    return res.json();
  },

  // --- Chat ---
  validateCloudProvider: async (payload: {
    provider: CloudApiProvider;
    api_key: string;
    selected_model?: string;
    base_url?: string;
  }) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');

    const res = await fetch(`${API_BASE_URL}/chat/cloud/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await parseErrorMessageFromResponse(res, 'Cloud provider validation failed');
      throw toApiError(detail, res.status);
    }

    return res.json() as Promise<CloudProviderValidationResult>;
  },

  // Returns a fetch Response that yields an SSE stream
  streamChat: (requestBody: {
    messages: { role: string; text: string }[];
    document_ids: string[];
    api_provider: string;
    api_key?: string;
    cloud_model?: string;
    cloud_base_url?: string;
    local_model_url?: string;
    local_model_name?: string;
    system_instructions?: string;
  }, options?: { signal?: AbortSignal }) => {
    const token = getToken();
    return fetch(`${API_BASE_URL}/chat/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: options?.signal,
      body: JSON.stringify(requestBody),
    });
  },

  checkLocalHealth: async (url: string) => {
    const token = getToken();
    const res = await fetch(`${API_BASE_URL}/chat/health?url=${encodeURIComponent(url)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      let detail = 'Health check failed';
      try {
        const data = await res.json();
        if (typeof data?.detail === 'string' && data.detail.trim()) {
          detail = data.detail;
        }
      } catch {
        // Fall back to default detail when body is not JSON.
      }
      const err = new Error(detail) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return res.json();
  },

  discoverLocalLLM: async (url?: string) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');

    const normalizedUrl = (url || '').trim();
    const query = normalizedUrl ? `?url=${encodeURIComponent(normalizedUrl)}` : '';
    const res = await fetch(`${API_BASE_URL}/chat/local/discover${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const detail = await parseErrorMessageFromResponse(res, 'Local runtime discovery failed');
      throw toApiError(detail, res.status);
    }

    return res.json() as Promise<LocalLLMDiscoveryResult>;
  },
};
