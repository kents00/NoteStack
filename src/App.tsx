import React, { useState, useRef, useEffect } from 'react';
import { api, type CloudApiProvider, type CloudProviderValidationResult, type LocalEndpointType } from './services/api';
import { Upload, FileText, X, Send, Bot, User, Loader2, File, Plus, Settings, Trash2, Database, Cpu, Pin, PanelRightClose, PanelRightOpen, Folder as FolderIcon, ChevronDown, ChevronRight, Edit2, CheckSquare, FolderPlus, Menu, Download, Eye, EyeOff, Check, ArrowDown, ArrowUp, Info, Merge, Search, Sparkles, Filter, SlidersHorizontal, XCircle, Mic, ThumbsUp, ThumbsDown, Copy, MoreVertical, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import localforage from 'localforage';
import * as mammoth from 'mammoth';
import JSZip from 'jszip';
import { LandingPage } from './components/LandingPage';
import { AuthPages } from './components/AuthPages';
import { NotificationInline } from './components/notifications/NotificationInline';
import { type NotificationType, useNotifications } from './context/NotificationContext';
import {
  applyCitationStreamEvent,
  detectMarkdownStructure,
  extractSseDataEvents,
  normalizeCitationReferencesInText,
  normalizeCitationItems,
  parseCitationPayload,
  parseStreamErrorPayload,
  type CitationItem,
  type CitationStreamState,
} from './utils/citationStream';

type Document = {
  id: string;
  name: string;
  mimeType: string;
  base64?: string;
  folderId?: string;
  size?: number;
  timestamp?: number;
};

type Folder = {
  id: string;
  name: string;
  isExpanded?: boolean;
  timestamp?: number;
};

type Message = {
  id: string;
  role: 'user' | 'model';
  text: string;
  attachedFiles?: Document[];
  citations?: CitationItem[];
  citationStatus?: 'full' | 'partial';
  citationStatusReason?: string;
  bubbleStyle?: React.CSSProperties;
};

type Note = {
  id: string;
  title: string;
  content: string;
  timestamp: number;
};

type UploadingFile = {
  id: string;
  name: string;
  progress: number;
};

type ApiProvider = 'gemini' | 'openai' | 'anthropic' | 'cerebras' | 'openrouter' | 'openai_compatible' | 'local';
type MessageFeedback = 'like' | 'dislike';
type CloudValidationStatus = 'idle' | 'checking' | 'valid' | 'invalid';

type CloudValidationState = {
  status: CloudValidationStatus;
  message: string;
  defaultModel?: string;
  resolvedModel?: string;
  fallbackApplied?: boolean;
  selectedModelAccessible?: boolean;
};

type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

type RightPanelTab = 'notes' | 'configure' | 'history';
type ChatGoalMode = 'default' | 'learning-guide';
type ChatResponseLength = 'default' | 'longer' | 'shorter';
type RegenerateMode = 'try_again' | 'think_longer';

type ChatSessionConfig = {
  goalMode: ChatGoalMode;
  responseLength: ChatResponseLength;
};

const SETTINGS_STORAGE_KEYS = {
  apiProvider: 'notestack-api-provider',
  geminiApiKey: 'notestack-api-key-gemini',
  openaiApiKey: 'notestack-api-key-openai',
  openaiCompatibleApiKey: 'notestack-api-key-openai-compatible',
  openrouterApiKey: 'notestack-api-key-openrouter',
  anthropicApiKey: 'notestack-api-key-anthropic',
  cerebrasApiKey: 'notestack-api-key-cerebras',
  geminiModel: 'notestack-model-gemini',
  openaiModel: 'notestack-model-openai',
  openaiCompatibleModel: 'notestack-model-openai-compatible',
  openrouterModel: 'notestack-model-openrouter',
  anthropicModel: 'notestack-model-anthropic',
  cerebrasModel: 'notestack-model-cerebras',
  openaiCompatibleBaseUrl: 'notestack-openai-compatible-base-url',
  localModelUrl: 'notestack-local-model-url',
  localModelName: 'notestack-local-model-name',
} as const;

const DEFAULT_GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const SYSTEM_INSTRUCTIONS_STORAGE_KEY = 'notestack-sys-instructions';
const CHAT_SESSION_CONFIGS_STORAGE_KEY = 'notestack-chat-session-configs';
const CLOUD_MODELS_BY_PROVIDER_STORAGE_KEY = 'notestack-cloud-models-by-provider';
const ACCOUNT_SETTINGS_INLINE_SCOPE = 'account-settings';
const LEGACY_DEFAULT_SYSTEM_INSTRUCTIONS = 'You are a helpful AI assistant that provides accurate and concise answers.';
const DEFAULT_CHAT_SESSION_CONFIG: ChatSessionConfig = {
  goalMode: 'default',
  responseLength: 'default',
};
const ENHANCED_DEFAULT_SYSTEM_INSTRUCTIONS = [
  'You are NoteStack, an evidence-grounded assistant for document Q&A and comparison.',
  '',
  'Core behavior:',
  '1. Answer only from the provided document context and relevant chat history.',
  '2. Every factual claim must include inline citation links in this exact format: [n](#cite-n).',
  '3. If one claim has multiple sources, cite them separately as [1](#cite-1), [2](#cite-2). Never group citations as [1,2] or [1;2].',
  '4. Use only citation numbers that exist in the provided context. Never invent citation numbers.',
  '5. Prefer meaningful evidence sentences and avoid low-signal text (author lists, affiliations, emails, headers, bibliography noise).',
  '6. For multi-document questions, clearly separate agreements and differences.',
  '7. If the context does not support the answer, reply exactly: I cannot answer this based on the provided documents.',
  '',
  'Output style:',
  '- Format your response using well-structured markdown.',
  '- Use ### headings to separate sections (e.g., ### Direct Answer, ### Key Evidence, ### Comparison).',
  '- Leave a blank line between every paragraph and before/after headings and lists.',
  '- Bold key terms and important phrases using **double asterisks**.',
  '- Use bullet lists (- item) for evidence points, each with inline citations.',
  '- Start with a ### Direct Answer section (2-5 sentences).',
  '- Follow with ### Key Evidence containing bulleted findings with citations.',
  '- If multiple files are involved, add a ### Comparison section.',
  '- For simple factual questions, a single well-formatted paragraph with citations is sufficient.',
  '- Keep wording concise, precise, and non-redundant.',
  '- Keep citations inline and do not add a references section.',
].join('\n');

const normalizeChatSessionConfig = (value?: Partial<ChatSessionConfig> | null): ChatSessionConfig => {
  const goalMode: ChatGoalMode = value?.goalMode === 'learning-guide' ? 'learning-guide' : 'default';
  const responseLength: ChatResponseLength =
    value?.responseLength === 'longer' || value?.responseLength === 'shorter'
      ? value.responseLength
      : 'default';

  return {
    goalMode,
    responseLength,
  };
};

const readStoredChatSessionConfigs = (): Record<string, ChatSessionConfig> => {
  try {
    const raw = localStorage.getItem(CHAT_SESSION_CONFIGS_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};

    return Object.entries(parsed as Record<string, unknown>).reduce<Record<string, ChatSessionConfig>>((acc, [sessionId, configValue]) => {
      if (!sessionId) return acc;
      acc[sessionId] = normalizeChatSessionConfig((configValue as Partial<ChatSessionConfig>) || undefined);
      return acc;
    }, {});
  } catch {
    return {};
  }
};

const readStoredValue = (key: string) => {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
};

const writeStoredValue = (key: string, value: string) => {
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage failures in private mode or when storage is unavailable.
  }
};

const createEmptyCloudModelsByProvider = (): Record<CloudApiProvider, string[]> => ({
  gemini: [],
  openai: [],
  openai_compatible: [],
  openrouter: [],
  anthropic: [],
  cerebras: [],
});

const normalizeStoredCloudModelList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  const deduped: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const normalized = entry.trim();
    if (!normalized || deduped.includes(normalized)) {
      continue;
    }

    deduped.push(normalized);
  }

  return deduped;
};

const readStoredCloudModelsByProvider = (): Record<CloudApiProvider, string[]> => {
  const defaults = createEmptyCloudModelsByProvider();

  try {
    const raw = localStorage.getItem(CLOUD_MODELS_BY_PROVIDER_STORAGE_KEY);
    if (!raw) return defaults;

    const parsed = JSON.parse(raw) as Partial<Record<CloudApiProvider, unknown>>;
    if (!parsed || typeof parsed !== 'object') return defaults;

    return {
      gemini: normalizeStoredCloudModelList(parsed.gemini),
      openai: normalizeStoredCloudModelList(parsed.openai),
      openai_compatible: normalizeStoredCloudModelList(parsed.openai_compatible),
      openrouter: normalizeStoredCloudModelList(parsed.openrouter),
      anthropic: normalizeStoredCloudModelList(parsed.anthropic),
      cerebras: normalizeStoredCloudModelList(parsed.cerebras),
    };
  } catch {
    return defaults;
  }
};

const readStoredApiProvider = (): ApiProvider => {
  const saved = readStoredValue(SETTINGS_STORAGE_KEYS.apiProvider);
  return saved === 'gemini' || saved === 'openai' || saved === 'openai_compatible' || saved === 'openrouter' || saved === 'anthropic' || saved === 'cerebras' || saved === 'local' ? saved : 'gemini';
};

export default function App() {
  const [currentView, setCurrentView] = useState<'landing' | 'login' | 'signup' | 'workspace'>(() => {
    try {
      return localStorage.getItem('nb_auth_token') ? 'workspace' : 'landing';
    } catch {
      return 'landing';
    }
  });

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const [documents, setDocuments] = useState<Document[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [sessionChatConfigs, setSessionChatConfigs] = useState<Record<string, ChatSessionConfig>>(() => readStoredChatSessionConfigs());
  const [activeChatConfig, setActiveChatConfig] = useState<ChatSessionConfig>(DEFAULT_CHAT_SESSION_CONFIG);
  const [messages, setMessages] = useState<Message[]>([]);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [composerDraftBeforeEdit, setComposerDraftBeforeEdit] = useState<{ input: string; attachedFiles: Document[] } | null>(null);
  const [messageFeedback, setMessageFeedback] = useState<Record<string, MessageFeedback>>(() => {
    try {
      const saved = localStorage.getItem('notestack-message-feedback');
      if (!saved) return {};
      const parsed = JSON.parse(saved) as Record<string, string>;
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => value === 'like' || value === 'dislike')
      ) as Record<string, MessageFeedback>;
    } catch {
      return {};
    }
  });
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [activeApiKey, setActiveApiKey] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.geminiApiKey) || DEFAULT_GEMINI_API_KEY);
  const [openaiApiKey, setOpenaiApiKey] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.openaiApiKey));
  const [openaiCompatibleApiKey, setOpenaiCompatibleApiKey] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.openaiCompatibleApiKey));
  const [openrouterApiKey, setOpenrouterApiKey] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.openrouterApiKey));
  const [anthropicApiKey, setAnthropicApiKey] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.anthropicApiKey));
  const [cerebrasApiKey, setCerebrasApiKey] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.cerebrasApiKey));
  const [geminiModel, setGeminiModel] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.geminiModel));
  const [openaiModel, setOpenaiModel] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.openaiModel));
  const [openaiCompatibleModel, setOpenaiCompatibleModel] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.openaiCompatibleModel));
  const [openrouterModel, setOpenrouterModel] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.openrouterModel));
  const [anthropicModel, setAnthropicModel] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.anthropicModel));
  const [cerebrasModel, setCerebrasModel] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.cerebrasModel));
  const [openaiCompatibleBaseUrl, setOpenaiCompatibleBaseUrl] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.openaiCompatibleBaseUrl));
  const [apiKeyError, setApiKeyError] = useState('');
  const [apiProvider, setApiProvider] = useState<ApiProvider>(readStoredApiProvider);
  const [cloudModelsByProvider, setCloudModelsByProvider] = useState<Record<CloudApiProvider, string[]>>(() => readStoredCloudModelsByProvider());
  const [cloudValidationByProvider, setCloudValidationByProvider] = useState<Record<CloudApiProvider, CloudValidationState>>({
    gemini: { status: 'idle', message: '' },
    openai: { status: 'idle', message: '' },
    openai_compatible: { status: 'idle', message: '' },
    openrouter: { status: 'idle', message: '' },
    anthropic: { status: 'idle', message: '' },
    cerebras: { status: 'idle', message: '' },
  });
  const [isCloudValidationBusy, setIsCloudValidationBusy] = useState(false);
  const [isProviderDropdownOpen, setIsProviderDropdownOpen] = useState(false);
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [localModelUrl, setLocalModelUrl] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.localModelUrl));
  const [localModelName, setLocalModelName] = useState(() => readStoredValue(SETTINGS_STORAGE_KEYS.localModelName));
  const [localEndpointType, setLocalEndpointType] = useState<LocalEndpointType | null>(null);
  const [localDiscoveredModels, setLocalDiscoveredModels] = useState<string[]>([]);
  const [localDockerHint, setLocalDockerHint] = useState('');
  const [localLastCheckedAt, setLocalLastCheckedAt] = useState<number | null>(null);
  const [showLocalConnectionLogs, setShowLocalConnectionLogs] = useState(false);
  const [isLocalDiscoveryBusy, setIsLocalDiscoveryBusy] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState('account');

  const [systemInstructions, setSystemInstructions] = useState(() => {
    try {
      const savedInstructions = localStorage.getItem(SYSTEM_INSTRUCTIONS_STORAGE_KEY);
      if (!savedInstructions || savedInstructions === LEGACY_DEFAULT_SYSTEM_INSTRUCTIONS) {
        return ENHANCED_DEFAULT_SYSTEM_INSTRUCTIONS;
      }
      return savedInstructions;
    } catch {
      return ENHANCED_DEFAULT_SYSTEM_INSTRUCTIONS;
    }
  });
  const [notes, setNotes] = useState<Note[]>(() => {
    try {
      const saved = localStorage.getItem('notestack-notes');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.error("Failed to load notes", e);
      return [];
    }
  });
  const [noteMenuOptions, setNoteMenuOptions] = useState<{ id: string, x: number, y: number } | null>(null);
  const [noteSaveStatus, setNoteSaveStatus] = useState<'Saved' | 'Saving...'>('Saved');
  const [isNotesOpen, setIsNotesOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('notes');
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [isNotePreviewMode, setIsNotePreviewMode] = useState(true);
  const [sourceSearchQuery, setSourceSearchQuery] = useState('');
  const [noteSearchQuery, setNoteSearchQuery] = useState('');
  const [noteSortOrder, setNoteSortOrder] = useState<'asc' | 'desc'>('desc');
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [responseMenuOptions, setResponseMenuOptions] = useState<{ messageId: string, x: number, y: number } | null>(null);
  const [responseMenuSelectedModel, setResponseMenuSelectedModel] = useState('');
  const [isResponseModelDropdownOpen, setIsResponseModelDropdownOpen] = useState(false);
  const [regeneratingMessageId, setRegeneratingMessageId] = useState<string | null>(null);
  const [localConnectionLogs, setLocalConnectionLogs] = useState<string[]>(['Ready to test connection...']);
  const localAutoDiscoveryAttemptedRef = useRef(false);
  const isLocalRuntimeConnected = Boolean(localEndpointType && localModelUrl.trim() && localModelName.trim());
  const activeChatStreamControllerRef = useRef<AbortController | null>(null);
  const activeChatRequestRef = useRef<{ requestId: string; sessionId: string | null } | null>(null);
  const { toast: pushToast, inline: pushInline, clearInline, confirm, openModal, closeModal } = useNotifications();

  const formatSize = (bytes?: number) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (ts?: number) => {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatDateTime = (ts?: number) => {
    if (!ts) return '';
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const parseDateValue = (value?: string | number | null): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  const toChatSession = (session: any): ChatSession => {
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

  const sortChatSessionsByRecent = (sessions: ChatSession[]) => {
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  };

  const getChatConfigForSession = (
    sessionId: string | null | undefined,
    configMap: Record<string, ChatSessionConfig> = sessionChatConfigs
  ): ChatSessionConfig => {
    if (!sessionId) return DEFAULT_CHAT_SESSION_CONFIG;
    return normalizeChatSessionConfig(configMap[sessionId]);
  };

  const setChatConfigForSession = (sessionId: string | null | undefined, config: ChatSessionConfig) => {
    if (!sessionId) return;
    const normalized = normalizeChatSessionConfig(config);
    setSessionChatConfigs((prev) => ({
      ...prev,
      [sessionId]: normalized,
    }));
  };

  const updateActiveChatConfig = (updates: Partial<ChatSessionConfig>) => {
    setActiveChatConfig((prev) => {
      const next = normalizeChatSessionConfig({ ...prev, ...updates });
      if (activeChatSessionId) {
        setChatConfigForSession(activeChatSessionId, next);
      }
      return next;
    });
  };

  const getFileIcon = (mimeType: string, className?: string, overrideColorClass?: string) => {
    const baseClass = className || "w-3.5 h-3.5";
    if (mimeType === 'application/pdf') return <File className={`${baseClass} ${overrideColorClass || 'text-red-500'}`} />;
    if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return <File className={`${baseClass} ${overrideColorClass || 'text-orange-500'}`} />;
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return <FileText className={`${baseClass} ${overrideColorClass || 'text-blue-500'}`} />;
    if (mimeType === 'text/plain') return <FileText className={`${baseClass} ${overrideColorClass || 'text-slate-400'}`} />;
    if (mimeType.startsWith('audio/')) return <Mic className={`${baseClass} ${overrideColorClass || 'text-fuchsia-500'}`} />;
    return <FileText className={`${baseClass} ${overrideColorClass || 'text-blue-400'}`} />;
  };

  const getAttachmentTypeLabel = (mimeType?: string, fileName?: string) => {
    if (mimeType === 'application/pdf') return 'PDF';
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'DOCX';
    if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'PPTX';
    if (mimeType === 'text/plain') return 'TXT';
    if (mimeType?.startsWith('audio/')) return 'AUDIO';

    const parts = fileName ? fileName.split('.') : [];
    if (parts.length > 1) {
      const extension = parts[parts.length - 1];
      if (extension) return extension.toUpperCase();
    }
    return 'FILE';
  };

  const getAttachmentAccentClass = (mimeType?: string) => {
    if (mimeType === 'application/pdf') return 'bg-red-500';
    if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'bg-orange-500';
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'bg-blue-500';
    if (mimeType?.startsWith('audio/')) return 'bg-fuchsia-500';
    return 'bg-indigo-500';
  };

  const getMessageStyle = (msg: Message) => {
    let styleClasses = "px-6 py-3.5 leading-relaxed whitespace-pre-wrap transition-all duration-200 ";
    if (msg.role === 'model') {
      styleClasses += "bg-[var(--bg-color)] text-[var(--text-color)] rounded-[22px] rounded-tl-md border border-[var(--border-color)] shadow-sm max-w-[90%] self-start transition-colors duration-300";
    } else {
      styleClasses += "text-[15px] text-[var(--text-color)] bg-[var(--panel-hover)] rounded-[22px] rounded-tr-md shadow-sm max-w-[95%] border border-[var(--border-color)] self-end transition-colors duration-300";
    }
    return styleClasses;
  };
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);


  // Account Settings State
  const [accountFirstName, setAccountFirstName] = useState('');
  const [accountLastName, setAccountLastName] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [accountConfirmPassword, setAccountConfirmPassword] = useState('');
  const [showAccountPassword, setShowAccountPassword] = useState(false);
  const [showAccountConfirmPassword, setShowAccountConfirmPassword] = useState(false);
  const accountHydrationRequestIdRef = useRef(0);

  useEffect(() => {
    if (!isSettingsOpen || currentView !== 'workspace') return;

    const requestId = ++accountHydrationRequestIdRef.current;

    api.getMe().then(user => {
      if (accountHydrationRequestIdRef.current !== requestId) {
        return;
      }
      setAccountFirstName(user.first_name || '');
      setAccountLastName(user.last_name || '');
      setAccountEmail(user.email || '');
    }).catch((err: any) => {
      if (isAuthError(err?.status, err?.message)) {
        handleSignOut();
        showToast('Session expired. Please sign in again.', 'warning');
      }
    });
    setAccountPassword('');
    setAccountConfirmPassword('');
    setShowAccountPassword(false);
    setShowAccountConfirmPassword(false);
    clearInline(ACCOUNT_SETTINGS_INLINE_SCOPE);
  }, [isSettingsOpen, currentView]);

  useEffect(() => {
    writeStoredValue(SETTINGS_STORAGE_KEYS.apiProvider, apiProvider);
  }, [apiProvider]);

  useEffect(() => {
    try {
      localStorage.setItem(CLOUD_MODELS_BY_PROVIDER_STORAGE_KEY, JSON.stringify(cloudModelsByProvider));
    } catch {
      // Ignore persistence failures (private mode / storage limits)
    }
  }, [cloudModelsByProvider]);

  const accountPasswordRequirements = [
    { key: 'length', label: 'At least 8 characters', valid: accountPassword.length >= 8 },
    { key: 'uppercase', label: 'At least 1 uppercase letter', valid: /[A-Z]/.test(accountPassword) },
    { key: 'lowercase', label: 'At least 1 lowercase letter', valid: /[a-z]/.test(accountPassword) },
    { key: 'number', label: 'At least 1 number', valid: /\d/.test(accountPassword) },
    { key: 'special', label: 'At least 1 special character', valid: /[^A-Za-z0-9]/.test(accountPassword) },
  ];
  const isAccountPasswordValid = accountPasswordRequirements.every((requirement) => requirement.valid);
  const isAccountPasswordConfirmed = accountPassword.length > 0 && accountPassword === accountConfirmPassword;
  const isAccountSaveBlockedByPassword = accountPassword.length > 0 && (!isAccountPasswordValid || !isAccountPasswordConfirmed);

  const handleUpdateAccount = async () => {
    clearInline(ACCOUNT_SETTINGS_INLINE_SCOPE);
    accountHydrationRequestIdRef.current += 1;

    const firstName = accountFirstName.trim();
    const lastName = accountLastName.trim();
    const email = accountEmail.trim();

    if (!firstName || !lastName || !email) {
      pushInline({
        scope: ACCOUNT_SETTINGS_INLINE_SCOPE,
        type: 'error',
        message: 'First name, last name, and email are required.',
      });
      return;
    }

    if (accountPassword) {
      if (!isAccountPasswordValid) {
        pushInline({
          scope: ACCOUNT_SETTINGS_INLINE_SCOPE,
          type: 'error',
          message: 'New password must satisfy all password requirements.',
        });
        return;
      }
      if (!accountConfirmPassword) {
        pushInline({
          scope: ACCOUNT_SETTINGS_INLINE_SCOPE,
          type: 'error',
          message: 'Please confirm your new password.',
        });
        return;
      }
      if (!isAccountPasswordConfirmed) {
        pushInline({
          scope: ACCOUNT_SETTINGS_INLINE_SCOPE,
          type: 'error',
          message: 'Passwords do not match.',
        });
        return;
      }
    }

    try {
      const payload: {
        email: string;
        first_name: string;
        last_name: string;
        password?: string;
      } = {
        email,
        first_name: firstName,
        last_name: lastName,
      };

      if (accountPassword) {
        payload.password = accountPassword;
      }

      const updatedUser = await api.updateMe(payload);
      setAccountFirstName(updatedUser.first_name || '');
      setAccountLastName(updatedUser.last_name || '');
      setAccountEmail(updatedUser.email || '');
      pushInline({
        scope: ACCOUNT_SETTINGS_INLINE_SCOPE,
        type: 'success',
        message: 'Account updated successfully.',
        autoClearMs: 5000,
      });
      setAccountPassword('');
      setAccountConfirmPassword('');
      setShowAccountPassword(false);
      setShowAccountConfirmPassword(false);
    } catch (err: any) {
      if (isAuthError(err?.status, err?.message)) {
        handleSignOut();
        showToast('Session expired. Please sign in again.', 'warning');
        return;
      }
      pushInline({
        scope: ACCOUNT_SETTINGS_INLINE_SCOPE,
        type: 'error',
        message: err?.message || 'Failed to update account.',
      });
    }
  };

  const summaryViewerOpenRef = useRef(false);
  const [summaryContent, setSummaryContent] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<Document[]>([]);
  const [isInputDragging, setIsInputDragging] = useState(false);

  const [previewDoc, setPreviewDoc] = useState<Document | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [stagedPreviewUrl, setStagedPreviewUrl] = useState<string | null>(null);
  const [stagedPreviewType, setStagedPreviewType] = useState<string | null>(null);
  const [stagedPreviewText, setStagedPreviewText] = useState<string | null>(null);
  const [stagedPreviewHtml, setStagedPreviewHtml] = useState<string | null>(null);

  const [sortOption, setSortOption] = useState<'name' | 'date' | 'size'>('date');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [isSortDropdownOpen, setIsSortDropdownOpen] = useState(false);
  const [folderSortOption, setFolderSortOption] = useState<'name' | 'date' | 'count'>('date');
  const [folderSortOrder, setFolderSortOrder] = useState<'asc' | 'desc'>('desc');

  const expandTimerRef = useRef<{ [folderId: string]: NodeJS.Timeout }>({});

  const showToast = (message: string, type: NotificationType = 'info') => {
    pushToast({
      type,
      message,
      feature: 'workspace',
      durationMs: 5000,
    });
  };

  const parseBackendErrorDetail = (rawText: string) => {
    if (!rawText) return '';
    try {
      const parsed = JSON.parse(rawText);
      if (typeof parsed?.detail === 'string' && parsed.detail.trim()) {
        return parsed.detail;
      }
    } catch {
      // Non-JSON payload; return raw text below.
    }
    return rawText;
  };

  const isAuthError = (status?: number, message?: string) => {
    if (status === 401 || status === 403) return true;
    const lower = (message || '').toLowerCase();
    return (
      lower.includes('could not validate credentials') ||
      lower.includes('not authenticated') ||
      lower.includes('token has expired') ||
      lower.includes('signature has expired') ||
      lower.includes('session expired')
    );
  };

  const isCitationPersistenceValidationError = (status?: number, message?: string) => {
    if (status !== 422 && status !== 400) return false;
    const lower = (message || '').toLowerCase();
    return (
      lower.includes('citation') ||
      lower.includes('chunk_index') ||
      lower.includes('chunk_indices') ||
      lower.includes('body.citations')
    );
  };

  const isBillingOrQuotaError = (message?: string) => {
    const lower = (message || '').toLowerCase();
    return (
      lower.includes('payment required') ||
      lower.includes('payment_required') ||
      lower.includes('billing tab') ||
      lower.includes('quota') ||
      lower.includes('error code: 402') ||
      lower.includes('code: 402')
    );
  };

  const getDisplayStreamErrorMessage = (message?: string) => {
    const raw = (message || '').trim();
    if (!raw) return '';

    const structuredMessageRegex = /["']message["']\s*:\s*["']([^"']+)["']/i;
    const structuredMessageMatch = structuredMessageRegex.exec(raw);
    if (structuredMessageMatch?.[1]) {
      return structuredMessageMatch[1].trim();
    }

    const cleaned = raw
      .replace(/^error:\s*/i, '')
      .replace(/^error code:\s*\d+\s*-\s*/i, '')
      .trim();

    return cleaned || raw;
  };

  const getCloudProviderLabel = (provider: CloudApiProvider) => {
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'openai_compatible') return 'OpenAI-compatible';
    if (provider === 'gemini') return 'Gemini';
    if (provider === 'openrouter') return 'OpenRouter';
    if (provider === 'anthropic') return 'Anthropic';
    return 'Cerebras';
  };

  const getLocalEndpointTypeLabel = (endpointType?: LocalEndpointType | null) => {
    if (endpointType === 'ollama') return 'Ollama';
    if (endpointType === 'lm_studio') return 'LM Studio';
    if (endpointType === 'openai_compatible') return 'OpenAI-compatible runtime';
    return 'Local runtime';
  };

  const getCloudApiKeyForProvider = (provider: CloudApiProvider) => {
    if (provider === 'gemini') return (apiKeyInput || activeApiKey || '').trim();
    if (provider === 'openai') return (openaiApiKey || '').trim();
    if (provider === 'openai_compatible') return (openaiCompatibleApiKey || '').trim();
    if (provider === 'openrouter') return (openrouterApiKey || '').trim();
    if (provider === 'anthropic') return (anthropicApiKey || '').trim();
    return (cerebrasApiKey || '').trim();
  };

  const getCloudBaseUrlForProvider = (provider: ApiProvider) => {
    if (provider === 'openai_compatible') return (openaiCompatibleBaseUrl || '').trim();
    return '';
  };

  const persistCloudApiKeyForProvider = (provider: CloudApiProvider, key: string) => {
    if (provider === 'gemini') {
      setActiveApiKey(key);
      setApiKeyInput(key);
      writeStoredValue(SETTINGS_STORAGE_KEYS.geminiApiKey, key);
      return;
    }

    if (provider === 'openai') {
      setOpenaiApiKey(key);
      writeStoredValue(SETTINGS_STORAGE_KEYS.openaiApiKey, key);
      return;
    }

    if (provider === 'openai_compatible') {
      setOpenaiCompatibleApiKey(key);
      writeStoredValue(SETTINGS_STORAGE_KEYS.openaiCompatibleApiKey, key);
      return;
    }

    if (provider === 'openrouter') {
      setOpenrouterApiKey(key);
      writeStoredValue(SETTINGS_STORAGE_KEYS.openrouterApiKey, key);
      return;
    }

    if (provider === 'anthropic') {
      setAnthropicApiKey(key);
      writeStoredValue(SETTINGS_STORAGE_KEYS.anthropicApiKey, key);
      return;
    }

    setCerebrasApiKey(key);
    writeStoredValue(SETTINGS_STORAGE_KEYS.cerebrasApiKey, key);
  };

  const getCloudModelForProvider = (provider: ApiProvider) => {
    if (provider === 'local') return '';
    if (provider === 'gemini') return geminiModel;
    if (provider === 'openai') return openaiModel;
    if (provider === 'openai_compatible') return openaiCompatibleModel;
    if (provider === 'openrouter') return openrouterModel;
    if (provider === 'anthropic') return anthropicModel;
    return cerebrasModel;
  };

  const persistCloudModelForProvider = (provider: CloudApiProvider, model: string) => {
    if (provider === 'gemini') {
      setGeminiModel(model);
      writeStoredValue(SETTINGS_STORAGE_KEYS.geminiModel, model);
      return;
    }

    if (provider === 'openai') {
      setOpenaiModel(model);
      writeStoredValue(SETTINGS_STORAGE_KEYS.openaiModel, model);
      return;
    }

    if (provider === 'openai_compatible') {
      setOpenaiCompatibleModel(model);
      writeStoredValue(SETTINGS_STORAGE_KEYS.openaiCompatibleModel, model);
      return;
    }

    if (provider === 'openrouter') {
      setOpenrouterModel(model);
      writeStoredValue(SETTINGS_STORAGE_KEYS.openrouterModel, model);
      return;
    }

    if (provider === 'anthropic') {
      setAnthropicModel(model);
      writeStoredValue(SETTINGS_STORAGE_KEYS.anthropicModel, model);
      return;
    }

    setCerebrasModel(model);
    writeStoredValue(SETTINGS_STORAGE_KEYS.cerebrasModel, model);
  };

  const getCloudModelOptionsForProvider = (provider: ApiProvider) => {
    if (provider === 'local') return [];

    const selected = getCloudModelForProvider(provider).trim();
    const models = cloudModelsByProvider[provider] || [];
    if (!selected || models.includes(selected)) {
      return models;
    }
    return [selected, ...models];
  };

  const getActiveSelectedModel = () => {
    if (apiProvider === 'local') {
      return (localModelName || '').trim();
    }
    return getCloudModelForProvider(apiProvider).trim();
  };

  const getActiveModelSelectionOptions = () => {
    if (apiProvider === 'local') {
      const selected = (localModelName || '').trim();
      const available = localDiscoveredModels.filter((model) => (model || '').trim().length > 0);
      if (!selected || available.includes(selected)) {
        return available;
      }
      return [selected, ...available];
    }
    return getCloudModelOptionsForProvider(apiProvider);
  };

  const getSelectedModelDescriptor = (overrideModel?: string) => {
    const selectedOverride = (overrideModel || '').trim();

    if (apiProvider === 'local') {
      const endpointLabel = getLocalEndpointTypeLabel(localEndpointType);
      const selectedModel = selectedOverride || getActiveSelectedModel() || 'No local model selected';
      return `${endpointLabel} - ${selectedModel}`;
    }

    const providerLabel = getCloudProviderLabel(apiProvider);
    const selectedModel = selectedOverride || getActiveSelectedModel() || 'No cloud model selected';
    return `${providerLabel} - ${selectedModel}`;
  };

  const closeResponseActionMenu = () => {
    setResponseMenuOptions(null);
    setIsResponseModelDropdownOpen(false);
  };

  const getLatestModelMessageId = () => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'model') {
        return messages[i].id;
      }
    }
    return null;
  };

  const canRegenerateModelMessage = (messageId: string) => {
    return getLatestModelMessageId() === messageId;
  };

  const getCloudValidationForProvider = (provider: ApiProvider): CloudValidationState => {
    if (provider === 'local') {
      return { status: 'idle', message: '' };
    }
    return cloudValidationByProvider[provider] || { status: 'idle', message: '' };
  };

  const applyCloudValidationResult = (provider: CloudApiProvider, result: CloudProviderValidationResult) => {
    const availableModels = Array.isArray(result.available_models) ? result.available_models : [];
    setCloudModelsByProvider((prev) => ({
      ...prev,
      [provider]: availableModels,
    }));

    if (result.resolved_model) {
      persistCloudModelForProvider(provider, result.resolved_model);
    }

    setCloudValidationByProvider((prev) => ({
      ...prev,
      [provider]: {
        status: 'valid',
        message: result.message || `${getCloudProviderLabel(provider)} API key is valid.`,
        defaultModel: result.default_model || undefined,
        resolvedModel: result.resolved_model || undefined,
        fallbackApplied: result.fallback_applied,
        selectedModelAccessible: result.selected_model_accessible,
      },
    }));
  };

  const persistSystemInstructions = (value: string) => {
    localStorage.setItem(SYSTEM_INSTRUCTIONS_STORAGE_KEY, value);
  };

  const saveSystemInstructions = () => {
    try {
      persistSystemInstructions(systemInstructions);
      showToast('System instructions saved successfully.', 'info');
    } catch {
      showToast('Could not save system instructions.', 'warning');
    }
  };

  const resetSystemInstructionsToRecommended = () => {
    try {
      setSystemInstructions(ENHANCED_DEFAULT_SYSTEM_INSTRUCTIONS);
      persistSystemInstructions(ENHANCED_DEFAULT_SYSTEM_INSTRUCTIONS);
      showToast('Recommended system instructions restored.', 'info');
    } catch {
      showToast('Could not restore recommended instructions.', 'warning');
    }
  };

  const getCitationForMessage = (message: Message, citationNumberText: string): CitationItem | null => {
    const citationNumber = Number.parseInt(citationNumberText, 10);
    if (!Number.isFinite(citationNumber)) return null;
    return message.citations?.find((citation) => citation.citation_number === citationNumber) || null;
  };

  const toCompactText = (value?: string) => (value || '').replace(/\s+/g, ' ').trim();

  const toWordBoundaryEllipsis = (value: string, maxLength: number) => {
    if (value.length <= maxLength) return value;

    const extendedSlice = value.slice(0, maxLength + 1);
    const boundary = extendedSlice.lastIndexOf(' ');
    const minBoundary = Math.floor(maxLength * 0.7);
    const safeCut = boundary >= minBoundary ? extendedSlice.slice(0, boundary) : value.slice(0, maxLength);
    return `${safeCut.trimEnd()}...`;
  };

  const toCitationSnippetText = (snippet: string) => {
    const compactSnippet = toCompactText(snippet);
    if (!compactSnippet) return 'Citation excerpt unavailable.';
    return compactSnippet;
  };

  const toCitationTitleFromSnippet = (snippet: string, citationNumberText: string) => {
    const compactSnippet = toCitationSnippetText(snippet);
    if (!compactSnippet) return `Source Excerpt ${citationNumberText}`;

    const maxTitleLength = 88;
    if (compactSnippet.length <= maxTitleLength) return compactSnippet;
    return toWordBoundaryEllipsis(compactSnippet, maxTitleLength);
  };

  const getCitationSourceContext = (documentName?: string, chunkIndex?: number, chunkIndices?: number[]) => {
    const normalizedChunkIndices = Array.isArray(chunkIndices)
      ? Array.from(new Set(chunkIndices.filter((index) => Number.isFinite(index) && index >= 0))).sort((a, b) => a - b)
      : [];

    let chunkLabel = '';
    if (normalizedChunkIndices.length === 1) {
      chunkLabel = `Chunk ${normalizedChunkIndices[0] + 1}`;
    } else if (normalizedChunkIndices.length > 1) {
      const preview = normalizedChunkIndices.slice(0, 4).map((index) => String(index + 1)).join(', ');
      chunkLabel = normalizedChunkIndices.length > 4
        ? `Chunks ${preview}, +${normalizedChunkIndices.length - 4} more`
        : `Chunks ${preview}`;
    } else if (Number.isFinite(chunkIndex)) {
      chunkLabel = `Chunk ${Number(chunkIndex) + 1}`;
    }

    if (documentName && chunkLabel) return `${documentName} - ${chunkLabel}`;
    if (documentName) return documentName;
    if (chunkLabel) return chunkLabel;
    return undefined;
  };

  const closeSummaryViewer = () => {
    summaryViewerOpenRef.current = false;
    closeModal();
  };

  const openSummaryViewerModal = (content: string, loading: boolean) => {
    if (!summaryViewerOpenRef.current) {
      return;
    }

    openModal({
      title: 'Document Summary',
      message: loading ? 'Analyzing and summarizing documents...' : '',
      type: 'info',
      feature: 'summary',
      size: 'xl',
      closeOnBackdropClick: false,
      content: loading ? (
        <div className="flex min-h-[180px] flex-col items-center justify-center text-slate-300">
          <Loader2 className="mb-4 h-8 w-8 animate-spin text-blue-500" />
          <p className="text-[14px]">Analyzing and summarizing documents...</p>
        </div>
      ) : (
        <div className="max-h-[65vh] overflow-y-auto pr-1 custom-scrollbar">
          <div className="prose prose-sm prose-invert max-w-none prose-p:leading-[1.7] prose-headings:text-slate-200 prose-strong:text-slate-200">
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
              {content || 'Could not generate a summary.'}
            </Markdown>
          </div>
        </div>
      ),
      actions: [
        {
          label: loading ? 'Hide' : 'Close',
          variant: 'ghost',
          onClick: closeSummaryViewer,
        },
      ],
    });
  };

  const openCitationDetailsModal = (citation: {
    number: string;
    snippet: string;
    documentName?: string;
    chunkIndex?: number;
    chunkIndices?: number[];
    sourceContext?: string;
  }) => {
    const citationSnippetText = toCitationSnippetText(citation.snippet);
    const citationTitle = citation.documentName || toCitationTitleFromSnippet(citationSnippetText, citation.number);
    const sourceContext = citation.sourceContext || getCitationSourceContext(undefined, citation.chunkIndex, citation.chunkIndices);

    openModal({
      title: citationTitle,
      message: sourceContext || '',
      type: 'info',
      feature: 'citations',
      size: 'md',
      closeOnBackdropClick: true,
      content: (
        <p className="text-[14px] text-slate-300 border-l-2 border-blue-500 pl-4 py-1 bg-[#2a2a2d]/50 rounded-r-lg leading-relaxed">
          {citationSnippetText}
        </p>
      ),
      actions: [
        {
          label: 'Close',
          variant: 'ghost',
        },
      ],
    });
  };

  const beautifyGeneratedMarkdown = (rawText: string): string => {
    const normalized = String(rawText || '').replace(/\r\n?/g, '\n').trim();
    if (!normalized) return normalized;

    const markdownAnalysis = detectMarkdownStructure(normalized);
    let formatted = normalized
      // Ensure inline citations are not glued to surrounding words.
      .replace(/([A-Za-z0-9])(\[\d+\]\(#cite-\d+\))/g, '$1 $2')
      .replace(/(\]\(#cite-\d+\))(?=[A-Za-z0-9])/g, '$1 ')
      // Ensure ordered list markers keep a space after the period.
      .replace(/^(\s*)(\d+)\.(?=\S)/gm, '$1$2. ')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();

    // Preserve model-authored markdown as-is whenever structure is detected.
    if (markdownAnalysis.likelyMarkdown) {
      return formatted;
    }

    // Light readability fallback for plain-text outputs only.
    if (!formatted.includes('\n\n')) {
      const sentences = formatted
        .match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g)
        ?.map((sentence) => sentence.trim())
        .filter((sentence) => sentence.length > 0);

      if (sentences && sentences.length >= 4) {
        const paragraphs: string[] = [];
        for (let i = 0; i < sentences.length; i += 2) {
          paragraphs.push(sentences.slice(i, i + 2).join(' '));
        }
        formatted = paragraphs.join('\n\n');
      }
    }

    return formatted;
  };

  const getRenderableMessageText = (message: Message): string => {
    const normalizedCitationsText = normalizeCitationReferencesInText(message.text, message.citations);
    return beautifyGeneratedMarkdown(normalizedCitationsText);
  };

  const hydratePersistedMessages = (persistedMessages: any[]) => {
    const feedbackFromServer: Record<string, MessageFeedback> = {};

    const hydratedMessages: Message[] = (persistedMessages || []).map((msg: any) => {
      if (msg.feedback === 'like' || msg.feedback === 'dislike') {
        feedbackFromServer[String(msg.id)] = msg.feedback;
      }

      return {
        id: String(msg.id),
        role: msg.role === 'assistant' ? 'model' : (msg.role === 'user' ? 'user' : 'model'),
        text: msg.text,
        attachedFiles: Array.isArray(msg.attached_files) ? msg.attached_files : undefined,
        citations: normalizeCitationItems(msg.citations),
      };
    });

    return { hydratedMessages, feedbackFromServer };
  };

  const isChatRequestActive = (requestId: string, sessionId?: string | null): boolean => {
    const activeRequest = activeChatRequestRef.current;
    if (!activeRequest || activeRequest.requestId !== requestId) return false;
    if (sessionId !== undefined && activeRequest.sessionId !== sessionId) return false;
    return true;
  };

  const cancelActiveChatStream = () => {
    activeChatRequestRef.current = null;
    if (activeChatStreamControllerRef.current) {
      activeChatStreamControllerRef.current.abort();
      activeChatStreamControllerRef.current = null;
    }
    setIsLoading(false);
  };

  const handleOpenChatSession = async (sessionId: string) => {
    if (!sessionId) return;
    cancelActiveChatStream();
    try {
      const persistedMessages = await api.getChatMessages(sessionId).catch(() => []);
      const { hydratedMessages, feedbackFromServer } = hydratePersistedMessages(persistedMessages || []);
      setActiveChatSessionId(sessionId);
      setActiveChatConfig(getChatConfigForSession(sessionId));
      setMessages(hydratedMessages);
      setMessageFeedback(feedbackFromServer);
    } catch {
      showToast('Could not load selected chat history.', 'warning');
    }
  };

  const handleStartNewChat = async () => {
    cancelActiveChatStream();
    try {
      const createdSession = await api.createChatSession();
      const normalizedSession = toChatSession(createdSession);
      const initialConfigForNewSession = activeChatSessionId ? DEFAULT_CHAT_SESSION_CONFIG : activeChatConfig;

      setChatSessions((prev) => sortChatSessionsByRecent([
        normalizedSession,
        ...prev.filter((session) => session.id !== normalizedSession.id),
      ]));

      setActiveChatSessionId(normalizedSession.id);
      setChatConfigForSession(normalizedSession.id, initialConfigForNewSession);
      setActiveChatConfig(normalizeChatSessionConfig(initialConfigForNewSession));
      setMessages([]);
      setMessageFeedback({});
      showToast('New chat started.', 'info');
    } catch {
      showToast('Could not create a new chat session.', 'warning');
    }
  };

  useEffect(() => {
    try {
      localStorage.setItem('notestack-message-feedback', JSON.stringify(messageFeedback));
    } catch {
      // Ignore persistence failures (private mode / storage limits)
    }
  }, [messageFeedback]);

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_SESSION_CONFIGS_STORAGE_KEY, JSON.stringify(sessionChatConfigs));
    } catch {
      // Ignore persistence failures (private mode / storage limits)
    }
  }, [sessionChatConfigs]);

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
            timestamp: parseDateValue(doc.created_at) ?? parseDateValue(doc.timestamp) ?? undefined,
          }))
        );

        setFolders(
          (folderList || []).map((folder: any) => ({
            id: String(folder.id),
            name: folder.name,
            timestamp: parseDateValue(folder.created_at) ?? parseDateValue(folder.timestamp) ?? undefined,
            isExpanded: true,
          }))
        );

        if ((noteList || []).length > 0) {
          setNotes(
            noteList.map((note: any) => ({
              id: String(note.id),
              title: note.title,
              content: note.content,
              timestamp: Number(note.timestamp) || Date.now(),
            }))
          );
        }

        const normalizedSessions = sortChatSessionsByRecent((sessionList || []).map((session: any) => toChatSession(session)));
        setChatSessions(normalizedSessions);

        if (normalizedSessions.length > 0) {
          const latestSessionId = normalizedSessions[0].id;
          setActiveChatSessionId(latestSessionId);
          setActiveChatConfig(getChatConfigForSession(latestSessionId));

          const persistedMessages = await api.getChatMessages(latestSessionId).catch(() => []);
          if (cancelled) return;

          const { hydratedMessages, feedbackFromServer } = hydratePersistedMessages(persistedMessages || []);

          setMessages(
            hydratedMessages.length > 0
              ? hydratedMessages
              : []
          );
          setMessageFeedback(feedbackFromServer);
        } else {
          setActiveChatSessionId(null);
          setActiveChatConfig(DEFAULT_CHAT_SESSION_CONFIG);
          setMessages([]);
          setMessageFeedback({});
        }
      } catch {
        if (!cancelled) {
          handleSignOut();
          showToast('Session expired. Please sign in again.', 'warning');
        }
      }
    };

    void hydrateWorkspace();
    return () => {
      cancelled = true;
    };
  }, [currentView]);

  const trimForPrompt = (text: string, maxLength = 220) => {
    const compact = text.replace(/\s+/g, ' ').trim();
    if (compact.length <= maxLength) return compact;
    return `${compact.slice(0, maxLength)}...`;
  };

  const buildFeedbackGuidance = () => {
    const likedExamples = messages
      .filter((m) => m.role === 'model' && messageFeedback[m.id] === 'like' && m.text.trim().length > 0)
      .slice(-3)
      .map((m) => `- ${trimForPrompt(m.text)}`)
      .join('\n');

    const dislikedExamples = messages
      .filter((m) => m.role === 'model' && messageFeedback[m.id] === 'dislike' && m.text.trim().length > 0)
      .slice(-3)
      .map((m) => `- ${trimForPrompt(m.text)}`)
      .join('\n');

    if (!likedExamples && !dislikedExamples) return '';

    return `\n\nQuality optimization based on explicit user feedback in this chat:\n- Prioritize response patterns similar to liked examples.\n- Avoid response patterns similar to disliked examples.\n- Keep answers factual, clear, and directly actionable.\n${likedExamples ? `Liked examples:\n${likedExamples}\n` : ''}${dislikedExamples ? `Disliked examples:\n${dislikedExamples}` : ''}`;
  };

  const buildChatConfigurationGuidance = () => {
    const configLines: string[] = [];

    if (activeChatConfig.goalMode === 'learning-guide') {
      configLines.push('- Conversational goal: act as a learning guide. Explain key ideas step-by-step, define terms, and teach progressively.');
    }

    if (activeChatConfig.responseLength === 'longer') {
      configLines.push('- Response length: provide a longer, more detailed answer with richer supporting explanation when evidence allows.');
    } else if (activeChatConfig.responseLength === 'shorter') {
      configLines.push('- Response length: keep the answer concise and direct, minimizing extra detail while preserving critical evidence.');
    }

    if (configLines.length === 0) return '';
    return `\n\nActive chat configuration for this session:\n${configLines.join('\n')}`;
  };

  const handleMessageFeedback = (messageId: string, feedback: MessageFeedback) => {
    const nextFeedback: MessageFeedback | null = messageFeedback[messageId] === feedback ? null : feedback;
    setMessageFeedback((prev) => {
      const next = { ...prev };
      if (nextFeedback === null) {
        delete next[messageId];
        showToast('Feedback removed', 'info');
        return next;
      }
      next[messageId] = feedback;
      showToast(feedback === 'like' ? 'Marked as helpful' : 'Marked as needs improvement', 'info');
      return next;
    });

    if (!messageId.startsWith('welcome-')) {
      api.setMessageFeedback(messageId, nextFeedback).catch(() => {
        showToast('Could not sync feedback to server', 'warning');
      });
    }
  };

  const [isGroupingFolder, setIsGroupingFolder] = useState(false);
  const [groupFolderInput, setGroupFolderInput] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputFileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  useEffect(() => {
    return () => {
      activeChatRequestRef.current = null;
      if (activeChatStreamControllerRef.current) {
        activeChatStreamControllerRef.current.abort();
        activeChatStreamControllerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  useEffect(() => {
    if (!responseMenuOptions) {
      return;
    }

    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeResponseActionMenu();
      }
    };

    window.addEventListener('keydown', handleEscapeKey);
    return () => {
      window.removeEventListener('keydown', handleEscapeKey);
    };
  }, [responseMenuOptions]);

  useEffect(() => {
    setNoteSaveStatus('Saving...');
    const timer = setTimeout(() => {
      localStorage.setItem('notestack-notes', JSON.stringify(notes));
      setNoteSaveStatus('Saved');
    }, 1000);
    return () => clearTimeout(timer);
  }, [notes]);

  const processFiles = async (files: FileList | File[]) => {
    const fileArr = Array.from(files);
    const duplicates = fileArr.filter(f => documents.some(d => d.name === f.name && d.size === f.size));
    const uniqueFiles = fileArr.filter(f => !documents.some(d => d.name === f.name && d.size === f.size));

    if (duplicates.length > 0) {
      showToast(`Skipped ${duplicates.length} duplicate file(s) from upload.`, 'warning');
    }

    if (uniqueFiles.length === 0) return;

    const newUploads = uniqueFiles.map(f => ({
      id: Math.random().toString(36).substring(7),
      name: f.name,
      progress: 0,
      file: f
    }));

    setUploadingFiles(prev => [...prev, ...newUploads.map(u => ({ id: u.id, name: u.name, progress: 0 }))]);

    for (let i = 0; i < newUploads.length; i++) {
      const upload = newUploads[i];
      const file = upload.file;

      // Check if PDF, TXT, DOCX, PPTX, or Audio
      if (
        file.type !== 'application/pdf' &&
        file.type !== 'text/plain' &&
        file.type !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
        file.type !== 'application/vnd.openxmlformats-officedocument.presentationml.presentation' &&
        !file.type.startsWith('audio/')
      ) {
        showToast(`File ${file.name} is not supported. Supported files: PDF, TXT, DOCX, PPTX, Audio (MP3, MP4, WAV).`, 'error');
        setUploadingFiles(prev => prev.filter(u => u.id !== upload.id));
        continue;
      }

      if (file.size > 20 * 1024 * 1024) {
        showToast(`File ${file.name} is too large (max 20MB).`, 'error');
        setUploadingFiles(prev => prev.filter(u => u.id !== upload.id));
        continue;
      }

      // Real-time progress via FileReader
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onprogress = (event) => {
          if (event.lengthComputable) {
            const progress = (event.loaded / event.total) * 100;
            setUploadingFiles(prev => prev.map(u => u.id === upload.id ? { ...u, progress } : u));
          }
        };
        reader.onload = () => {
          const result = reader.result as string;
          // Extract base64 part
          const base64Data = result.split(',')[1];
          resolve(base64Data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      await localforage.setItem(upload.id, base64);
      setUploadingFiles(prev => prev.map(u => u.id === upload.id ? { ...u, progress: 100 } : u));

      // Upload to backend for text extraction & vector embedding
      let backendDocId = upload.id;
      try {
        const backendDoc = await api.uploadDocument(file);
        backendDocId = backendDoc.id;
        // Also cache under backend ID for preview/export
        await localforage.setItem(backendDocId, base64);
      } catch (err) {
        console.warn('Backend upload failed, document saved locally only:', err);
      }

      setDocuments((prev) => [...prev, {
        id: backendDocId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        timestamp: Date.now()
      }]);

      // Auto-select newly uploaded documents
      setSelectedDocIds(prev => [...prev, backendDocId]);

      setTimeout(() => {
         setUploadingFiles(prev => prev.filter(u => u.id !== upload.id));
      }, 500);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setStagedFiles(Array.from(e.target.files));
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleInputFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      await processInputFiles(e.target.files);
    }
    if (inputFileInputRef.current) {
      inputFileInputRef.current.value = '';
    }
  };

  const processInputFiles = async (files: FileList | File[]) => {
    const fileArr = Array.from(files);
    const duplicates = fileArr.filter(f => attachedFiles.some(d => d.name === f.name));
    const uniqueFiles = fileArr.filter(f => !attachedFiles.some(d => d.name === f.name));

    if (duplicates.length > 0) {
      showToast(`Skipped ${duplicates.length} duplicate file(s) from attachment.`, 'warning');
    }

    if (uniqueFiles.length === 0) return;

    const newUploads = uniqueFiles.map(f => ({
      id: Math.random().toString(36).substring(7),
      name: f.name,
      file: f
    }));

    for (let i = 0; i < newUploads.length; i++) {
      const upload = newUploads[i];
      const file = upload.file;

      if (
        file.type !== 'application/pdf' &&
        file.type !== 'text/plain' &&
        file.type !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
        file.type !== 'application/vnd.openxmlformats-officedocument.presentationml.presentation' &&
        !file.type.startsWith('audio/')
      ) {
        showToast(`File ${file.name} is not supported. Supported files: PDF, TXT, DOCX, PPTX, MP3, WAV.`, 'error');
        continue;
      }

      if (file.size > 20 * 1024 * 1024) {
        showToast(`File ${file.name} is too large (max 20MB).`, 'error');
        continue;
      }

      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onprogress = (event) => {
          if (event.lengthComputable) {
            const progress = (event.loaded / event.total) * 100;
            // No UI indicator for input files yet, but tracked here if needed.
          }
        };
        reader.onload = () => {
          const result = reader.result as string;
          const base64Data = result.split(',')[1];
          resolve(base64Data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      await localforage.setItem(upload.id, base64);

      let attachedDocId = upload.id;
      try {
        // Index input attachments server-side so RAG can retrieve from them.
        const backendDoc = await api.uploadDocument(file);
        attachedDocId = String(backendDoc.id);
        await localforage.setItem(attachedDocId, base64);

        setDocuments((prev) => {
          if (prev.some((doc) => doc.id === attachedDocId)) return prev;
          return [
            ...prev,
            {
              id: attachedDocId,
              name: file.name,
              mimeType: file.type,
              size: file.size,
              timestamp: Date.now(),
            },
          ];
        });
      } catch (err) {
        console.warn('Could not index input attachment on backend:', err);
        showToast(`Attached ${file.name}, but indexing failed. It may not be searchable yet.`, 'warning');
      }

      setAttachedFiles((prev) => {
        if (prev.some((doc) => doc.id === attachedDocId)) return prev;
        return [
          ...prev,
          {
            id: attachedDocId,
            name: file.name,
            mimeType: file.type,
            size: file.size,
            timestamp: Date.now(),
          },
        ];
      });
    }
  };

  const handleInputDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain') || e.dataTransfer.types.includes('application/notestack-docs')) {
      e.preventDefault();
      if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/notestack-docs')) {
        setIsInputDragging(true);
      }
    }
  };

  const handleInputDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain') || e.dataTransfer.types.includes('application/notestack-docs')) {
      e.preventDefault();
      setIsInputDragging(false);
    }
  };

  const handleInputDrop = async (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain') || e.dataTransfer.types.includes('application/notestack-docs')) {
      e.preventDefault();
      setIsInputDragging(false);

      if (e.dataTransfer.types.includes('application/notestack-docs')) {
        try {
          const data = JSON.parse(e.dataTransfer.getData('application/notestack-docs'));
          if (data && data.ids) {
             const docsToAttach = documents.filter(d => data.ids.includes(d.id));
             setAttachedFiles(prev => {
                const newDocs = docsToAttach.filter(d => !prev.some(p => p.id === d.id));
                return [...prev, ...newDocs];
             });
          }
        } catch (err) {
          console.error("Failed to parse dragged docs", err);
        }
      } else if (e.dataTransfer.types.includes('Files') && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        await processInputFiles(e.dataTransfer.files);
      } else if (e.dataTransfer.types.includes('text/plain')) {
        const text = e.dataTransfer.getData('text/plain');
        if (text) {
          setInput(prev => prev ? prev + '\n' + text : text);
        }
      }
    }
  };

  const removeAttachedFile = (id: string) => {
    setAttachedFiles((prev) => prev.filter((doc) => doc.id !== id));
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain')) {
      e.preventDefault();
      if (e.dataTransfer.types.includes('Files')) {
        setIsDragging(true);
      }
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      setIsDragging(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain')) {
      e.preventDefault();
      setIsDragging(false);

      if (e.dataTransfer.types.includes('Files') && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        setStagedFiles(Array.from(e.dataTransfer.files));
      } else if (e.dataTransfer.types.includes('text/plain')) {
        const text = e.dataTransfer.getData('text/plain');
        if (text) {
          setInput(prev => prev ? prev + '\n' + text : text);
        }
      }
    }
  };

  const removeDocumentNow = (id: string) => {
    setDocuments((prev) => prev.filter((doc) => doc.id !== id));
    setSelectedDocIds(prev => prev.filter(docId => docId !== id));
    localforage.removeItem(id).catch(console.error);
    api.deleteDocument(id).catch(console.error);
  };

  const removeDocument = (id: string) => {
    const documentName = documents.find((doc) => doc.id === id)?.name || 'this source';
    confirm({
      title: 'Delete Source?',
      message: `This will permanently delete ${documentName}. This action cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
      feature: 'sources',
      onConfirm: () => removeDocumentNow(id),
    });
  };

  const persistDocumentFolderAssignments = async (docIds: string[], folderId?: string) => {
    await Promise.all(
      docIds.map((docId) =>
        api.updateDocument(docId, { folder_id: folderId ?? null }).catch(() => null)
      )
    );
  };

  const toggleDocSelection = (id: string) => {
    setSelectedDocIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const createNewFolder = async () => {
    try {
      const newFolder = await api.createFolder('New Folder');
      const newFolderId = String(newFolder.id);
      setFolders(prev => [{
        id: newFolderId,
        name: newFolder.name,
        isExpanded: true,
        timestamp: parseDateValue(newFolder.created_at) ?? Date.now(),
      }, ...prev]);
      setEditingId(newFolderId);
      setEditingName(newFolder.name);
    } catch {
      showToast('Failed to create folder', 'error');
    }
  };

  const handleGroupSelectedSubmit = async (folderName: string) => {
    if (!folderName.trim()) return;
    try {
      const created = await api.createFolder(folderName.trim());
      const newFolderId = String(created.id);
      setFolders(prev => [...prev, {
        id: newFolderId,
        name: created.name,
        isExpanded: true,
        timestamp: parseDateValue(created.created_at) ?? Date.now(),
      }]);
      setDocuments(prev => prev.map(doc => selectedDocIds.includes(doc.id) ? { ...doc, folderId: newFolderId } : doc));
      void persistDocumentFolderAssignments(selectedDocIds, newFolderId);
    } catch {
      showToast('Failed to create folder group', 'error');
      return;
    }
    setSelectedDocIds([]);
    setIsGroupingFolder(false);
    setGroupFolderInput('');
  };

  const handleRenameStart = (id: string, currentName: string) => {
    setEditingId(id);
    setEditingName(currentName);
  };

  const handleRenameCommit = async () => {
    if (!editingId || !editingName.trim()) {
      setEditingId(null);
      return;
    }
    if (folders.some(f => f.id === editingId)) {
      setFolders(prev => prev.map(f => f.id === editingId ? { ...f, name: editingName.trim() } : f));
      api.updateFolder(editingId, editingName.trim()).catch(() => {
        showToast('Failed to rename folder', 'warning');
      });
    } else {
      setDocuments(prev => prev.map(d => d.id === editingId ? { ...d, name: editingName.trim() } : d));
      api.updateDocument(editingId, { name: editingName.trim() }).catch(() => {
        showToast('Failed to rename document', 'warning');
      });
    }
    setEditingId(null);
  };

  const handleDocDragStart = (e: React.DragEvent, doc: Document) => {
    const idsToDrag = selectedDocIds.includes(doc.id) ? selectedDocIds : [doc.id];
    e.dataTransfer.setData('application/notestack-docs', JSON.stringify({ ids: idsToDrag }));
    e.dataTransfer.effectAllowed = 'copy';

    // Create a generic drag image showing the number of items
    if (idsToDrag.length > 1) {
      const dragBadge = document.createElement('div');
      dragBadge.innerText = `${idsToDrag.length} documents`;
      dragBadge.style.backgroundColor = '#3b82f6';
      dragBadge.style.color = 'white';
      dragBadge.style.padding = '4px 8px';
      dragBadge.style.borderRadius = '4px';
      dragBadge.style.fontSize = '12px';
      dragBadge.style.position = 'absolute';
      dragBadge.style.top = '-1000px';
      document.body.appendChild(dragBadge);
      e.dataTransfer.setDragImage(dragBadge, 10, 10);
      setTimeout(() => document.body.removeChild(dragBadge), 0);
    }
  };

  const toggleFolder = (id: string) => {
    setFolders(prev => prev.map(f => f.id === id ? { ...f, isExpanded: !f.isExpanded } : f));
  };

  const removeFolderNow = (id: string) => {
    setFolders(prev => prev.filter(f => f.id !== id));
    setDocuments(prev => prev.map(d => d.folderId === id ? { ...d, folderId: undefined } : d));
    api.deleteFolder(id).catch(() => {
      showToast('Failed to delete folder', 'warning');
    });
  };

  const removeFolder = (id: string) => {
    const folderName = folders.find((folder) => folder.id === id)?.name || 'this folder';
    confirm({
      title: 'Delete Folder?',
      message: `This will permanently delete ${folderName}. Documents inside it will be moved to the root.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
      feature: 'folders',
      onConfirm: () => removeFolderNow(id),
    });
  };

  const removeFromFolder = (id: string) => {
    setDocuments(prev => prev.map(d => d.id === id ? { ...d, folderId: undefined } : d));
    api.updateDocument(id, { folder_id: null }).catch(() => {
      showToast('Failed to update document folder', 'warning');
    });
  };

  const handleSaveApiKey = async () => {
    if (apiProvider === 'local') {
      return;
    }

    const provider = apiProvider;
    const providerLabel = getCloudProviderLabel(provider);
    const key = getCloudApiKeyForProvider(provider);
    const baseUrl = getCloudBaseUrlForProvider(provider);

    if (!key) {
      const message = 'API key cannot be empty';
      setApiKeyError(message);
      setCloudValidationByProvider((prev) => ({
        ...prev,
        [provider]: {
          ...prev[provider],
          status: 'invalid',
          message,
        },
      }));
      return;
    }

    if (key.length < 20) {
      const message = 'Invalid API key format. Must be at least 20 characters.';
      setApiKeyError(message);
      setCloudValidationByProvider((prev) => ({
        ...prev,
        [provider]: {
          ...prev[provider],
          status: 'invalid',
          message,
        },
      }));
      return;
    }

    if (provider === 'openai_compatible' && !baseUrl) {
      const message = 'Base URL is required for OpenAI-compatible provider.';
      setApiKeyError(message);
      setCloudValidationByProvider((prev) => ({
        ...prev,
        [provider]: {
          ...prev[provider],
          status: 'invalid',
          message,
        },
      }));
      return;
    }

    setApiKeyError('');
    setIsCloudValidationBusy(true);
    setCloudValidationByProvider((prev) => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        status: 'checking',
        message: `Checking ${providerLabel} API key and model access...`,
      },
    }));

    try {
      const selectedModel = getCloudModelForProvider(provider).trim() || undefined;
      const result = await api.validateCloudProvider({
        provider,
        api_key: key,
        selected_model: selectedModel,
        base_url: provider === 'openai_compatible' ? baseUrl : undefined,
      });

      persistCloudApiKeyForProvider(provider, key);
      if (provider === 'openai_compatible') {
        writeStoredValue(SETTINGS_STORAGE_KEYS.openaiCompatibleBaseUrl, baseUrl);
        setOpenaiCompatibleBaseUrl(baseUrl);
      }
      applyCloudValidationResult(provider, result);

      if (result.fallback_applied && result.resolved_model) {
        showToast(
          `${providerLabel} key is valid. '${result.selected_model}' is not accessible, so '${result.resolved_model}' is now active.`,
          'warning'
        );
      } else {
        showToast(result.message || `${providerLabel} API key validated.`, 'info');
      }
    } catch (error: any) {
      if (isAuthError(error?.status, error?.message)) {
        handleSignOut();
        showToast('Session expired. Please sign in again.', 'warning');
        return;
      }

      const detail = (error?.message || `Failed to validate ${providerLabel} API key.`).trim();
      setApiKeyError(detail);
      setCloudValidationByProvider((prev) => ({
        ...prev,
        [provider]: {
          ...prev[provider],
          status: 'invalid',
          message: detail,
          fallbackApplied: false,
          selectedModelAccessible: false,
        },
      }));
      showToast(detail, 'error');
    } finally {
      setIsCloudValidationBusy(false);
    }
  };

  const handleCloudModelSelection = (nextModel: string) => {
    if (apiProvider === 'local') {
      return;
    }

    const provider = apiProvider;
    const providerLabel = getCloudProviderLabel(provider);
    const normalizedModel = nextModel.trim();
    if (!normalizedModel) {
      return;
    }

    persistCloudModelForProvider(provider, normalizedModel);
    setCloudValidationByProvider((prev) => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        status: 'valid',
        message: `${providerLabel} model set to '${normalizedModel}'.`,
        resolvedModel: normalizedModel,
        fallbackApplied: false,
        selectedModelAccessible: true,
      },
    }));
    showToast(`${providerLabel} model updated.`, 'info');
  };

  const getOrCreateChatSessionId = async (): Promise<string | null> => {
    if (activeChatSessionId) return activeChatSessionId;
    try {
      const createdSession = await api.createChatSession();
      const normalizedSession = toChatSession(createdSession);
      setChatSessions((prev) => sortChatSessionsByRecent([
        normalizedSession,
        ...prev.filter((session) => session.id !== normalizedSession.id),
      ]));
      setActiveChatSessionId(normalizedSession.id);
      setChatConfigForSession(normalizedSession.id, activeChatConfig);
      return normalizedSession.id;
    } catch {
      showToast('Could not initialize chat persistence', 'warning');
      return null;
    }
  };

  const handleSendMessage = async () => {
    if (!input.trim() && attachedFiles.length === 0) return;

    const userText = input.trim();
    setInput('');
    const currentAttachedFiles = [...attachedFiles];
    setAttachedFiles([]);

    const newUserMessage: Message = {
      id: Math.random().toString(36).substring(7),
      role: 'user',
      text: userText,
      attachedFiles: currentAttachedFiles.length > 0 ? currentAttachedFiles : undefined,
    };

    setMessages((prev) => [...prev, newUserMessage]);
    cancelActiveChatStream();

    const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestController = new AbortController();
    let requestSessionId: string | null = activeChatSessionId;

    activeChatStreamControllerRef.current = requestController;
    activeChatRequestRef.current = { requestId, sessionId: requestSessionId };

    const isActiveRequest = (sessionId: string | null = requestSessionId) => {
      if (requestController.signal.aborted) return false;
      return isChatRequestActive(requestId, sessionId);
    };

    setIsLoading(true);

    try {
      const sessionId = await getOrCreateChatSessionId();
      if (sessionId) {
        requestSessionId = sessionId;
        if (isChatRequestActive(requestId)) {
          activeChatRequestRef.current = { requestId, sessionId: requestSessionId };
        }

        api.createChatMessage(sessionId, {
          id: newUserMessage.id,
          role: 'user',
          text: newUserMessage.text,
          attached_files: currentAttachedFiles,
        }).then(() => {
          setChatSessions((prev) => sortChatSessionsByRecent(
            prev.map((session) => {
              if (session.id !== sessionId) return session;
              return {
                ...session,
                title: session.title === 'New chat' && newUserMessage.text.trim()
                  ? newUserMessage.text.trim().slice(0, 80)
                  : session.title,
                updatedAt: Date.now(),
              };
            })
          ));
        }).catch(() => {
          showToast('Could not persist user message', 'warning');
        });
      }

      if (!isActiveRequest()) {
        return;
      }

      const modelMessageId = Math.random().toString(36).substring(7);
      setMessages(prev => [...prev, { id: modelMessageId, role: 'model', text: "" }]);

      // Build message history for backend
      const historyMessages = [...messages, newUserMessage];
      const chatMessages = historyMessages
        .filter(m => m.text && m.text.trim().length > 0)
        .map(m => ({ role: m.role, text: m.text }));

      // Determine which API key to send based on provider
      let apiKeyForProvider: string | undefined;
      if (apiProvider === 'gemini') apiKeyForProvider = activeApiKey || undefined;
      else if (apiProvider === 'openai') apiKeyForProvider = openaiApiKey || undefined;
      else if (apiProvider === 'openai_compatible') apiKeyForProvider = openaiCompatibleApiKey || undefined;
      else if (apiProvider === 'openrouter') apiKeyForProvider = openrouterApiKey || undefined;
      else if (apiProvider === 'anthropic') apiKeyForProvider = anthropicApiKey || undefined;
      else if (apiProvider === 'cerebras') apiKeyForProvider = cerebrasApiKey || undefined;
      const cloudModelForProvider = apiProvider === 'local' ? undefined : (getCloudModelForProvider(apiProvider).trim() || undefined);
      const normalizedOpenaiCompatibleBaseUrl = openaiCompatibleBaseUrl.trim();

      if (apiProvider !== 'local' && !apiKeyForProvider) {
        showToast('Please configure and validate an API key in Settings first.', 'error');
        return;
      }

      if (apiProvider === 'openai_compatible' && !normalizedOpenaiCompatibleBaseUrl) {
        showToast('Please configure an OpenAI-compatible base URL in Settings first.', 'error');
        return;
      }

      let normalizedLocalModelUrl = localModelUrl.trim();
      let normalizedLocalModelName = localModelName.trim();
      if (apiProvider === 'local' && (!normalizedLocalModelUrl || !normalizedLocalModelName)) {
        const resolvedLocalRuntime = await ensureLocalRuntimeReady('chat');
        if (!resolvedLocalRuntime) {
          return;
        }
        normalizedLocalModelUrl = resolvedLocalRuntime.url;
        normalizedLocalModelName = resolvedLocalRuntime.model;
      }

      const searchableDocumentIds = new Set(documents.map((doc) => doc.id));
      const attachedDocumentIds = currentAttachedFiles
        .map((doc) => doc.id)
        .filter((docId) => searchableDocumentIds.has(docId));
      const requestDocumentIds = Array.from(new Set([...selectedDocIds, ...attachedDocumentIds]));

      if (currentAttachedFiles.length > 0 && attachedDocumentIds.length === 0) {
        showToast('Attached files are still indexing and may not be available for retrieval yet.', 'warning');
      }

      const adaptiveSystemInstructions = `${systemInstructions}${buildFeedbackGuidance()}${buildChatConfigurationGuidance()}`;

      const response = await api.streamChat({
        messages: chatMessages,
        document_ids: requestDocumentIds,
        api_provider: apiProvider,
        api_key: apiKeyForProvider,
        cloud_model: cloudModelForProvider,
        cloud_base_url: apiProvider === 'openai_compatible' ? normalizedOpenaiCompatibleBaseUrl : undefined,
        local_model_url: apiProvider === 'local' ? normalizedLocalModelUrl : undefined,
        local_model_name: apiProvider === 'local' ? normalizedLocalModelName : undefined,
        system_instructions: adaptiveSystemInstructions,
      }, { signal: requestController.signal });

      if (!response.ok) {
        const errText = await response.text();
        const detail = parseBackendErrorDetail(errText) || 'Chat request failed';
        if (isAuthError(response.status, detail)) {
          handleSignOut();
          showToast('Session expired. Please sign in again.', 'warning');
          return;
        }
        throw new Error(detail);
      }

      // Read SSE stream
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let streamedCitations: CitationItem[] = [];
      let citationStreamState: CitationStreamState = { items: [] };
      let streamErrorMessage = '';
      let sseBuffer = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!isActiveRequest()) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancellation errors.
          }
          break;
        }
        sseBuffer += decoder.decode(value, { stream: true });
        const extracted = extractSseDataEvents(sseBuffer);
        sseBuffer = extracted.remainder;

        for (const data of extracted.events) {
          if (data === '[DONE]') break;
          const explicitStreamError = parseStreamErrorPayload(data);
          if (explicitStreamError) {
            streamErrorMessage = explicitStreamError;
            continue;
          }
          const citationEvent = parseCitationPayload(data);
          if (citationEvent) {
            citationStreamState = applyCitationStreamEvent(citationStreamState, citationEvent);
            streamedCitations = citationStreamState.items;
            if (citationEvent.error && citationEvent.error.trim()) {
              streamErrorMessage = citationEvent.error.trim();
            }

            if (!isActiveRequest()) {
              continue;
            }

            setMessages(prev => prev.map((message) => (
              message.id === modelMessageId
                ? {
                    ...message,
                    citations: streamedCitations.length > 0 ? streamedCitations : undefined,
                    citationStatus: citationStreamState.status,
                    citationStatusReason: citationStreamState.status === 'partial' ? citationStreamState.reason : undefined,
                  }
                : message
            )));
            continue;
          }
          fullText += data;
          if (!isActiveRequest()) {
            continue;
          }
          setMessages(prev => prev.map(m => m.id === modelMessageId ? { ...m, text: fullText } : m));
        }
      }

      const tailEvents = extractSseDataEvents(`${sseBuffer}\n\n`).events;
      for (const tailData of tailEvents) {
        if (tailData === '[DONE]') {
          continue;
        }
        const explicitStreamError = parseStreamErrorPayload(tailData);
        if (explicitStreamError) {
          streamErrorMessage = explicitStreamError;
        } else {
          const citationEvent = parseCitationPayload(tailData);
          if (citationEvent) {
          citationStreamState = applyCitationStreamEvent(citationStreamState, citationEvent);
          streamedCitations = citationStreamState.items;
            if (citationEvent.error && citationEvent.error.trim()) {
              streamErrorMessage = citationEvent.error.trim();
            }

          if (!isActiveRequest()) {
            return;
          }

          setMessages(prev => prev.map((message) => (
            message.id === modelMessageId
              ? {
                  ...message,
                  citations: streamedCitations.length > 0 ? streamedCitations : undefined,
                  citationStatus: citationStreamState.status,
                  citationStatusReason: citationStreamState.status === 'partial' ? citationStreamState.reason : undefined,
                }
              : message
          )));
          } else if (tailData !== '[DONE]') {
            fullText += tailData;
              if (!isActiveRequest()) {
                return;
              }
            setMessages(prev => prev.map(m => m.id === modelMessageId ? { ...m, text: fullText } : m));
          }
        }
      }

      if (!fullText.trim() && streamErrorMessage && isActiveRequest()) {
        const displayStreamError = getDisplayStreamErrorMessage(streamErrorMessage);
        if (isBillingOrQuotaError(streamErrorMessage)) {
          setMessages(prev => prev.filter((message) => message.id !== modelMessageId));
        } else {
          const renderedErrorText = `Error: ${displayStreamError || streamErrorMessage}`;
          fullText = renderedErrorText;
          setMessages(prev => prev.map(m => m.id === modelMessageId ? { ...m, text: renderedErrorText } : m));
        }
      }

        if ((streamedCitations.length > 0 || citationStreamState.status) && isActiveRequest()) {
        setMessages(prev => prev.map((message) => (
          message.id === modelMessageId
            ? {
                ...message,
                citations: streamedCitations.length > 0 ? streamedCitations : undefined,
                citationStatus: citationStreamState.status,
                citationStatusReason: citationStreamState.status === 'partial' ? citationStreamState.reason : undefined,
              }
            : message
        )));
      }

      const persistenceCitations = streamedCitations.length > 0
        ? normalizeCitationItems(streamedCitations)
        : undefined;

      if (sessionId && fullText.trim() && isActiveRequest()) {
        try {
          await api.createChatMessage(sessionId, {
            id: modelMessageId,
            role: 'model',
            text: fullText,
            citations: persistenceCitations,
          });
        } catch (persistError: any) {
          if (isAuthError(persistError?.status, persistError?.message)) {
            handleSignOut();
            showToast('Session expired. Please sign in again.', 'warning');
            return;
          }

          const shouldRetryWithoutCitations = Boolean(persistenceCitations?.length)
            && isCitationPersistenceValidationError(persistError?.status, persistError?.message);

          if (shouldRetryWithoutCitations) {
            console.warn('Model response citation payload failed validation; retrying persistence without citations.', {
              status: persistError?.status,
              message: persistError?.message,
            });

            try {
              await api.createChatMessage(sessionId, {
                id: modelMessageId,
                role: 'model',
                text: fullText,
              });
            } catch (retryError: any) {
              if (isAuthError(retryError?.status, retryError?.message)) {
                handleSignOut();
                showToast('Session expired. Please sign in again.', 'warning');
                return;
              }

              const retryDetail = typeof retryError?.message === 'string'
                ? retryError.message.trim()
                : '';
              console.error('Model response persistence failed after citation fallback retry.', retryError);
              showToast(
                retryDetail ? `Could not persist model response: ${retryDetail}` : 'Could not persist model response',
                'warning',
              );
            }
          } else {
            const persistDetail = typeof persistError?.message === 'string'
              ? persistError.message.trim()
              : '';
            console.error('Model response persistence failed.', persistError);
            showToast(
              persistDetail ? `Could not persist model response: ${persistDetail}` : 'Could not persist model response',
              'warning',
            );
          }
        }
      }

      if (citationStreamState.status === 'partial' && isActiveRequest()) {
        if (streamErrorMessage) {
          const displayStreamError = getDisplayStreamErrorMessage(streamErrorMessage) || streamErrorMessage;
          const streamErrorToastType = isBillingOrQuotaError(streamErrorMessage)
            ? 'warning'
            : (fullText.trim() ? 'warning' : 'error');
          showToast(displayStreamError, streamErrorToastType);
        } else {
          showToast('The response stream ended early. Some citation details may be partial.', 'warning');
        }
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return;
      }
      console.error(error);
      if (isAuthError(error?.status, error?.message)) {
        handleSignOut();
        showToast('Session expired. Please sign in again.', 'warning');
        return;
      }
      showToast("Error: " + error.message, 'error');
    } finally {
      if (isChatRequestActive(requestId)) {
        activeChatRequestRef.current = null;
        activeChatStreamControllerRef.current = null;
        setIsLoading(false);
      } else if (activeChatStreamControllerRef.current === requestController) {
        activeChatStreamControllerRef.current = null;
      }
    }
  };

  const handleOpenResponseActionMenu = (event: React.MouseEvent<HTMLButtonElement>, messageId: string) => {
    const rect = event.currentTarget.getBoundingClientRect();

    const menuWidth = 320;
    const minViewportMargin = 12;
    const estimatedMenuHeight = 360;
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 720;
    const preferredLeft = rect.right - menuWidth;
    const maxLeft = Math.max(minViewportMargin, viewportWidth - menuWidth - minViewportMargin);
    const clampedLeft = Math.min(Math.max(preferredLeft, minViewportMargin), maxLeft);
    const preferredTop = rect.bottom + 6;
    const maxTop = Math.max(minViewportMargin, viewportHeight - estimatedMenuHeight);
    const clampedTop = Math.min(Math.max(preferredTop, minViewportMargin), maxTop);

    setResponseMenuOptions((prev) => {
      if (prev?.messageId === messageId) {
        setIsResponseModelDropdownOpen(false);
        return null;
      }

      const selectedModel = getActiveSelectedModel();
      setResponseMenuSelectedModel(selectedModel);
      setIsResponseModelDropdownOpen(false);

      return {
        messageId,
        x: clampedLeft,
        y: clampedTop,
      };
    });
  };

  const handleRegenerateModelMessage = async (
    targetMessageId: string,
    mode: RegenerateMode = 'try_again',
    temporaryModelOverride?: string,
  ) => {
    if (isLoading) {
      showToast('Please wait for the current response to finish first.', 'warning');
      return;
    }

    const targetIndex = messages.findIndex((message) => message.id === targetMessageId);
    if (targetIndex < 0) {
      showToast('Response not found.', 'warning');
      return;
    }

    const targetMessage = messages[targetIndex];
    if (targetMessage.role !== 'model') {
      return;
    }

    if (!canRegenerateModelMessage(targetMessageId)) {
      showToast('Only the latest response can be regenerated.', 'warning');
      return;
    }

    let sourceUserIndex = -1;
    for (let index = targetIndex - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') {
        sourceUserIndex = index;
        break;
      }
    }

    if (sourceUserIndex < 0) {
      showToast('Could not locate the prompt for this response.', 'warning');
      return;
    }

    const sourceUserMessage = messages[sourceUserIndex];
    const sourceHasText = (sourceUserMessage.text || '').trim().length > 0;
    const sourceHasAttachments = Array.isArray(sourceUserMessage.attachedFiles) && sourceUserMessage.attachedFiles.length > 0;
    if (!sourceHasText && !sourceHasAttachments) {
      showToast('Cannot regenerate from an empty prompt.', 'warning');
      return;
    }

    closeResponseActionMenu();
    cancelActiveChatStream();
    setRegeneratingMessageId(targetMessageId);

    const previousMessageSnapshot = {
      text: targetMessage.text,
      citations: targetMessage.citations,
      citationStatus: targetMessage.citationStatus,
      citationStatusReason: targetMessage.citationStatusReason,
    };

    const restorePreviousMessage = () => {
      setMessages((prev) => prev.map((message) => (
        message.id === targetMessageId
          ? {
              ...message,
              text: previousMessageSnapshot.text,
              citations: previousMessageSnapshot.citations,
              citationStatus: previousMessageSnapshot.citationStatus,
              citationStatusReason: previousMessageSnapshot.citationStatusReason,
            }
          : message
      )));
    };

    setMessages((prev) => prev.map((message) => (
      message.id === targetMessageId
        ? {
            ...message,
            text: '',
            citations: undefined,
            citationStatus: undefined,
            citationStatusReason: undefined,
          }
        : message
    )));

    const requestId = `regen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestController = new AbortController();
    let requestSessionId: string | null = activeChatSessionId;
    let hasVisibleOutput = false;

    activeChatStreamControllerRef.current = requestController;
    activeChatRequestRef.current = { requestId, sessionId: requestSessionId };

    const isActiveRequest = (sessionId: string | null = requestSessionId) => {
      if (requestController.signal.aborted) return false;
      return isChatRequestActive(requestId, sessionId);
    };

    setIsLoading(true);

    try {
      // Keep all history up to and including the source user prompt.
      const historyMessages = messages.slice(0, sourceUserIndex + 1);
      const chatMessages = historyMessages
        .filter((message) => message.text && message.text.trim().length > 0)
        .map((message) => ({ role: message.role, text: message.text }));

      let apiKeyForProvider: string | undefined;
      if (apiProvider === 'gemini') apiKeyForProvider = activeApiKey || undefined;
      else if (apiProvider === 'openai') apiKeyForProvider = openaiApiKey || undefined;
      else if (apiProvider === 'openai_compatible') apiKeyForProvider = openaiCompatibleApiKey || undefined;
      else if (apiProvider === 'openrouter') apiKeyForProvider = openrouterApiKey || undefined;
      else if (apiProvider === 'anthropic') apiKeyForProvider = anthropicApiKey || undefined;
      else if (apiProvider === 'cerebras') apiKeyForProvider = cerebrasApiKey || undefined;

      const normalizedModelOverride = (temporaryModelOverride || '').trim();
      const cloudModelForProvider = apiProvider === 'local'
        ? undefined
        : ((normalizedModelOverride || getCloudModelForProvider(apiProvider).trim()) || undefined);
      const normalizedOpenaiCompatibleBaseUrl = openaiCompatibleBaseUrl.trim();

      if (apiProvider !== 'local' && !apiKeyForProvider) {
        showToast('Please configure and validate an API key in Settings first.', 'error');
        restorePreviousMessage();
        return;
      }

      if (apiProvider === 'openai_compatible' && !normalizedOpenaiCompatibleBaseUrl) {
        showToast('Please configure an OpenAI-compatible base URL in Settings first.', 'error');
        restorePreviousMessage();
        return;
      }

      let normalizedLocalModelUrl = localModelUrl.trim();
      let normalizedLocalModelName = (normalizedModelOverride || localModelName).trim();
      if (apiProvider === 'local' && (!normalizedLocalModelUrl || !normalizedLocalModelName)) {
        const resolvedLocalRuntime = await ensureLocalRuntimeReady('chat');
        if (!resolvedLocalRuntime) {
          restorePreviousMessage();
          return;
        }
        normalizedLocalModelUrl = resolvedLocalRuntime.url;
        normalizedLocalModelName = resolvedLocalRuntime.model;
      }

      const sourceAttachedFiles = sourceUserMessage.attachedFiles || [];
      const searchableDocumentIds = new Set(documents.map((doc) => doc.id));
      const attachedDocumentIds = sourceAttachedFiles
        .map((doc) => doc.id)
        .filter((docId) => searchableDocumentIds.has(docId));
      const requestDocumentIds = Array.from(new Set([...selectedDocIds, ...attachedDocumentIds]));

      if (sourceAttachedFiles.length > 0 && attachedDocumentIds.length === 0) {
        showToast('Attached files for this prompt are still indexing and may not be available yet.', 'warning');
      }

      const regenerationDirective = mode === 'think_longer'
        ? '\n\nRegeneration mode: think longer before replying and provide a deeper, more comprehensive answer.'
        : '\n\nRegeneration mode: try again and provide an alternative high-quality response.';

      const adaptiveSystemInstructions = `${systemInstructions}${buildFeedbackGuidance()}${buildChatConfigurationGuidance()}${regenerationDirective}`;

      const response = await api.streamChat({
        messages: chatMessages,
        document_ids: requestDocumentIds,
        api_provider: apiProvider,
        api_key: apiKeyForProvider,
        cloud_model: cloudModelForProvider,
        cloud_base_url: apiProvider === 'openai_compatible' ? normalizedOpenaiCompatibleBaseUrl : undefined,
        local_model_url: apiProvider === 'local' ? normalizedLocalModelUrl : undefined,
        local_model_name: apiProvider === 'local' ? normalizedLocalModelName : undefined,
        system_instructions: adaptiveSystemInstructions,
      }, { signal: requestController.signal });

      if (!response.ok) {
        const errText = await response.text();
        const detail = parseBackendErrorDetail(errText) || 'Chat request failed';
        if (isAuthError(response.status, detail)) {
          handleSignOut();
          showToast('Session expired. Please sign in again.', 'warning');
          restorePreviousMessage();
          return;
        }
        throw new Error(detail);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let streamedCitations: CitationItem[] = [];
      let citationStreamState: CitationStreamState = { items: [] };
      let streamErrorMessage = '';
      let sseBuffer = '';

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!isActiveRequest()) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancellation errors.
          }
          break;
        }

        sseBuffer += decoder.decode(value, { stream: true });
        const extracted = extractSseDataEvents(sseBuffer);
        sseBuffer = extracted.remainder;

        for (const data of extracted.events) {
          if (data === '[DONE]') break;

          const explicitStreamError = parseStreamErrorPayload(data);
          if (explicitStreamError) {
            streamErrorMessage = explicitStreamError;
            continue;
          }

          const citationEvent = parseCitationPayload(data);
          if (citationEvent) {
            citationStreamState = applyCitationStreamEvent(citationStreamState, citationEvent);
            streamedCitations = citationStreamState.items;
            if (citationEvent.error && citationEvent.error.trim()) {
              streamErrorMessage = citationEvent.error.trim();
            }

            if (!isActiveRequest()) {
              continue;
            }

            setMessages((prev) => prev.map((message) => (
              message.id === targetMessageId
                ? {
                    ...message,
                    citations: streamedCitations.length > 0 ? streamedCitations : undefined,
                    citationStatus: citationStreamState.status,
                    citationStatusReason: citationStreamState.status === 'partial' ? citationStreamState.reason : undefined,
                  }
                : message
            )));
            continue;
          }

          fullText += data;
          if (fullText.trim().length > 0) {
            hasVisibleOutput = true;
          }

          if (!isActiveRequest()) {
            continue;
          }

          setMessages((prev) => prev.map((message) => (
            message.id === targetMessageId
              ? { ...message, text: fullText }
              : message
          )));
        }
      }

      const tailEvents = extractSseDataEvents(`${sseBuffer}\n\n`).events;
      for (const tailData of tailEvents) {
        if (tailData === '[DONE]') {
          continue;
        }

        const explicitStreamError = parseStreamErrorPayload(tailData);
        if (explicitStreamError) {
          streamErrorMessage = explicitStreamError;
          continue;
        }

        const citationEvent = parseCitationPayload(tailData);
        if (citationEvent) {
          citationStreamState = applyCitationStreamEvent(citationStreamState, citationEvent);
          streamedCitations = citationStreamState.items;
          if (citationEvent.error && citationEvent.error.trim()) {
            streamErrorMessage = citationEvent.error.trim();
          }

          if (!isActiveRequest()) {
            continue;
          }

          setMessages((prev) => prev.map((message) => (
            message.id === targetMessageId
              ? {
                  ...message,
                  citations: streamedCitations.length > 0 ? streamedCitations : undefined,
                  citationStatus: citationStreamState.status,
                  citationStatusReason: citationStreamState.status === 'partial' ? citationStreamState.reason : undefined,
                }
              : message
          )));
          continue;
        }

        fullText += tailData;
        if (fullText.trim().length > 0) {
          hasVisibleOutput = true;
        }

        if (!isActiveRequest()) {
          continue;
        }

        setMessages((prev) => prev.map((message) => (
          message.id === targetMessageId
            ? { ...message, text: fullText }
            : message
        )));
      }

      if (!fullText.trim() && streamErrorMessage && isActiveRequest()) {
        const displayStreamError = getDisplayStreamErrorMessage(streamErrorMessage);
        if (isBillingOrQuotaError(streamErrorMessage)) {
          restorePreviousMessage();
          showToast(displayStreamError || streamErrorMessage, 'warning');
          return;
        }

        const renderedErrorText = `Error: ${displayStreamError || streamErrorMessage}`;
        fullText = renderedErrorText;
        hasVisibleOutput = true;
        setMessages((prev) => prev.map((message) => (
          message.id === targetMessageId
            ? { ...message, text: renderedErrorText }
            : message
        )));
      }

      if ((streamedCitations.length > 0 || citationStreamState.status) && isActiveRequest()) {
        setMessages((prev) => prev.map((message) => (
          message.id === targetMessageId
            ? {
                ...message,
                citations: streamedCitations.length > 0 ? streamedCitations : undefined,
                citationStatus: citationStreamState.status,
                citationStatusReason: citationStreamState.status === 'partial' ? citationStreamState.reason : undefined,
              }
            : message
        )));
      }

      if (!fullText.trim() && isActiveRequest()) {
        restorePreviousMessage();
        showToast('Model returned no visible text during regeneration.', 'warning');
        return;
      }

      if (citationStreamState.status === 'partial' && isActiveRequest()) {
        if (streamErrorMessage) {
          const displayStreamError = getDisplayStreamErrorMessage(streamErrorMessage) || streamErrorMessage;
          const streamErrorToastType = isBillingOrQuotaError(streamErrorMessage)
            ? 'warning'
            : (fullText.trim() ? 'warning' : 'error');
          showToast(displayStreamError, streamErrorToastType);
        } else {
          showToast('The response stream ended early. Some citation details may be partial.', 'warning');
        }
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        if (!hasVisibleOutput) {
          restorePreviousMessage();
        }
        return;
      }

      if (!hasVisibleOutput) {
        restorePreviousMessage();
      }

      console.error(error);
      if (isAuthError(error?.status, error?.message)) {
        handleSignOut();
        showToast('Session expired. Please sign in again.', 'warning');
        return;
      }
      showToast('Error: ' + error.message, 'error');
    } finally {
      if (isChatRequestActive(requestId)) {
        activeChatRequestRef.current = null;
        activeChatStreamControllerRef.current = null;
        setIsLoading(false);
      } else if (activeChatStreamControllerRef.current === requestController) {
        activeChatStreamControllerRef.current = null;
      }
      setRegeneratingMessageId(null);
    }
  };

  const handleCopyMessageText = async (text: string) => {
    const value = (text || '').trim();
    if (!value) {
      showToast('Nothing to copy', 'warning');
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied to clipboard', 'info');
    } catch {
      showToast('Could not copy text', 'warning');
    }
  };

  const handleStartComposerEdit = (message: Message) => {
    const hasText = (message.text || '').trim().length > 0;
    const hasAttachments = Array.isArray(message.attachedFiles) && message.attachedFiles.length > 0;
    if (!hasText && !hasAttachments) {
      showToast('Nothing to edit', 'warning');
      return;
    }

    setComposerDraftBeforeEdit((prev) => prev ?? { input, attachedFiles: [...attachedFiles] });
    setEditingMessageId(message.id);
    setInput(message.text || '');
    setAttachedFiles(message.role === 'user' ? [...(message.attachedFiles || [])] : []);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      const length = inputRef.current?.value.length ?? (message.text || '').length;
      inputRef.current?.setSelectionRange(length, length);
    });
  };

  const handleCancelComposerEdit = () => {
    if (composerDraftBeforeEdit) {
      setInput(composerDraftBeforeEdit.input);
      setAttachedFiles(composerDraftBeforeEdit.attachedFiles);
    } else {
      setInput('');
      setAttachedFiles([]);
    }
    setEditingMessageId(null);
    setComposerDraftBeforeEdit(null);
  };

  const handleSubmitComposerEdit = () => {
    if (!editingMessageId) {
      return;
    }

    const nextText = input.trim();
    if (!nextText && attachedFiles.length === 0) {
      showToast('Message cannot be empty', 'warning');
      return;
    }

    const target = messages.find((message) => message.id === editingMessageId);
    if (!target) {
      showToast('Message not found', 'warning');
      setEditingMessageId(null);
      setComposerDraftBeforeEdit(null);
      return;
    }

    setMessages((prev) =>
      prev.map((message) =>
        message.id === editingMessageId
          ? {
              ...message,
              text: nextText,
              attachedFiles:
                message.role === 'user'
                  ? (attachedFiles.length > 0 ? attachedFiles : undefined)
                  : message.attachedFiles,
            }
          : message
      )
    );

    showToast('Message updated', 'info');
    setEditingMessageId(null);
    setComposerDraftBeforeEdit(null);
    setInput('');
    if (target.role === 'user') {
      setAttachedFiles([]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (editingMessageId) {
        handleSubmitComposerEdit();
      } else {
        handleSendMessage();
      }
      return;
    }

    if (e.key === 'Escape') {
      if (editingMessageId) {
        e.preventDefault();
        handleCancelComposerEdit();
      }
    }
  };

  const addNote = (content: string) => {
    const firstLine = content ? content.split('\n')[0].trim() : '';
    const title = firstLine ? (firstLine.length > 30 ? firstLine.substring(0, 30) + '...' : firstLine) : 'New Note';

    const newNote: Note = {
      id: Math.random().toString(36).substring(7),
      title,
      content,
      timestamp: Date.now(),
    };
    setNotes((prev) => [newNote, ...prev]);
    api.upsertNote(newNote).catch(() => {
      showToast('Could not persist note', 'warning');
    });
    setIsNotesOpen(true);
    setRightPanelTab('notes');
    setSelectedNoteId(newNote.id);
  };

  const removeNoteNow = (id: string) => {
    setNotes((prev) => prev.filter((note) => note.id !== id));
    api.deleteNote(id).catch(() => {
      showToast('Could not delete note on server', 'warning');
    });
    if (selectedNoteId === id) setSelectedNoteId(null);
  };

  const removeNote = (id: string) => {
    const noteTitle = notes.find((note) => note.id === id)?.title || 'this note';
    confirm({
      title: 'Delete Note?',
      message: `This will permanently delete ${noteTitle}. This action cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
      feature: 'notes',
      onConfirm: () => removeNoteNow(id),
    });
  };

  const updateNote = (id: string, newTitle: string, newContent: string) => {
    const timestamp = Date.now();
    setNotes((prev) => prev.map((note) => note.id === id ? { ...note, title: newTitle, content: newContent, timestamp } : note));
    api.upsertNote({ id, title: newTitle, content: newContent, timestamp }).catch(() => {
      showToast('Could not sync note changes', 'warning');
    });
  };

  const convertNoteToSource = (note: Note) => {
    const base64 = btoa(unescape(encodeURIComponent(note.content)));
    const newDoc: Document = {
      id: Math.random().toString(36).substring(7),
      name: (note.title || 'Note') + '.txt',
      mimeType: 'text/plain',
      base64: base64,
      size: base64.length,
      timestamp: Date.now()
    };
    setDocuments(prev => [...prev, newDoc]);
    setSelectedDocIds(prev => [...prev, newDoc.id]);
    setSelectedNoteId(null);
  };

  const testLocalConnection = async (
    options?: { silent?: boolean; resetLogs?: boolean },
  ): Promise<{ endpoint: string; model: string; endpointType: LocalEndpointType | null } | null> => {
    const timestamp = () => new Date().toLocaleTimeString();
    const normalizedLocalModelUrl = localModelUrl.trim();
    const normalizedLocalModelName = localModelName.trim();
    const silent = options?.silent ?? false;
    const resetLogs = options?.resetLogs ?? true;

    const startLogs = [
      `[${timestamp()}] Starting local runtime discovery...`,
      `[${timestamp()}] Probing Ollama and LM Studio via backend relay...`,
    ];

    setIsLocalDiscoveryBusy(true);
    if (resetLogs) {
      setLocalConnectionLogs(startLogs);
    } else {
      setLocalConnectionLogs(prev => [...prev, ...startLogs]);
    }

    try {
      const discovery = await api.discoverLocalLLM(normalizedLocalModelUrl || undefined);
      const resolvedLocalModelUrl = (discovery.endpoint || normalizedLocalModelUrl).trim();
      const availableModels = Array.isArray(discovery.available_models)
        ? discovery.available_models.map((model) => String(model || '').trim()).filter(Boolean)
        : [];
      const selectedModel = (normalizedLocalModelName || discovery.detected_model || availableModels[0] || '').trim();
      const endpointType = discovery.endpoint_type || null;
      const runtimeLabel = getLocalEndpointTypeLabel(endpointType);

      if (resolvedLocalModelUrl) {
        setLocalModelUrl(resolvedLocalModelUrl);
        writeStoredValue(SETTINGS_STORAGE_KEYS.localModelUrl, resolvedLocalModelUrl);
      }

      if (selectedModel) {
        setLocalModelName(selectedModel);
        writeStoredValue(SETTINGS_STORAGE_KEYS.localModelName, selectedModel);
      }

      setLocalEndpointType(endpointType);
      setLocalDiscoveredModels(availableModels);
      setLocalDockerHint((discovery.docker_hint || '').trim());
      setLocalLastCheckedAt(Date.now());

      const preview = availableModels.slice(0, 6).join(', ');
      const extraModelCount = availableModels.length > 6 ? ` (+${availableModels.length - 6} more)` : '';

      setLocalConnectionLogs(prev => [
        ...prev,
        `[${timestamp()}] Success! Detected ${runtimeLabel}.`,
        `[${timestamp()}] Endpoint: ${resolvedLocalModelUrl || 'N/A'}`,
        `[${timestamp()}] Probe URL: ${discovery.probe_url || 'N/A'}`,
        selectedModel
          ? `[${timestamp()}] Selected Model: ${selectedModel}`
          : `[${timestamp()}] Runtime reachable, but no model was auto-selected.`,
        availableModels.length > 0
          ? `[${timestamp()}] Available Models: ${preview}${extraModelCount}`
          : `[${timestamp()}] Runtime responded, but no models were returned.`,
        ...(discovery.docker_hint ? [`[${timestamp()}] Docker Hint: ${discovery.docker_hint}`] : []),
      ]);

      if (!silent) {
        showToast('Local runtime discovered successfully.', 'info');
      }

      return {
        endpoint: resolvedLocalModelUrl,
        model: selectedModel,
        endpointType,
      };
    } catch (err: any) {
      setLocalEndpointType(null);
      setLocalDiscoveredModels([]);
      setLocalDockerHint('');
      setLocalLastCheckedAt(Date.now());

      setLocalConnectionLogs(prev => [
        ...prev,
        `[${timestamp()}] Error: ${err.message}`,
        `[${timestamp()}] Tip: Start Ollama on port 11434 or LM Studio/OpenAI-compatible runtime on port 1234.`,
        `[${timestamp()}] Tip: If backend is in Docker, host.docker.internal is usually the correct host.`,
      ]);

      if (!silent) {
        showToast('Local runtime discovery failed.', 'error');
      }

      return null;
    } finally {
      setIsLocalDiscoveryBusy(false);
    }
  };

  const ensureLocalRuntimeReady = async (intent: 'chat' | 'summary') => {
    let normalizedLocalModelUrl = localModelUrl.trim();
    let normalizedLocalModelName = localModelName.trim();

    if (normalizedLocalModelUrl && normalizedLocalModelName) {
      return { url: normalizedLocalModelUrl, model: normalizedLocalModelName };
    }

    const discoveryResult = await testLocalConnection({ silent: true, resetLogs: false });
    normalizedLocalModelUrl = (discoveryResult?.endpoint || localModelUrl.trim()).trim();
    normalizedLocalModelName = (discoveryResult?.model || localModelName.trim()).trim();

    if (!normalizedLocalModelUrl || !normalizedLocalModelName) {
      const actionText = intent === 'summary' ? 'summarize documents' : 'send a message';
      showToast(`Could not auto-connect a local runtime. Open Settings > API to auto-detect before trying to ${actionText}.`, 'error');
      return null;
    }

    const runtimeLabel = discoveryResult?.endpointType
      ? getLocalEndpointTypeLabel(discoveryResult.endpointType)
      : 'local runtime';
    showToast(`Auto-connected to ${runtimeLabel}.`, 'info');

    return { url: normalizedLocalModelUrl, model: normalizedLocalModelName };
  };

  useEffect(() => {
    if (!isSettingsOpen || activeSettingsTab !== 'api' || apiProvider !== 'local') {
      localAutoDiscoveryAttemptedRef.current = false;
      return;
    }

    if (isLocalDiscoveryBusy || localAutoDiscoveryAttemptedRef.current) {
      return;
    }

    localAutoDiscoveryAttemptedRef.current = true;
    void testLocalConnection({ silent: true, resetLogs: false });
  }, [isSettingsOpen, activeSettingsTab, apiProvider, isLocalDiscoveryBusy]);

  const handleSummarize = async () => {
    const activeDocs = selectedDocIds.length > 0 ? documents.filter(d => selectedDocIds.includes(d.id)) : documents;
    if (activeDocs.length === 0) {
      showToast("Please add or select some sources first.", 'warning');
      return;
    }
    let normalizedLocalModelUrl = localModelUrl.trim();
    let normalizedLocalModelName = localModelName.trim();
    if (apiProvider === 'local' && (!normalizedLocalModelUrl || !normalizedLocalModelName)) {
      const resolvedLocalRuntime = await ensureLocalRuntimeReady('summary');
      if (!resolvedLocalRuntime) {
        return;
      }
      normalizedLocalModelUrl = resolvedLocalRuntime.url;
      normalizedLocalModelName = resolvedLocalRuntime.model;
    }

    let finalSummaryText = '';
    summaryViewerOpenRef.current = true;
    setSummaryContent('');
    openSummaryViewerModal('', true);

    try {
      const docNames = activeDocs.map((doc, index) => {
        const folder = folders.find(f => f.id === doc.folderId);
        return `Document ${index + 1}: ${doc.name}${folder ? ` (Folder: ${folder.name})` : ''}`;
      }).join('\n');

      const summaryPrompt = `Here are the reference documents:\n${docNames}\n\nPlease provide a comprehensive summary of all the provided documents. Highlight the main topics, key findings, and important details.`;

      let apiKeyForProvider: string | undefined;
      if (apiProvider === 'gemini') apiKeyForProvider = activeApiKey || undefined;
      else if (apiProvider === 'openai') apiKeyForProvider = openaiApiKey || undefined;
      else if (apiProvider === 'openai_compatible') apiKeyForProvider = openaiCompatibleApiKey || undefined;
      else if (apiProvider === 'openrouter') apiKeyForProvider = openrouterApiKey || undefined;
      else if (apiProvider === 'anthropic') apiKeyForProvider = anthropicApiKey || undefined;
      else if (apiProvider === 'cerebras') apiKeyForProvider = cerebrasApiKey || undefined;
      const cloudModelForProvider = apiProvider === 'local' ? undefined : (getCloudModelForProvider(apiProvider).trim() || undefined);
      const normalizedOpenaiCompatibleBaseUrl = openaiCompatibleBaseUrl.trim();

      if (apiProvider !== 'local' && !apiKeyForProvider) {
        showToast('Please configure and validate an API key in Settings first.', 'error');
        return;
      }

      if (apiProvider === 'openai_compatible' && !normalizedOpenaiCompatibleBaseUrl) {
        showToast('Please configure an OpenAI-compatible base URL in Settings first.', 'error');
        return;
      }

      const adaptiveSystemInstructions = `${systemInstructions}${buildFeedbackGuidance()}${buildChatConfigurationGuidance()}`;

      const response = await api.streamChat({
        messages: [{ role: 'user', text: summaryPrompt }],
        document_ids: activeDocs.map(d => d.id),
        api_provider: apiProvider,
        api_key: apiKeyForProvider,
        cloud_model: cloudModelForProvider,
        cloud_base_url: apiProvider === 'openai_compatible' ? normalizedOpenaiCompatibleBaseUrl : undefined,
        local_model_url: apiProvider === 'local' ? normalizedLocalModelUrl : undefined,
        local_model_name: apiProvider === 'local' ? normalizedLocalModelName : undefined,
        system_instructions: adaptiveSystemInstructions,
      });

      if (!response.ok) {
        const errText = await response.text();
        const detail = parseBackendErrorDetail(errText) || 'Summary request failed';
        if (isAuthError(response.status, detail)) {
          summaryViewerOpenRef.current = false;
          closeModal();
          handleSignOut();
          showToast('Session expired. Please sign in again.', 'warning');
          return;
        }
        throw new Error(detail);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let streamedCitations: CitationItem[] = [];
      let citationStreamState: CitationStreamState = { items: [] };
      let streamErrorMessage = '';
      let sseBuffer = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const extracted = extractSseDataEvents(sseBuffer);
        sseBuffer = extracted.remainder;

        for (const data of extracted.events) {
          if (data === '[DONE]') break;
          const explicitStreamError = parseStreamErrorPayload(data);
          if (explicitStreamError) {
            streamErrorMessage = explicitStreamError;
            continue;
          }
          const citationEvent = parseCitationPayload(data);
          if (citationEvent) {
            citationStreamState = applyCitationStreamEvent(citationStreamState, citationEvent);
            streamedCitations = citationStreamState.items;
            if (citationEvent.error && citationEvent.error.trim()) {
              streamErrorMessage = citationEvent.error.trim();
            }
            continue;
          }
          fullText += data;
          setSummaryContent(fullText);
          finalSummaryText = fullText;
        }
      }

      const tailEvents = extractSseDataEvents(`${sseBuffer}\n\n`).events;
      for (const tailData of tailEvents) {
        if (tailData === '[DONE]') {
          continue;
        }
        const explicitStreamError = parseStreamErrorPayload(tailData);
        if (explicitStreamError) {
          streamErrorMessage = explicitStreamError;
        } else {
          const citationEvent = parseCitationPayload(tailData);
          if (citationEvent) {
          citationStreamState = applyCitationStreamEvent(citationStreamState, citationEvent);
          streamedCitations = citationStreamState.items;
            if (citationEvent.error && citationEvent.error.trim()) {
              streamErrorMessage = citationEvent.error.trim();
            }
          } else if (tailData !== '[DONE]') {
            fullText += tailData;
            setSummaryContent(fullText);
            finalSummaryText = fullText;
          }
        }
      }

      if (!fullText.trim() && streamErrorMessage) {
        const displayStreamError = getDisplayStreamErrorMessage(streamErrorMessage) || streamErrorMessage;
        if (isBillingOrQuotaError(streamErrorMessage)) {
          fullText = '';
        } else {
          fullText = `Error: ${displayStreamError}`;
          setSummaryContent(fullText);
          finalSummaryText = fullText;
        }
      }

      if (fullText) {
        const sessionId = await getOrCreateChatSessionId();
        const summaryMessageText = `Summary:\n${fullText}`;
        const summaryMessageId = `summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        setMessages((prev) => [
          ...prev,
          {
            id: summaryMessageId,
            role: 'model',
            text: summaryMessageText,
            citations: streamedCitations.length > 0 ? streamedCitations : undefined,
            citationStatus: citationStreamState.status,
            citationStatusReason: citationStreamState.status === 'partial' ? citationStreamState.reason : undefined,
          }
        ]);

        if (sessionId) {
          api.createChatMessage(sessionId, {
            id: summaryMessageId,
            role: 'model',
            text: summaryMessageText,
            citations: streamedCitations.length > 0 ? streamedCitations : undefined,
          }).catch(() => {
            showToast('Could not persist summary output', 'warning');
          });
        }
      }

      if (citationStreamState.status === 'partial') {
        if (streamErrorMessage) {
          const displayStreamError = getDisplayStreamErrorMessage(streamErrorMessage) || streamErrorMessage;
          const streamErrorToastType = isBillingOrQuotaError(streamErrorMessage)
            ? 'warning'
            : (fullText.trim() ? 'warning' : 'error');
          showToast(displayStreamError, streamErrorToastType);
        } else {
          showToast('Summary stream ended early. Some citation details may be partial.', 'warning');
        }
      }

      if (!fullText) {
        finalSummaryText = 'Could not generate a summary.';
        setSummaryContent(finalSummaryText);
      } else {
        finalSummaryText = fullText;
      }
    } catch (error: any) {
      console.error(error);
      if (isAuthError(error?.status, error?.message)) {
        summaryViewerOpenRef.current = false;
        closeModal();
        handleSignOut();
        showToast('Session expired. Please sign in again.', 'warning');
        return;
      }
      finalSummaryText = 'Error generating summary: ' + error.message;
      setSummaryContent(finalSummaryText);
    } finally {
      openSummaryViewerModal(finalSummaryText || summaryContent, false);
    }
  };

  const handleExportChat = () => {
    const dataStr = JSON.stringify({ messages, documents: documents.map(d => ({ name: d.name, mimeType: d.mimeType })) }, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    const exportFileDefaultName = `notestack-chat-export-${new Date().toISOString().split('T')[0]}.json`;

    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
  };

  const clearAllChatHistory = async () => {
    if (chatSessions.length === 0 && messages.length === 0) {
      showToast('No chat history to clear.', 'warning');
      return;
    }

    cancelActiveChatStream();

    try {
      await api.clearAllChatSessions();

      setChatSessions([]);
      setActiveChatSessionId(null);
      setSessionChatConfigs({});
      setActiveChatConfig(DEFAULT_CHAT_SESSION_CONFIG);
      setMessages([]);
      setMessageFeedback({});

      showToast('All chat history has been cleared.', 'info');
    } catch {
      showToast('Failed to clear chat history.', 'warning');
    }
  };

  const requestClearHistoryConfirmation = () => {
    confirm({
      title: 'Clear All Chat History?',
      message: 'This permanently deletes all conversations and messages in your account.',
      confirmLabel: 'Clear All History',
      cancelLabel: 'Cancel',
      destructive: true,
      feature: 'chat',
      onConfirm: () => {
        void clearAllChatHistory();
      },
    });
  };

  const handleExportText = () => {
    try {
      if (messages.length === 0) {
        showToast("No chat history to export.", 'warning');
        return;
      }

      let textContent = `NoteStack Chat Export - ${new Date().toLocaleString()}\n\n`;

      messages.forEach(msg => {
        const role = msg.role === 'user' ? 'User' : 'NoteStack';
        textContent += `${role}:\n${msg.text}\n\n`;
      });

      const blob = new Blob([textContent], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `NoteStack_Export_${new Date().toISOString().split('T')[0]}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Error exporting text:", error);
      showToast("Failed to export text. See console for details.", 'error');
    }
  };

  const handlePreviewDoc = async (doc: Document) => {
    setIsPreviewLoading(true);
    try {
      const content = await localforage.getItem<string>(doc.id);
      if (content) {
        setPreviewContent(content);
        setPreviewDoc(doc);

        if (doc.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
           const binaryString = atob(content);
           const bytes = new Uint8Array(binaryString.length);
           for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
           }
           const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
           // we'll render this html string
           setPreviewContent(result.value);
        } else if (doc.mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
           const binaryString = atob(content);
           const bytes = new Uint8Array(binaryString.length);
           for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
           }
           const zip = await JSZip.loadAsync(bytes.buffer);
           let text = '';
           const slideFiles = Object.keys(zip.files).filter(k => k.startsWith('ppt/slides/slide') && k.endsWith('.xml'));
           for (const slideFile of slideFiles) {
               const xml = await zip.files[slideFile].async('string');
               const matches = xml.match(/<a:t[^>]*>(.*?)<\/a:t>/g);
               if (matches) {
                   text += matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ') + '\n\n';
               }
           }
           if (!text) text = "No text found in PPTX.";
           // store as b64 so the preview modal can decode it
           setPreviewContent(btoa(unescape(encodeURIComponent(text))));
        }
      } else {
        showToast("Could not load document content for preview.", 'error');
      }
    } catch (e) {
      console.error("Preview error:", e);
      showToast("Error loading preview.", 'error');
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const handlePreviewStaged = async (file: File) => {
    if (stagedPreviewUrl && stagedPreviewType === 'application/pdf') {
      URL.revokeObjectURL(stagedPreviewUrl);
    }
    setStagedPreviewType(file.type);

    if (file.type === 'application/pdf') {
      const url = URL.createObjectURL(file);
      setStagedPreviewUrl(url);
      setStagedPreviewText(null);
      setStagedPreviewHtml(null);
    } else if (file.type === 'text/plain') {
      const text = await file.text();
      setStagedPreviewText(text);
      setStagedPreviewHtml(null);
      setStagedPreviewUrl('text');
    } else if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const buffer = await file.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
      setStagedPreviewHtml(result.value);
      setStagedPreviewText(null);
      setStagedPreviewUrl('html');
    } else if (file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
      const buffer = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buffer);
      let text = '';
      const slideFiles = Object.keys(zip.files).filter(k => k.startsWith('ppt/slides/slide') && k.endsWith('.xml'));
      for (const slideFile of slideFiles) {
          const xml = await zip.files[slideFile].async('string');
          const matches = xml.match(/<a:t[^>]*>(.*?)<\/a:t>/g);
          if (matches) {
              text += matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ') + '\n\n';
          }
      }
      if (!text) text = "No text found in PPTX.";
      setStagedPreviewText(text);
      setStagedPreviewHtml(null);
      setStagedPreviewUrl('text');
    }
  };

  const normalizedSourceSearchQuery = sourceSearchQuery.trim().toLowerCase();

  const filteredDocuments = documents.filter((doc) => {
    if (!normalizedSourceSearchQuery) return true;
    return doc.name.toLowerCase().includes(normalizedSourceSearchQuery);
  });

  const visibleFolderDocCounts = filteredDocuments.reduce<Record<string, number>>((acc, doc) => {
    if (!doc.folderId) return acc;
    acc[doc.folderId] = (acc[doc.folderId] || 0) + 1;
    return acc;
  }, {});

  const filteredFolders = folders.filter((folder) => {
    if (!normalizedSourceSearchQuery) return true;
    return (visibleFolderDocCounts[folder.id] || 0) > 0;
  });

  const sortedDocuments = [...filteredDocuments].sort((a, b) => {
    let comparison = 0;
    if (sortOption === 'name') {
      comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    } else if (sortOption === 'date') {
      comparison = (a.timestamp || 0) - (b.timestamp || 0);
    } else if (sortOption === 'size') {
      comparison = (a.size || 0) - (b.size || 0);
    }

    if (comparison === 0) {
      comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    }

    return sortOrder === 'asc' ? comparison : -comparison;
  });

  const sortedFolders = [...filteredFolders].sort((a, b) => {
    let comparison = 0;
    if (folderSortOption === 'name') {
      comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    } else if (folderSortOption === 'count') {
      const aCount = visibleFolderDocCounts[a.id] || 0;
      const bCount = visibleFolderDocCounts[b.id] || 0;
      comparison = aCount - bCount;
    } else {
      comparison = (a.timestamp || 0) - (b.timestamp || 0);
    }

    if (comparison === 0) {
      comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    }

    return folderSortOrder === 'asc' ? comparison : -comparison;
  });

  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState(false);
  const hasUserMessages = messages.some((message) => message.role === 'user');
  const starterGreeting = accountFirstName?.trim() ? `Hi ${accountFirstName.trim()}` : 'Hi there';

  // Authentication Handlers
  const resetTransientWorkspaceUiState = () => {
    accountHydrationRequestIdRef.current += 1;
    setIsSettingsOpen(false);
    setActiveSettingsTab('account');
    setAccountPassword('');
    setAccountConfirmPassword('');
    setShowAccountPassword(false);
    setShowAccountConfirmPassword(false);
    clearInline(ACCOUNT_SETTINGS_INLINE_SCOPE);
  };

  const handleAuthComplete = () => {
    resetTransientWorkspaceUiState();
    setCurrentView('workspace');
  };

  const handleSignOut = () => {
    cancelActiveChatStream();
    resetTransientWorkspaceUiState();
    setAccountFirstName('');
    setAccountLastName('');
    setAccountEmail('');
    try {
      localStorage.removeItem('nb_auth_token');
    } catch {}
    setCurrentView('landing');
  };

  const requestSignOutConfirmation = () => {
    confirm({
      title: 'Sign Out Securely?',
      message: 'You will be signed out from this device and redirected to the landing page.',
      confirmLabel: 'Sign Out',
      cancelLabel: 'Cancel',
      feature: 'auth',
      onConfirm: () => handleSignOut(),
    });
  };

  if (currentView === 'landing') {
    return <LandingPage onNavigate={setCurrentView} />;
  }

  if (currentView === 'login' || currentView === 'signup') {
    return (
      <AuthPages
        type={currentView}
        onNavigate={setCurrentView}
        onAuthComplete={handleAuthComplete}
      />
    );
  }

  return (
    <div className="flex h-screen bg-[var(--panel-color)] text-[var(--text-color)] font-sans overflow-hidden relative transition-colors duration-300">
      {/* Mobile Sidebar Overlay */}
      {isSidebarOpen && (
        <div
          className="md:hidden fixed inset-0 z-20 bg-[var(--bg-color)]/80 backdrop-blur-md"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed inset-y-0 left-0 transform ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0 transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] z-30 w-[300px] sm:w-[350px] h-full bg-[var(--bg-color)] flex flex-col border-r border-[var(--border-color)] shrink-0 shadow-2xl md:shadow-none transition-colors duration-300`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Window Controls */}
        <div className="flex gap-1.5 px-6 pt-6 pb-2">
          <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f57] shadow-inner" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e] shadow-inner" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#27c93f] shadow-inner" />
        </div>
        {/* Drag Overlay for Sources */}
        <AnimatePresence>
          {isDragging && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-50 bg-[#131314]/90 backdrop-blur-md border-2 border-dashed border-blue-500 flex flex-col items-center justify-center text-blue-400 m-2 rounded-2xl pointer-events-none ring-4 ring-blue-500/20"
            >
              <Upload className="w-10 h-10 mb-3 animate-bounce shadow-blue-500" />
              <span className="font-semibold tracking-tight text-lg text-center px-4">Drop files to add as sources</span>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center justify-between mb-2 px-6 shrink-0 pt-4">
          <span className="text-[13px] font-bold text-[var(--text-dim)] uppercase tracking-widest">Workspace</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setIsSidebarOpen(false)}
              className="md:hidden p-2 text-slate-400 hover:text-white transition-colors"
              aria-label="Close Sidebar"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div
          className={`flex-1 overflow-y-auto w-full custom-scrollbar py-4 px-3 transition-colors ${dragOverRoot ? 'bg-white/5 rounded-xl' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            const hasFiles = e.dataTransfer.types.includes('Files');
            if (!hasFiles) {
              setDragOverRoot(true);
            }
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragOverRoot(false);
          }}
          onDrop={(e) => {
            if (e.dataTransfer.types.includes('Files')) return; // Ignore actual file drops
            e.preventDefault();
            setDragOverRoot(false);
            try {
              const data = e.dataTransfer.getData('application/notestack-docs');
              if (data) {
                const { ids } = JSON.parse(data);
                setDocuments(prev => prev.map(d => ids.includes(d.id) ? { ...d, folderId: undefined } : d));
                void persistDocumentFolderAssignments(ids);
              }
            } catch (err) {}
          }}
        >
          <div className="flex flex-col gap-3 mb-5">
            <div className="flex gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex-1 py-2.5 px-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl transition-all flex items-center justify-center gap-2 font-medium text-[12px] shadow-md shadow-blue-900/20 active:scale-95 border border-blue-500/50"
              >
                <Upload className="w-4 h-4" /> <span>Upload</span>
              </button>
              <button
                onClick={createNewFolder}
                className="flex-1 py-2.5 px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl transition-all flex items-center justify-center gap-2 font-medium text-[12px] shadow-md shadow-indigo-900/20 active:scale-95 border border-indigo-500/50"
              >
                <FolderPlus className="w-4 h-4" /> <span>Folder</span>
              </button>
            </div>
            <button
              onClick={handleSummarize}
              disabled={documents.length === 0}
              className="w-full py-2.5 px-3 bg-[#1e1e20] hover:bg-[#2a2a2d] border border-[#333] text-slate-200 rounded-xl transition-all flex items-center justify-center gap-2 font-medium text-[12px] disabled:opacity-50 disabled:cursor-not-allowed shadow-sm ring-1 ring-white/5"
            >
              <FileText className="w-4 h-4 text-slate-400" /> <span>Summarize All Documents</span>
            </button>
          </div>

          <div className="flex flex-col gap-4 mb-6">
            <div className="flex items-center gap-2">
              <div className="relative flex-1 group">
                <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-blue-400 transition-colors" />
                <input
                  type="text"
                  value={sourceSearchQuery}
                  onChange={(e) => setSourceSearchQuery(e.target.value)}
                  placeholder="Filter sources..."
                  className="w-full bg-[#131314] border border-[#333]/80 rounded-xl pl-10 pr-8 py-2.5 text-[13px] text-slate-200 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all shadow-inner placeholder:text-slate-600"
                />
                {sourceSearchQuery && (
                  <button
                    onClick={() => setSourceSearchQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors p-0.5 hover:bg-white/5 rounded-full"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {sourceSearchQuery && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="flex items-center justify-between px-1 overflow-hidden"
              >
                <span className="text-[10px] font-bold text-blue-400/80 uppercase tracking-widest flex items-center gap-1.5">
                  <Filter className="w-3 h-3" />
                  Active Filters
                  <span className="bg-blue-400/10 px-1.5 py-0.5 rounded text-[9px] min-w-[16px] text-center border border-blue-400/20">
                    {sourceSearchQuery ? 1 : 0}
                  </span>
                </span>
                <button
                  onClick={() => { setSourceSearchQuery(''); }}
                  className="text-[10px] text-slate-500 hover:text-red-400 font-bold uppercase tracking-wider transition-colors flex items-center gap-1 hover:underline underline-offset-4"
                >
                  Clear All
                </button>
              </motion.div>
            )}
          </div>

          <div className="flex flex-col gap-3 mb-5 mt-1 px-1">
            <div className="flex items-center justify-between text-[12px] text-slate-400">
              <span className="font-bold tracking-widest uppercase text-[10px] text-slate-500 flex items-center gap-2">
                <span className="w-1 h-1 rounded-full bg-slate-600"></span>
                {selectedDocIds.length > 0 ? `${selectedDocIds.length} Selected` : 'Sources'}
              </span>

              <div className="flex items-center gap-2">
                <div className="relative">
                  <button
                    onClick={() => setIsSortDropdownOpen(!isSortDropdownOpen)}
                    className="flex items-center gap-2 px-2 py-1.5 hover:bg-white/5 rounded-lg text-[11px] font-semibold text-slate-400 hover:text-slate-200 transition-colors"
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    <span className="capitalize">{sortOption}</span>
                    <ChevronDown className={`w-3 h-3 transition-transform ${isSortDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>
                  <AnimatePresence>
                    {isSortDropdownOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setIsSortDropdownOpen(false)} />
                        <motion.div
                          initial={{ opacity: 0, scale: 0.95, y: 10 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95, y: 10 }}
                          className="absolute right-0 top-full mt-2 w-36 bg-[#1e1e20] border border-[#333] rounded-xl shadow-2xl z-50 overflow-hidden py-1.5 ring-1 ring-white/5"
                        >
                          <div className="px-3 py-1.5 mb-1 border-b border-[#333]/50">
                            <span className="text-[10px] font-bold text-[var(--text-dim)] uppercase tracking-widest">Sort Docs By</span>
                          </div>
                          {(['name', 'date', 'size'] as const).map(option => (
                            <button
                              key={`doc-sort-${option}`}
                              onClick={() => {
                                setSortOption(option);
                                setIsSortDropdownOpen(false);
                              }}
                              className={`w-full text-left px-3 py-2 text-[12px] font-medium transition-colors hover:bg-white/5 flex items-center justify-between ${
                                sortOption === option ? 'text-blue-400 bg-blue-400/5' : 'text-slate-400'
                              }`}
                            >
                              <span className="capitalize">{option}</span>
                              {sortOption === option && <Check className="w-3.5 h-3.5" />}
                            </button>
                          ))}
                          <div className="mt-1 border-t border-[#333]/50">
                            <button
                              onClick={() => {
                                setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
                                setIsSortDropdownOpen(false);
                              }}
                              className="w-full text-left px-3 py-2 text-[12px] font-medium text-slate-400 hover:bg-white/5 flex items-center justify-between"
                            >
                              <span>Order</span>
                              <div className="flex items-center gap-1.5 text-[11px]">
                                {sortOrder === 'asc' ? 'Asc' : 'Desc'}
                                <ArrowDown className={`w-3.5 h-3.5 transition-transform ${sortOrder === 'asc' ? 'rotate-180' : ''}`} />
                              </div>
                            </button>
                          </div>

                          <div className="px-3 py-1.5 mb-1 mt-2 border-y border-[#333]/50 bg-black/20">
                            <span className="text-[10px] font-bold text-[var(--text-dim)] uppercase tracking-widest">Sort Folders By</span>
                          </div>
                          {(['name', 'date', 'count'] as const).map(option => (
                            <button
                              key={`folder-sort-${option}`}
                              onClick={() => {
                                setFolderSortOption(option);
                                setIsSortDropdownOpen(false);
                              }}
                              className={`w-full text-left px-3 py-2 text-[12px] font-medium transition-colors hover:bg-white/5 flex items-center justify-between ${
                                folderSortOption === option ? 'text-blue-400 bg-blue-400/5' : 'text-slate-400'
                              }`}
                            >
                              <span className="capitalize">{option}</span>
                              {folderSortOption === option && <Check className="w-3.5 h-3.5" />}
                            </button>
                          ))}
                          <div className="mt-1 border-t border-[#333]/50">
                            <button
                              onClick={() => {
                                setFolderSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
                                setIsSortDropdownOpen(false);
                              }}
                              className="w-full text-left px-3 py-2 text-[12px] font-medium text-slate-400 hover:bg-white/5 flex items-center justify-between"
                            >
                              <span>Order</span>
                              <div className="flex items-center gap-1.5 text-[11px]">
                                {folderSortOrder === 'asc' ? 'Asc' : 'Desc'}
                                <ArrowDown className={`w-3.5 h-3.5 transition-transform ${folderSortOrder === 'asc' ? 'rotate-180' : ''}`} />
                              </div>
                            </button>
                          </div>
                        </motion.div>
                      </>
                    )}
                  </AnimatePresence>
                </div>

                <div className="h-4 w-[1px] bg-[#333]/50 mx-1"></div>

                <button
                  onClick={() => {
                    const visibleDocIds = filteredDocuments.map((doc) => doc.id);
                    if (visibleDocIds.length === 0) return;

                    const areAllVisibleDocsSelected = visibleDocIds.every((docId) => selectedDocIds.includes(docId));

                    if (areAllVisibleDocsSelected) {
                      setSelectedDocIds((prev) => prev.filter((docId) => !visibleDocIds.includes(docId)));
                      return;
                    }

                    setSelectedDocIds((prev) => Array.from(new Set([...prev, ...visibleDocIds])));
                  }}
                  className="text-slate-500 hover:text-blue-400 transition-colors font-bold text-[10px] uppercase tracking-wider"
                >
                  {filteredDocuments.length > 0 && filteredDocuments.every((doc) => selectedDocIds.includes(doc.id)) ? 'None' : 'All'}
                </button>
              </div>
            </div>
          </div>

          {selectedDocIds.length > 0 && (
            <div className="flex flex-col gap-2 mb-3">
              <div className="flex gap-2">
                <button
                  onClick={() => { setIsGroupingFolder(!isGroupingFolder); setGroupFolderInput(''); }}
                  className={`flex-[2] py-1.5 text-[11px] font-medium rounded-md transition-colors border ${isGroupingFolder ? 'bg-blue-500/30 text-white border-blue-500/50' : 'bg-blue-500/10 text-blue-400 border-blue-500/20 hover:bg-blue-500/20'}`}
                >
                  Group
                </button>
                {selectedDocIds.length >= 2 && (
                  <button
                    onClick={() => {
                      const selectedDocuments = documents.filter((doc) => selectedDocIds.includes(doc.id));
                      const selectedNames = selectedDocuments.map((doc) => doc.name);

                      // Compare should scope attachments to just the currently selected sources.
                      setAttachedFiles(selectedDocuments);

                      setInput(`Please compare and contrast the following sources across their main themes, highlighting their differences and similarities in a structured response:\n\n- ${selectedNames.join('\n- ')}`);
                      inputRef.current?.focus();
                    }}
                    className="flex-[3] py-1.5 text-[11px] font-medium rounded-md transition-colors border bg-purple-500/10 text-purple-400 border-purple-500/20 hover:bg-purple-500/20 flex items-center justify-center gap-1.5 shadow-[0_0_10px_rgba(168,85,247,0.1)]"
                  >
                    <Merge className="w-3.5 h-3.5" /> Compare ({selectedDocIds.length})
                  </button>
                )}
              </div>
              {isGroupingFolder && (
                 <div className="flex gap-2">
                    <input
                      type="text"
                      value={groupFolderInput}
                      onChange={e => setGroupFolderInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleGroupSelectedSubmit(groupFolderInput);
                        if (e.key === 'Escape') setIsGroupingFolder(false);
                      }}
                      placeholder="Folder name..."
                      className="flex-1 bg-[#2a2a2d] border border-[#444] rounded-md px-2 py-1.5 text-[12px] text-slate-200 focus:outline-none focus:border-blue-500"
                      autoFocus
                    />
                    <button
                      onClick={() => handleGroupSelectedSubmit(groupFolderInput)}
                      className="px-3 py-1.5 bg-blue-500 text-white rounded-md text-[12px] font-medium hover:bg-blue-600 transition-colors"
                    >
                      Group
                     </button>
                 </div>
              )}
            </div>
          )}

          <AnimatePresence>
            {uploadingFiles.map((upload) => (
              <motion.div
                key={`upload-${upload.id}`}
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="py-2.5 flex flex-col gap-2 group hover:bg-[#2a2a2d] rounded-md px-2 -mx-2 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 bg-[#2a2a2d] rounded flex items-center justify-center shrink-0">
                    <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
                  </div>
                  <div className="text-[13px] font-medium whitespace-nowrap overflow-hidden text-ellipsis text-slate-400 flex-1" title={upload.name}>
                    {upload.name}
                  </div>
                  <div className="text-[11px] text-slate-500 font-medium shrink-0">
                    {Math.round(upload.progress)}%
                  </div>
                </div>
                <div className="w-full bg-[#333] rounded-full h-1.5 ml-8 max-w-[calc(100%-2rem)] overflow-hidden">
                  <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${upload.progress}%` }}></div>
                </div>
              </motion.div>
            ))}

            {sortedFolders.map(folder => (
              <div key={`folder-${folder.id}`} className="flex flex-col gap-1 mb-2">
                <div
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl group cursor-pointer transition-all border border-transparent ${dragOverFolderId === folder.id ? 'bg-white/5 ring-1 ring-blue-500/50' : 'hover:bg-white/5'}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOverFolderId(folder.id);
                    if (!folder.isExpanded) {
                      if (!expandTimerRef.current[folder.id]) {
                        expandTimerRef.current[folder.id] = setTimeout(() => {
                          setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, isExpanded: true } : f));
                        }, 600);
                      }
                    }
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (dragOverFolderId === folder.id) {
                      setDragOverFolderId(null);
                    }
                    if (expandTimerRef.current[folder.id]) {
                      clearTimeout(expandTimerRef.current[folder.id]);
                      delete expandTimerRef.current[folder.id];
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOverFolderId(null);
                    if (expandTimerRef.current[folder.id]) {
                      clearTimeout(expandTimerRef.current[folder.id]);
                      delete expandTimerRef.current[folder.id];
                    }
                    try {
                      const data = e.dataTransfer.getData('application/notestack-docs');
                      if (data) {
                        const { ids } = JSON.parse(data);
                        setDocuments(prev => prev.map(d => ids.includes(d.id) ? { ...d, folderId: folder.id } : d));
                        void persistDocumentFolderAssignments(ids, folder.id);
                      }
                    } catch (err) {}
                  }}
                >
                  <button onClick={() => toggleFolder(folder.id)} className="text-slate-500 hover:text-white transition-colors">
                    {folder.isExpanded ? <ChevronDown className="w-3.5 h-3.5"/> : <ChevronRight className="w-3.5 h-3.5"/>}
                  </button>
                  <FolderIcon className="w-4 h-4 text-blue-600 shrink-0" />
                  {editingId === folder.id ? (
                    <input autoFocus value={editingName} onChange={e => setEditingName(e.target.value)} onBlur={handleRenameCommit} onKeyDown={e => e.key === 'Enter' && handleRenameCommit()} className="bg-[#131314] rounded-sm px-1 border border-blue-500 text-[13px] text-slate-200 focus:outline-none w-full shadow-inner" />
                  ) : (
                    <span className="text-[13px] font-bold text-slate-300 flex-1 truncate" onDoubleClick={() => handleRenameStart(folder.id, folder.name)}>{folder.name}</span>
                  )}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-black/40 backdrop-blur-md rounded-lg p-0.5">
                    <button onClick={(e) => { e.stopPropagation(); handleRenameStart(folder.id, folder.name); }} className="p-1 hover:bg-white/10 rounded-md transition-colors text-slate-500" title="Rename"><Edit2 className="w-3 h-3" /></button>
                    <button onClick={(e) => { e.stopPropagation(); removeFolder(folder.id); }} className="p-1 hover:bg-red-500/10 hover:text-red-400 rounded-md transition-colors text-slate-500" title="Delete"><Trash2 className="w-3 h-3" /></button>
                  </div>
                </div>
                {folder.isExpanded && (
                  <div className="pl-6 flex flex-col gap-1 mt-1 border-l border-white/5 ml-4">
                    {sortedDocuments.filter(d => d.folderId === folder.id).map(doc => (
                      <motion.div
                        key={`doc-${doc.id}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="py-1.5 flex items-center gap-2 group hover:bg-[var(--panel-hover)] rounded-xl px-2 transition-all cursor-pointer border border-transparent relative duration-200"
                        draggable={true}
                        onDragStart={((e: any) => handleDocDragStart(e, doc)) as any}
                      >
                        <div
                          className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                            selectedDocIds.includes(doc.id) ? 'bg-blue-500 border-blue-500' : 'border-slate-500/50 hover:border-slate-400 group-hover:border-slate-500'
                          }`}
                          onClick={(e) => { e.stopPropagation(); toggleDocSelection(doc.id); }}
                        >
                          {selectedDocIds.includes(doc.id) && <Check className="w-2.5 h-2.5 text-white" />}
                        </div>
                        <div className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 transition-all ${selectedDocIds.includes(doc.id) ? 'bg-blue-600 shadow-[0_0_10px_rgba(37,99,235,0.3)] text-white' : 'bg-blue-600/10 border border-blue-600/20'}`}>
                          {getFileIcon(doc.mimeType, undefined, selectedDocIds.includes(doc.id) ? 'text-white' : undefined)}
                        </div>
                        <div className="flex flex-col flex-1 min-w-0" onClick={() => toggleDocSelection(doc.id)}>
                          <div className={`text-[12px] font-medium truncate ${selectedDocIds.includes(doc.id) ? 'text-blue-500' : 'text-[var(--text-dim)] group-hover:text-[var(--text-color)]'}`} title={doc.name}>
                            {doc.name}
                          </div>
                          {(doc.size || doc.timestamp) && (
                            <div className="text-[10px] text-slate-500 flex items-center gap-1.5 mt-0.5">
                              {doc.size && <span>{formatSize(doc.size)}</span>}
                              {doc.size && doc.timestamp && <span>•</span>}
                              {doc.timestamp && <span>Added {formatDate(doc.timestamp)}</span>}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 absolute right-2 bg-black/40 backdrop-blur-md rounded-lg p-0.5">
                          <button onClick={(e) => { e.stopPropagation(); handlePreviewDoc(doc); }} className="p-1 hover:bg-white/10 rounded-md transition-colors text-slate-500" title="Preview"><Eye className="w-3 h-3" /></button>
                          <button onClick={(e) => { e.stopPropagation(); removeDocument(doc.id); }} className="p-1 hover:bg-red-500/10 hover:text-red-400 rounded-md transition-colors text-slate-500" title="Delete"><X className="w-3 h-3" /></button>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {sortedDocuments.filter(d => !d.folderId).map((doc) => (
              <motion.div
                key={`doc-${doc.id}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="py-2 flex items-center gap-3 group hover:bg-[var(--panel-hover)] rounded-xl px-3 transition-all cursor-pointer border border-transparent relative duration-200"
                draggable={true}
                onDragStart={((e: any) => handleDocDragStart(e, doc)) as any}
              >
                <div
                  className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                    selectedDocIds.includes(doc.id) ? 'bg-blue-500 border-blue-500' : 'border-slate-500/50 hover:border-slate-400 group-hover:border-slate-500'
                  }`}
                  onClick={(e) => { e.stopPropagation(); toggleDocSelection(doc.id); }}
                >
                  {selectedDocIds.includes(doc.id) && <Check className="w-3 h-3 text-white" />}
                </div>
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-all ${selectedDocIds.includes(doc.id) ? 'bg-blue-600 shadow-[0_0_15px_rgba(37,99,235,0.4)] text-white' : 'bg-blue-600/10 border border-blue-600/20'}`}>
                  {getFileIcon(doc.mimeType, undefined, selectedDocIds.includes(doc.id) ? 'text-white' : undefined)}
                </div>
                <div className="flex flex-col flex-1 min-w-0" onClick={() => toggleDocSelection(doc.id)}>
                   <div className={`text-[13px] font-bold truncate transition-colors ${selectedDocIds.includes(doc.id) ? 'text-blue-500' : 'text-[var(--text-dim)] group-hover:text-[var(--text-color)]'}`} title={doc.name}>
                    {doc.name}
                  </div>
                  {(doc.size || doc.timestamp) && (
                    <div className="text-[11px] text-slate-500 flex items-center gap-1.5 mt-0.5">
                      {doc.size && <span>{formatSize(doc.size)}</span>}
                      {doc.size && doc.timestamp && <span>•</span>}
                      {doc.timestamp && <span>Added {formatDate(doc.timestamp)}</span>}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 bg-[#0a0a0b]/80 backdrop-blur-md rounded-lg p-0.5 border border-white/5 absolute right-2">
                  <button onClick={(e) => { e.stopPropagation(); handlePreviewDoc(doc); }} className="p-1.5 hover:bg-white/10 rounded-md transition-colors text-slate-500 hover:text-white" title="Preview"><Eye className="w-3.5 h-3.5" /></button>
                  <button onClick={(e) => { e.stopPropagation(); removeDocument(doc.id); }} className="p-1.5 hover:bg-red-500/10 hover:text-red-400 rounded-md transition-colors text-slate-500" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
            multiple
            accept=".pdf,.txt"
          />
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col relative z-0 min-w-0 bg-[var(--panel-color)] overflow-hidden transition-colors duration-300">
        {/* Ambient Dark Background Effect */}
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-blue-500/5 mix-blend-screen rounded-full blur-[120px] pointer-events-none -translate-y-1/2 translate-x-1/4"></div>

        <header className="h-[65px] border-b border-[var(--border-color)] bg-[var(--bg-color)]/80 backdrop-blur-xl flex items-center justify-between px-4 sm:px-8 shrink-0 sticky top-0 z-10 shadow-sm transition-colors duration-300">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="md:hidden p-2 -ml-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-full transition-colors"
              aria-label="Open Sidebar"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-[16px] font-semibold tracking-tight text-slate-100 flex items-center gap-2">NoteStack Chat
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportText}
              className="px-4 py-2 text-slate-300 hover:text-white transition-all bg-[#1e1e20]/80 hover:bg-[#2a2a2d] rounded-full border border-[#333]/60 flex items-center gap-2 ring-1 ring-white/5 shadow-sm"
              aria-label="Export Text"
              title="Export Text"
            >
              <Download className="w-[15px] h-[15px]" />
              <span className="text-[13px] font-medium hidden sm:inline">Export Text</span>
            </button>
            <div className="w-px h-6 bg-[#333]/60 mx-1"></div>
            <button
              onClick={() => setIsNotesOpen(!isNotesOpen)}
              className={`p-2.5 transition-all rounded-full border ${isNotesOpen ? 'bg-blue-500/10 text-blue-400 border-blue-500/30 ring-1 ring-blue-500/20 shadow-inner' : 'bg-transparent text-slate-400 hover:text-white hover:bg-white/10 border-transparent'}`}
              aria-label="Toggle Notes"
              title="Toggle Notes"
            >
              {isNotesOpen ? <PanelRightClose className="w-[18px] h-[18px]" /> : <PanelRightOpen className="w-[18px] h-[18px]" />}
            </button>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-2.5 text-slate-400 hover:text-white transition-all bg-transparent hover:bg-white/10 rounded-full border border-transparent"
              aria-label="Settings"
              title="Settings"
            >
              <Settings className="w-[18px] h-[18px]" />
            </button>
          </div>
        </header>

        {/* Chat Messages */}
        <div className="flex-1 overflow-y-auto p-6 md:p-10 flex flex-col gap-8 scroll-smooth custom-scrollbar pb-10 bg-[var(--panel-color)] transition-colors duration-300">
          {!hasUserMessages ? (
            <div className="h-full flex flex-col justify-center max-w-4xl mx-auto w-full px-2 md:px-4">
              <p className="text-blue-300 text-2xl md:text-3xl font-medium tracking-tight">{starterGreeting}</p>
              <h2 className="text-[38px] md:text-[52px] font-semibold text-[var(--text-color)] leading-[1.05] tracking-tight mt-1">Where should we start?</h2>
              <p className="text-[var(--text-dim)] text-[15px] mt-4 max-w-2xl">Ask a question or attach a file below to kick off your first chat.</p>
            </div>
          ) : (
            messages.map((msg) => {
              const hasMessageText = msg.text.trim().length > 0;
              const canRegenerateThisMessage = msg.role === 'model' ? canRegenerateModelMessage(msg.id) : false;
              const isRegeneratingThisMessage = regeneratingMessageId === msg.id;

              // Skip rendering temporary empty model placeholders while streaming starts.
              if (msg.role === 'model' && !hasMessageText) {
                return null;
              }

              return (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                key={msg.id}
                className={`flex gap-4 max-w-4xl mx-auto w-full ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
              >
                {msg.role === 'model' && (
                  <div className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-[12px] font-semibold bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-md shadow-blue-500/20">
                    <Sparkles className="w-4.5 h-4.5" />
                  </div>
                )}
                <div className={`flex flex-col group/message relative ${msg.role === 'model' ? 'flex-1 max-w-[90%]' : 'items-end ml-auto max-w-[95%]'}`}>
                  {msg.role === 'model' && msg.citationStatus === 'partial' && (
                    <div className="mb-2 inline-flex items-center gap-1.5 self-start rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-300">
                      <Info className="h-3.5 w-3.5" />
                      <span>Citation details may be partial for this response.</span>
                    </div>
                  )}
                  {msg.role === 'user' ? (
                    <div className="flex flex-col items-end gap-2">
                      {msg.attachedFiles && msg.attachedFiles.length > 0 && (
                        <div className="flex flex-wrap gap-2 justify-end mb-1 max-w-[95%]">
                          {msg.attachedFiles.map((doc: any, index) => {
                            const mimeType = doc?.mimeType || doc?.mime_type || '';
                            const name = doc?.name || 'Attachment';
                            return (
                              <div key={`msg-attached-${doc?.id || name}-${index}`} className="flex items-center gap-3 bg-[var(--panel-color)]/85 border border-[var(--border-color)] rounded-2xl px-3 py-2.5 shadow-sm max-w-[320px]">
                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${getAttachmentAccentClass(mimeType)}`}>
                                  {getFileIcon(mimeType, "w-4 h-4", "text-white")}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="text-[13px] font-semibold text-[var(--text-color)] truncate" title={name}>{name}</div>
                                  <div className="text-[11px] uppercase tracking-wide text-[var(--text-dim)] mt-0.5">{getAttachmentTypeLabel(mimeType, name)}</div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {msg.text && (
                        <div className={getMessageStyle(msg)} style={msg.bubbleStyle}>
                          {msg.text}
                        </div>
                      )}
                      {msg.text && (
                        <div className="flex items-center gap-2 pr-1">
                          <button
                            onClick={() => handleCopyMessageText(msg.text)}
                            className="p-1.5 text-[var(--text-dim)] hover:text-[var(--text-color)] transition-colors rounded-md hover:bg-[var(--panel-hover)]"
                            title="Copy text"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className={getMessageStyle(msg)} style={msg.bubbleStyle}>
                      <div className="prose prose-sm xl:prose-base prose-invert max-w-none text-slate-300 leading-relaxed font-sans
                        prose-p:text-slate-300 prose-p:leading-relaxed prose-p:my-3
                        prose-headings:text-slate-100 prose-headings:font-semibold prose-headings:mt-5 prose-headings:mb-2
                        prose-h3:text-blue-200
                        prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
                        prose-strong:text-slate-100 prose-strong:font-semibold
                        prose-code:text-teal-300 prose-code:bg-[#1e1e20] prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:font-mono prose-code:text-[0.9em]
                        prose-pre:bg-[#131314] prose-pre:border prose-pre:border-[#333]/60 prose-pre:shadow-inner
                        prose-ul:my-3 prose-ol:my-3 prose-li:text-slate-300 prose-li:my-1.5
                        prose-hr:border-[#3a3a3d]
                        prose-blockquote:text-slate-400 prose-blockquote:border-l-blue-500 prose-blockquote:bg-blue-500/5 prose-blockquote:py-1 prose-blockquote:px-4 prose-blockquote:rounded-r-lg
                      ">
                        <Markdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={[rehypeSanitize]}
                          components={{
                            code(props) {
                              const {children, className, node, ref, ...rest} = props;
                              const match = /language-(\w+)/.exec(className || '');
                              return match ? (
                                <SyntaxHighlighter
                                  {...rest}
                                  PreTag="div"
                                  children={String(children).replace(/\n$/, '')}
                                  language={match[1]}
                                  style={vscDarkPlus as any}
                                  className="rounded-md my-4 text-[13px] border border-[#333]"
                                />
                              ) : (
                                <code {...rest} ref={ref as any} className={`${className} bg-[#2a2a2d] px-1.5 py-0.5 rounded text-blue-300 font-mono text-[13px]`}>
                                  {children}
                                </code>
                              );
                            },
                            table: ({ node, ...props }) => (
                              <div className="overflow-x-auto my-4 border border-[#333] rounded-lg">
                                <table {...props} className="w-full text-left border-collapse" />
                              </div>
                            ),
                            thead: ({ node, ...props }) => <thead {...props} className="bg-[#2a2a2d]" />,
                            tbody: ({ node, ...props }) => <tbody {...props} className="divide-y divide-[#333]" />,
                            tr: ({ node, ...props }) => <tr {...props} className="even:bg-[#1a1a1c] transition-colors hover:bg-white/5" />,
                            th: ({ node, ...props }) => <th {...props} className="px-4 py-2 font-semibold text-slate-200 text-[13px] border-r border-[#333] last:border-r-0" />,
                            td: ({ node, ...props }) => <td {...props} className="px-4 py-2 text-slate-300 text-[13px] border-r border-[#333] last:border-r-0" />,
                            img: ({ node, ...props }) => <img {...props} className="max-w-full h-auto rounded-lg my-4 border border-[#333] shadow-lg bg-[#131314]" referrerPolicy="no-referrer" />,
                            a: ({ node, ...props }) => {
                              if (props.href?.startsWith('#cite-')) {
                                const num = props.href.replace('#cite-', '');
                                const citationMeta = getCitationForMessage(msg, num);
                                const snippet = citationMeta?.snippet || props.title || "Source snippet not available.";
                                const docName = citationMeta?.document_name || `Source Document ${num}`;
                                const citationTitle = toCitationTitleFromSnippet(snippet, num);
                                const sourceContext = citationMeta?.source_label || getCitationSourceContext(docName, citationMeta?.chunk_index, citationMeta?.chunk_indices);

                                return (
                                  <span className="relative inline-block align-middle z-10 hover:z-50">
                                    <span
                                      onClick={() => openCitationDetailsModal({
                                        number: num,
                                        snippet,
                                        documentName: citationTitle,
                                        chunkIndex: citationMeta?.chunk_index,
                                        chunkIndices: citationMeta?.chunk_indices,
                                        sourceContext,
                                      })}
                                      className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 rounded-full bg-gradient-to-br from-amber-500/20 to-orange-500/20 text-amber-300 hover:from-amber-500 hover:to-orange-500 hover:text-white text-[10px] font-extrabold tracking-wide mx-0.5 cursor-pointer transition-all duration-200 no-underline ring-1 ring-amber-400/40 shadow-sm hover:scale-105"
                                      title={`${citationTitle}${sourceContext ? `\n${sourceContext}` : ''}\n\nClick to view full citation source`}
                                    >
                                      {num}
                                    </span>
                                  </span>
                                );
                              }
                              return <a {...props} className="text-blue-400 hover:underline" />;
                            }
                          }}
                        >
                          {getRenderableMessageText(msg)}
                        </Markdown>
                      </div>

                      {/* Message Actions */}
                      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/5">
                        <button
                          onClick={() => handleCopyMessageText(msg.text)}
                          className="p-1.5 text-[var(--text-dim)] hover:text-[var(--text-color)] transition-colors rounded-md hover:bg-[var(--panel-hover)]"
                          title="Copy"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => void handleRegenerateModelMessage(msg.id, 'try_again')}
                          disabled={!canRegenerateThisMessage || isLoading}
                          className={`p-1.5 transition-colors rounded-md ${canRegenerateThisMessage && !isLoading ? 'text-[var(--text-dim)] hover:text-blue-400 hover:bg-[var(--panel-hover)]' : 'text-[var(--text-dim)]/50 cursor-not-allowed'}`}
                          title={canRegenerateThisMessage ? 'Refresh output' : 'Only the latest response can be regenerated'}
                        >
                          {isRegeneratingThisMessage ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          onClick={(event) => handleOpenResponseActionMenu(event, msg.id)}
                          disabled={!canRegenerateThisMessage || isLoading}
                          className={`p-1.5 transition-colors rounded-md ${canRegenerateThisMessage && !isLoading ? 'text-[var(--text-dim)] hover:text-[var(--text-color)] hover:bg-[var(--panel-hover)]' : 'text-[var(--text-dim)]/50 cursor-not-allowed'}`}
                          title="More response actions"
                        >
                          <MoreVertical className="w-3.5 h-3.5" />
                        </button>
                        <div className="w-px h-3 bg-[var(--border-color)] mx-1"></div>
                        <button
                          onClick={() => handleMessageFeedback(msg.id, 'like')}
                          className={`p-1.5 transition-colors rounded-md ${messageFeedback[msg.id] === 'like' ? 'text-emerald-400 bg-emerald-500/10 ring-1 ring-emerald-500/30' : 'text-[var(--text-dim)] hover:text-emerald-400 hover:bg-[var(--panel-hover)]'}`}
                          title="Like"
                        >
                          <ThumbsUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleMessageFeedback(msg.id, 'dislike')}
                          className={`p-1.5 transition-colors rounded-md ${messageFeedback[msg.id] === 'dislike' ? 'text-red-400 bg-red-500/10 ring-1 ring-red-500/30' : 'text-[var(--text-dim)] hover:text-red-400 hover:bg-[var(--panel-hover)]'}`}
                          title="Dislike"
                        >
                          <ThumbsDown className="w-3.5 h-3.5" />
                        </button>
                        <div className="w-px h-3 bg-white/10 mx-1"></div>
                        {selectedNoteId ? (
                          <button
                            onClick={() => {
                              const note = notes.find(n => n.id === selectedNoteId);
                              if (note) {
                                updateNote(note.id, note.title, note.content + '\n\n' + msg.text);
                                showToast('Appended to active note', 'info');
                              }
                            }}
                            className="p-1.5 flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-dim)] hover:text-emerald-400 transition-colors rounded-md hover:bg-[var(--panel-hover)]"
                            title="Append to active note"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            Append to Note
                          </button>
                        ) : null}
                        <button
                          onClick={() => addNote(msg.text)}
                          className="p-1.5 flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-dim)] hover:text-blue-400 transition-colors rounded-md hover:bg-[var(--panel-hover)]"
                          title="Save as new Note"
                        >
                          <Pin className="w-3.5 h-3.5" />
                          Save Note
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            );
            })
          )}

          {isLoading && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex gap-4 max-w-4xl mx-auto w-full"
            >
              <div className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-[12px] font-semibold bg-gradient-to-br from-blue-500/50 to-indigo-600/50 text-white shadow-md shadow-blue-500/10">
                <Sparkles className="w-4.5 h-4.5 opacity-50 block animate-pulse" />
              </div>
              <div className="flex flex-col justify-center pt-1">
                <div className="text-[14px] leading-[1.6] text-blue-400 flex items-center gap-2 font-medium bg-blue-500/10 px-4 py-2 rounded-2xl rounded-tl-sm ring-1 ring-blue-500/20">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                  <span>Thinking...</span>
                </div>
              </div>
            </motion.div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="shrink-0 w-full relative z-20 bg-[var(--panel-color)] transition-colors duration-300">
          <div className="absolute bottom-full left-0 w-full h-16 bg-gradient-to-t from-[var(--panel-color)] to-transparent pointer-events-none transition-all duration-300"></div>
          <div className={`px-4 sm:px-6 pb-6 lg:pb-8 ${hasUserMessages ? 'pt-2' : 'pt-4'}`}>
            <div className="max-w-4xl mx-auto relative drop-shadow-[0_0_30px_rgba(0,0,0,0.8)]">
            {/* Drag Overlay */}
            <AnimatePresence>
              {isInputDragging && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 z-50 bg-[#131314]/90 backdrop-blur-md border-2 border-dashed border-blue-500 rounded-3xl flex flex-col items-center justify-center text-blue-400 pointer-events-none ring-4 ring-blue-500/20"
                >
                  <Upload className="w-10 h-10 mb-3 animate-bounce shadow-blue-500" />
                  <span className="font-semibold tracking-tight text-lg">Drop files to attach</span>
                </motion.div>
              )}
            </AnimatePresence>

            <div
              className={`w-full bg-[var(--bg-color)]/95 backdrop-blur-2xl border ${isInputDragging ? 'border-blue-500/50 ring-2 ring-blue-500/20' : 'border-[var(--border-color)]'} rounded-[2rem] p-3.5 flex flex-col relative focus-within:border-blue-500/30 transition-all shadow-2xl ring-1 ring-white/5 mx-auto duration-300 ${hasUserMessages ? '' : 'max-w-5xl'}`}
              onDragOver={handleInputDragOver}
              onDragLeave={handleInputDragLeave}
              onDrop={handleInputDrop}
            >
              {/* File Chips */}
              {attachedFiles.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2 px-3 pt-1">
                  {attachedFiles.map((doc) => (
                    <div key={`attached-${doc.id}`} className="flex items-center gap-3 bg-[var(--panel-color)] border border-[var(--border-color)] rounded-2xl p-3 pr-10 relative group/chip min-w-[220px] max-w-[320px] shadow-sm transform transition-all hover:border-blue-500/30 duration-300">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-[var(--bg-color)]`}>
                        {getFileIcon(doc.mimeType, "w-5 h-5")}
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-[13.5px] font-bold text-slate-100 truncate leading-tight">{doc.name}</span>
                        <span className="text-[11px] font-semibold text-slate-500 mt-1 uppercase tracking-tight">
                          {doc.mimeType === 'application/pdf' ? 'PDF' : doc.mimeType.startsWith('audio/') ? 'Audio' : 'Document'}
                        </span>
                      </div>
                      <button
                        onClick={() => removeAttachedFile(doc.id)}
                        className="absolute top-3 right-3 w-5 h-5 bg-white text-black rounded-full flex items-center justify-center transition-transform hover:scale-110 shadow-lg cursor-pointer"
                        title="Remove attachment"
                      >
                        <X className="w-3.5 h-3.5 stroke-[3]" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {editingMessageId && (
                <div className="px-3 pb-1 pt-1 text-[12px] text-blue-300 font-medium">
                  Editing message
                </div>
              )}

              <div className="flex items-end relative gap-2 pl-2">
                {!editingMessageId && (
                  <button
                    onClick={() => inputFileInputRef.current?.click()}
                    className="p-2.5 mb-1.5 text-slate-400 hover:text-white transition-colors shrink-0 bg-white/5 hover:bg-white/10 rounded-full"
                    title="Attach File"
                  >
                    <Plus className="w-5 h-5" />
                  </button>
                )}
                <input
                  type="file"
                  ref={inputFileInputRef}
                  onChange={handleInputFileUpload}
                  className="hidden"
                  multiple
                  accept=".pdf,.txt"
                />
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={editingMessageId ? 'Edit message...' : (hasUserMessages ? "Ask anything" : "Ask your first question...")}
                  disabled={isLoading}
                  className={`w-full bg-transparent border-none focus:outline-none focus:ring-0 resize-none text-[15px] leading-relaxed text-slate-100 placeholder-slate-500 disabled:opacity-50 disabled:cursor-not-allowed py-3 mt-1 min-h-[44px] max-h-[200px] ${editingMessageId ? 'pr-2' : 'pr-14'}`}
                  rows={1}
                />
                {!editingMessageId && (
                  <button
                    onClick={handleSendMessage}
                    disabled={(!input.trim() && attachedFiles.length === 0) || isLoading}
                    className="absolute right-2 bottom-2 p-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-full disabled:opacity-50 disabled:bg-[#333] disabled:text-slate-500 transition-all shadow-md active:scale-95"
                  >
                    <Send className="w-4.5 h-4.5 -ml-0.5" />
                  </button>
                )}
              </div>

              {editingMessageId && (
                <div className="flex items-center justify-end gap-2 mt-2 pr-2">
                  <button
                    onClick={handleCancelComposerEdit}
                    className="px-3.5 py-1.5 rounded-full text-[13px] font-medium border border-[var(--border-color)] text-[var(--text-dim)] hover:text-[var(--text-color)] hover:bg-[var(--panel-hover)] transition-colors"
                    title="Cancel edit"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSubmitComposerEdit}
                    disabled={(!input.trim() && attachedFiles.length === 0) || isLoading}
                    className="px-3.5 py-1.5 rounded-full text-[13px] font-semibold bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:bg-[#333] disabled:text-slate-500 transition-colors"
                    title="Send edited message"
                  >
                    Send
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      </div>

      {/* Right Sidebar: Notes Overlay for mobile */}
      {isNotesOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-md"
          onClick={() => setIsNotesOpen(false)}
        />
      )}

      {/* Right Sidebar: Notes */}
      <AnimatePresence>
        {isNotesOpen && (
          <motion.div
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed inset-y-0 right-0 md:relative w-[85%] sm:w-[400px] h-full bg-[var(--bg-color)]/95 backdrop-blur-3xl border-l border-[var(--border-color)] flex flex-col z-50 md:z-10 shrink-0 shadow-2xl md:shadow-none transition-colors duration-300"
          >
            <div className="flex items-center justify-between p-5 border-b border-[#333]/40 shrink-0 w-full">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setRightPanelTab('notes')}
                  className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors ${rightPanelTab === 'notes' ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent'}`}
                >
                  Notes
                </button>
                <button
                  onClick={() => setRightPanelTab('configure')}
                  className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors ${rightPanelTab === 'configure' ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent'}`}
                >
                  Configure Chat
                </button>
                <button
                  onClick={() => setRightPanelTab('history')}
                  className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors ${rightPanelTab === 'history' ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent'}`}
                >
                  Chat History
                </button>
              </div>
              <div className="flex items-center gap-1">
                {rightPanelTab === 'notes' && (
                  <>
                    <button
                      onClick={() => setNoteSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                      className="p-2 bg-[var(--panel-color)] hover:bg-[var(--panel-hover)] ring-1 ring-white/5 shadow-sm rounded-lg transition-colors text-slate-300 hover:text-white"
                      title={`Sort by date: ${noteSortOrder === 'asc' ? 'Oldest first' : 'Newest first'}`}
                    >
                      {noteSortOrder === 'asc' ? <ArrowUp className="w-4 h-4" /> : <ArrowDown className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => addNote('')}
                      className="p-2 bg-[var(--panel-color)] hover:bg-[var(--panel-hover)] ring-1 ring-white/5 shadow-sm rounded-lg transition-colors text-slate-300 hover:text-white"
                      aria-label="New Note"
                      title="New Note"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </>
                )}
                {rightPanelTab === 'history' && (
                  <button
                    onClick={() => void handleStartNewChat()}
                    className="p-2 bg-[var(--panel-color)] hover:bg-[var(--panel-hover)] ring-1 ring-white/5 shadow-sm rounded-lg transition-colors text-slate-300 hover:text-white"
                    aria-label="Start New Chat"
                    title="Start New Chat"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={() => setIsNotesOpen(false)}
                  className="md:hidden p-2 hover:bg-white/10 rounded-full transition-colors text-slate-400 hover:text-white ml-2 bg-white/5 border border-white/5"
                  aria-label="Close Notes"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className={`flex-1 overflow-y-auto w-full custom-scrollbar pt-2 pb-6 px-4 ${rightPanelTab === 'notes' ? '' : 'hidden'}`}>
              <div className="relative mb-5 group">
                <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-dim)] group-focus-within:text-blue-500 transition-colors" />
                <input
                  type="text"
                  value={noteSearchQuery}
                  onChange={(e) => setNoteSearchQuery(e.target.value)}
                  placeholder="Search notes..."
                  className="w-full bg-[var(--input-bg)] border border-[var(--border-color)] focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 rounded-xl pl-10 pr-4 py-2 text-[13px] text-[var(--text-color)] placeholder-[var(--text-dim)] outline-none transition-all shadow-inner"
                />
              </div>

              {notes.length === 0 ? (
                <div className="text-center text-slate-500 text-[13px] mt-16 px-4">
                  <div className="w-16 h-16 rounded-full bg-[#131314] ring-1 ring-white/5 flex items-center justify-center mx-auto mb-4 shadow-inner">
                    <Pin className="w-8 h-8 text-slate-400 opacity-50" />
                  </div>
                  <h3 className="text-slate-300 font-medium text-[15px] mb-2 tracking-tight">No notes yet</h3>
                  <p className="leading-relaxed">Pin AI responses or create a new note to start saving important info.</p>
                </div>
              ) : notes.filter(n => !noteSearchQuery || n.title.toLowerCase().includes(noteSearchQuery.toLowerCase()) || n.content.toLowerCase().includes(noteSearchQuery.toLowerCase())).length === 0 ? (
                 <div className="text-center text-slate-500 text-[14px] mt-16">
                  <p>No notes found matching "<span className="text-slate-300">{noteSearchQuery}</span>".</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <AnimatePresence>
                    {notes
                      .filter(n => !noteSearchQuery || n.title.toLowerCase().includes(noteSearchQuery.toLowerCase()) || n.content.toLowerCase().includes(noteSearchQuery.toLowerCase()))
                      .sort((a, b) => noteSortOrder === 'asc' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp)
                      .map((note) => (
                      <motion.div
                        key={note.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        draggable
                        onDragStart={(e: any) => {
                          e.dataTransfer.setData('text/plain', note.content);
                        }}
                        onClick={() => { setSelectedNoteId(note.id); setIsNotePreviewMode(true); }}
                        className="bg-[#131314] border border-[#333]/50 rounded-xl flex flex-col shadow-sm group cursor-pointer hover:border-amber-500/30 hover:shadow-[0_0_15px_rgba(245,158,11,0.05)] transition-all"
                      >
                        <div className="flex items-center justify-between px-4 py-3.5">
                          <div className="flex flex-col overflow-hidden gap-1">
                            <span className="text-[14px] text-slate-200 font-medium truncate tracking-tight [&_p]:inline [&_p]:m-0 [&_strong]:font-bold [&_em]:italic" title={note.title}>
                              {note.title ? (
                                <Markdown
                                  remarkPlugins={[remarkGfm]}
                                  rehypePlugins={[rehypeSanitize]}
                                  components={{
                                    p: ({ node, ...props }) => <span {...props} />,
                                  }}
                                >
                                  {note.title}
                                </Markdown>
                              ) : "Untitled Note"}
                            </span>
                            <span className="text-[11px] text-slate-500 font-medium flex items-center gap-1.5 uppercase tracking-wider">
                              <Pin className="w-3 h-3" />
                              {new Date(note.timestamp).toLocaleDateString()}
                            </span>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              setNoteMenuOptions({ id: note.id, x: rect.right, y: rect.bottom });
                            }}
                            className="bg-[#1e1e20] text-slate-400 hover:text-slate-200 ring-1 ring-[#333] hover:ring-white/20 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all p-1.5 rounded-lg shrink-0 ml-3"
                            title="Note Options"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </div>

            <div className={`${rightPanelTab === 'configure' ? 'flex-1' : 'hidden'} overflow-y-auto w-full custom-scrollbar p-5`}>
              <div className="rounded-2xl border border-[#333]/60 bg-[#131314]/60 p-5 space-y-6">
                <div>
                  <h3 className="text-[18px] font-semibold text-slate-100 tracking-tight">Configure Chat</h3>
                  <p className="mt-2 text-[13px] text-slate-400 leading-relaxed">
                    Customize this chat session for different goals and response depth. Changes apply immediately.
                  </p>
                </div>

                <div className="space-y-3">
                  <p className="text-[13px] font-semibold text-slate-200">Define your conversational goal</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => updateActiveChatConfig({ goalMode: 'default' })}
                      className={`px-3.5 py-2 rounded-full text-[13px] font-semibold transition-colors border ${activeChatConfig.goalMode === 'default' ? 'bg-blue-600 text-white border-blue-500 shadow-[0_0_12px_rgba(37,99,235,0.25)]' : 'bg-transparent text-slate-300 border-[#333] hover:border-[#444] hover:bg-white/5'}`}
                    >
                      Default
                    </button>
                    <button
                      onClick={() => updateActiveChatConfig({ goalMode: 'learning-guide' })}
                      className={`px-3.5 py-2 rounded-full text-[13px] font-semibold transition-colors border ${activeChatConfig.goalMode === 'learning-guide' ? 'bg-blue-600 text-white border-blue-500 shadow-[0_0_12px_rgba(37,99,235,0.25)]' : 'bg-transparent text-slate-300 border-[#333] hover:border-[#444] hover:bg-white/5'}`}
                    >
                      Learning Guide
                    </button>
                  </div>
                  <p className="text-[12px] text-slate-500 leading-relaxed">
                    {activeChatConfig.goalMode === 'learning-guide'
                      ? 'Learning Guide focuses on teaching step-by-step with clear explanations and concept definitions.'
                      : 'Default mode balances direct answers and concise evidence-based explanations.'}
                  </p>
                </div>

                <div className="space-y-3">
                  <p className="text-[13px] font-semibold text-slate-200">Choose your response length</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => updateActiveChatConfig({ responseLength: 'default' })}
                      className={`px-3.5 py-2 rounded-full text-[13px] font-semibold transition-colors border ${activeChatConfig.responseLength === 'default' ? 'bg-blue-600 text-white border-blue-500 shadow-[0_0_12px_rgba(37,99,235,0.25)]' : 'bg-transparent text-slate-300 border-[#333] hover:border-[#444] hover:bg-white/5'}`}
                    >
                      Default
                    </button>
                    <button
                      onClick={() => updateActiveChatConfig({ responseLength: 'longer' })}
                      className={`px-3.5 py-2 rounded-full text-[13px] font-semibold transition-colors border ${activeChatConfig.responseLength === 'longer' ? 'bg-blue-600 text-white border-blue-500 shadow-[0_0_12px_rgba(37,99,235,0.25)]' : 'bg-transparent text-slate-300 border-[#333] hover:border-[#444] hover:bg-white/5'}`}
                    >
                      Longer
                    </button>
                    <button
                      onClick={() => updateActiveChatConfig({ responseLength: 'shorter' })}
                      className={`px-3.5 py-2 rounded-full text-[13px] font-semibold transition-colors border ${activeChatConfig.responseLength === 'shorter' ? 'bg-blue-600 text-white border-blue-500 shadow-[0_0_12px_rgba(37,99,235,0.25)]' : 'bg-transparent text-slate-300 border-[#333] hover:border-[#444] hover:bg-white/5'}`}
                    >
                      Shorter
                    </button>
                  </div>
                  <p className="text-[12px] text-slate-500 leading-relaxed">
                    {activeChatConfig.responseLength === 'longer'
                      ? 'Longer responses prioritize additional context and deeper explanation when supported by the sources.'
                      : activeChatConfig.responseLength === 'shorter'
                        ? 'Shorter responses prioritize brevity and quick direct answers.'
                        : 'Default response length provides balanced detail.'}
                  </p>
                </div>

                <div className="pt-2 border-t border-[#333]/60">
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    These preferences are saved per chat session on this browser and are applied immediately to new prompts.
                  </p>
                </div>
              </div>
            </div>

            <div className={`${rightPanelTab === 'history' ? 'flex-1' : 'hidden'} overflow-y-auto w-full custom-scrollbar p-5`}>
              <div className="rounded-2xl border border-[#333]/60 bg-[#131314]/60 p-5">
                <h3 className="text-[18px] font-semibold text-slate-100 tracking-tight">Chat History</h3>
                <p className="mt-2 text-[13px] text-slate-400 leading-relaxed">
                  Select a conversation to reopen it, or start a new chat.
                </p>

                {chatSessions.length === 0 ? (
                  <div className="mt-5 px-4 py-3 rounded-xl border border-[#333] bg-[#171718] text-[12px] text-slate-500">
                    No saved chats yet.
                  </div>
                ) : (
                  <div className="mt-5 space-y-2 max-h-[420px] overflow-y-auto custom-scrollbar pr-1">
                    {chatSessions.map((session) => {
                      const isActive = session.id === activeChatSessionId;

                      return (
                        <button
                          key={session.id}
                          onClick={() => void handleOpenChatSession(session.id)}
                          className={`w-full text-left px-3 py-2.5 rounded-xl border transition-colors ${
                            isActive
                              ? 'border-blue-500/40 bg-blue-500/10 text-slate-100'
                              : 'border-[#333] bg-[#171718] text-slate-300 hover:border-[#444] hover:bg-[#1e1e20]'
                          }`}
                        >
                          <div className="text-[13px] font-medium truncate">{session.title}</div>
                          <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
                            <span>{formatDateTime(session.updatedAt)}</span>
                            <span className={isActive ? 'text-blue-300' : 'text-slate-500'}>{isActive ? 'Active' : 'Open'}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                <button
                  onClick={() => void handleStartNewChat()}
                  className="mt-5 px-5 py-2.5 rounded-xl text-[13px] font-medium border border-[#333] text-slate-200 hover:bg-[#2a2a2d] transition-colors"
                >
                  Start New Chat
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Note Options Popover */}
      <AnimatePresence>
        {noteMenuOptions && (
          <>
            <div className="fixed inset-0 z-[100]" onClick={() => setNoteMenuOptions(null)} />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: -5 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -5 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="fixed z-[101] bg-[#1e1e20]/95 backdrop-blur-2xl border border-[#333] rounded-xl shadow-[0_16px_40px_rgba(0,0,0,0.8)] overflow-hidden py-2 flex flex-col w-52 ring-1 ring-white/10"
              style={{ top: noteMenuOptions.y + 6, left: Math.min(noteMenuOptions.x - 208, typeof window !== 'undefined' ? window.innerWidth - 220 : noteMenuOptions.x - 208) }}
            >
              <div className="px-4 py-2 border-b border-[#333]/50 mb-1 flex items-center justify-between">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Options</span>
                <button onClick={() => setNoteMenuOptions(null)} className="text-slate-500 hover:text-slate-300">
                  <X className="w-3 h-3" />
                </button>
              </div>
              <button
                onClick={() => {
                  setSelectedNoteId(noteMenuOptions.id);
                  setIsNotePreviewMode(false);
                  setNoteMenuOptions(null);
                }}
                className="w-full text-left px-4 py-2.5 text-[13px] font-medium text-slate-200 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-3"
              >
                <Edit2 className="w-4 h-4 text-slate-400" /> Edit Note
              </button>
              <button
                onClick={() => {
                  const note = notes.find(n => n.id === noteMenuOptions.id);
                  if (note) convertNoteToSource(note);
                  setNoteMenuOptions(null);
                }}
                className="w-full text-left px-4 py-2.5 text-[13px] font-medium text-slate-200 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-3"
              >
                <FileText className="w-4 h-4 text-slate-400" /> Convert to Source
              </button>
              <div className="mx-3 my-1.5 h-px bg-[#333]/50" />
              <button
                onClick={() => {
                  removeNote(noteMenuOptions.id);
                  setNoteMenuOptions(null);
                }}
                className="w-full text-left px-4 py-2.5 text-[13px] font-medium text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-3 group"
              >
                <Trash2 className="w-4 h-4 text-red-500/70 group-hover:text-red-400" /> Delete Note
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Response Action Popover */}
      <AnimatePresence>
        {responseMenuOptions && (
          <>
            <div className="fixed inset-0 z-[100]" onClick={closeResponseActionMenu} />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: -5 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -5 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="fixed z-[101] pointer-events-auto bg-[#1e1e20]/95 backdrop-blur-2xl border border-[#333] rounded-xl shadow-[0_16px_40px_rgba(0,0,0,0.8)] overflow-visible py-2 flex flex-col w-80 ring-1 ring-white/10"
              style={{ top: responseMenuOptions.y, left: responseMenuOptions.x }}
            >
              <div className="px-4 py-2 border-b border-[#333]/50 mb-1 flex items-center justify-between">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Response Actions</span>
                <button onClick={closeResponseActionMenu} className="text-slate-500 hover:text-slate-300">
                  <X className="w-3 h-3" />
                </button>
              </div>

              <div className="px-4 py-2 border-b border-[#333]/50">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Model</div>
                <div className="text-[12px] text-slate-300 truncate mb-2" title={getSelectedModelDescriptor(responseMenuSelectedModel)}>
                  {getSelectedModelDescriptor(responseMenuSelectedModel)}
                </div>
                {getActiveModelSelectionOptions().length > 0 ? (
                  <div className="relative">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setIsResponseModelDropdownOpen((prev) => !prev);
                      }}
                      className="w-full bg-[#0a0a0b] border border-[#2a2a2d] rounded-lg px-2.5 py-2 text-[12px] text-slate-200 focus:outline-none focus:border-[#444] flex items-center justify-between gap-2"
                    >
                      <span className="truncate text-left">{responseMenuSelectedModel || getActiveSelectedModel() || 'Select model'}</span>
                      <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${isResponseModelDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {isResponseModelDropdownOpen && (
                      <div className="absolute left-0 right-0 mt-1 z-[120] max-h-56 overflow-y-auto rounded-lg border border-[#333] bg-[#0a0a0b] shadow-[0_16px_40px_rgba(0,0,0,0.8)] custom-scrollbar">
                        {getActiveModelSelectionOptions().map((model) => {
                          const isSelected = model === (responseMenuSelectedModel || getActiveSelectedModel());
                          return (
                            <button
                              key={`response-model-${model}`}
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setResponseMenuSelectedModel(model);
                                setIsResponseModelDropdownOpen(false);
                              }}
                              className={`w-full text-left px-3 py-2 text-[12px] transition-colors flex items-center justify-between gap-2 ${isSelected ? 'bg-blue-600 text-white' : 'text-slate-200 hover:bg-white/10 hover:text-white'}`}
                              title={model}
                            >
                              <span className="truncate">{model}</span>
                              {isSelected ? <Check className="w-3.5 h-3.5 shrink-0" /> : null}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-[11px] text-slate-500">No model list available. Configure a model in Settings.</div>
                )}
              </div>

              <button
                onClick={() => void handleRegenerateModelMessage(responseMenuOptions.messageId, 'try_again', responseMenuSelectedModel || undefined)}
                disabled={!canRegenerateModelMessage(responseMenuOptions.messageId) || isLoading}
                className={`w-full text-left px-4 py-2.5 text-[13px] font-medium transition-colors flex items-center gap-3 ${canRegenerateModelMessage(responseMenuOptions.messageId) && !isLoading ? 'text-slate-200 hover:bg-white/10 hover:text-white' : 'text-slate-500 cursor-not-allowed'}`}
              >
                <RotateCcw className="w-4 h-4" />
                Try again
              </button>
              <button
                onClick={() => void handleRegenerateModelMessage(responseMenuOptions.messageId, 'think_longer', responseMenuSelectedModel || undefined)}
                disabled={!canRegenerateModelMessage(responseMenuOptions.messageId) || isLoading}
                className={`w-full text-left px-4 py-2.5 text-[13px] font-medium transition-colors flex items-center gap-3 ${canRegenerateModelMessage(responseMenuOptions.messageId) && !isLoading ? 'text-slate-200 hover:bg-white/10 hover:text-white' : 'text-slate-500 cursor-not-allowed'}`}
              >
                <Sparkles className="w-4 h-4" />
                Think longer
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Note Modal */}
      <AnimatePresence>
        {selectedNoteId && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-xl"
              onClick={() => setSelectedNoteId(null)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
              className="relative w-full max-w-3xl bg-[#0a0a0b]/95 border border-[#333]/50 rounded-3xl shadow-[0_0_80px_rgba(0,0,0,0.8)] overflow-hidden flex flex-col h-[75vh]"
            >
              {(() => {
                const note = notes.find(n => n.id === selectedNoteId);
                if (!note) return null;
                return (
                  <>
                    <div className="flex items-center justify-between p-5 border-b border-[#333]/40 bg-[#131314]/80 backdrop-blur-md shrink-0">
                        <input
                          type="text"
                          value={note.title}
                          onChange={(e) => updateNote(note.id, e.target.value, note.content)}
                          className="text-2xl font-bold tracking-tight text-slate-100 bg-transparent border-none focus:outline-none focus:ring-0 w-full mr-4 placeholder:text-slate-600 truncate flex-1"
                          placeholder="Untitled Note"
                        />
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => setIsNotePreviewMode(!isNotePreviewMode)}
                            className={`px-4 py-2 rounded-xl text-[13px] font-medium transition-colors border ${isNotePreviewMode ? 'bg-amber-500/10 text-amber-500 border-amber-500/20 hover:bg-amber-500 hover:text-white' : 'bg-[#2a2a2d] text-slate-300 border-[#444] hover:bg-[#333]'}`}
                          >
                            {isNotePreviewMode ? 'Edit Note' : 'Preview'}
                          </button>
                          <div className="w-px h-6 bg-[#333] mx-1"></div>
                          <button
                            onClick={() => setSelectedNoteId(null)}
                            className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-full transition-colors shrink-0 bg-white/5 border border-white/5"
                          >
                            <X className="w-5 h-5" />
                          </button>
                        </div>
                      </div>
                      <div className="flex-1 overflow-y-auto bg-transparent relative">
                        {isNotePreviewMode ? (
                          <div className="p-8 prose prose-sm sm:prose-base prose-invert max-w-none text-slate-300 leading-relaxed font-sans
                            prose-p:text-slate-300 prose-p:leading-relaxed
                            prose-headings:text-slate-100 prose-headings:font-bold
                            prose-a:text-amber-500 flex-1 h-full prose-code:text-teal-300 prose-pre:bg-[#131314] prose-pre:border prose-pre:border-[#333]
                            prose-li:text-slate-300 prose-blockquote:text-slate-400 prose-blockquote:border-l-amber-500 prose-blockquote:bg-amber-500/5 prose-blockquote:py-1 prose-blockquote:px-4 prose-blockquote:rounded-r-lg"
                            onDoubleClick={() => setIsNotePreviewMode(false)}
                            title="Double-click to edit"
                          >
                            <Markdown
                              remarkPlugins={[remarkGfm]}
                              rehypePlugins={[rehypeSanitize]}
                              components={{
                                a: ({ node, ...props }) => {
                                  if (props.href?.startsWith('#cite-')) {
                                    const num = props.href.replace('#cite-', '');
                                    const snippet = props.title || "Source snippet not available.";
                                    const docName = `Source Document ${num}`;
                                    const citationTitle = toCitationTitleFromSnippet(snippet, num);
                                    const sourceContext = getCitationSourceContext(docName);

                                    return (
                                      <span className="relative inline-block align-middle z-10 hover:z-50">
                                        <span
                                          onClick={() => openCitationDetailsModal({
                                            number: num,
                                            snippet,
                                            documentName: citationTitle,
                                            sourceContext,
                                          })}
                                          className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 rounded-full bg-gradient-to-br from-amber-500/20 to-orange-500/20 text-amber-300 hover:from-amber-500 hover:to-orange-500 hover:text-white text-[10px] font-extrabold tracking-wide mx-0.5 cursor-pointer transition-all duration-200 no-underline ring-1 ring-amber-400/40 shadow-sm hover:scale-105"
                                          title={`${citationTitle}${sourceContext ? `\n${sourceContext}` : ''}\n\nClick to view full citation source`}
                                        >
                                          {num}
                                        </span>
                                      </span>
                                    );
                                  }
                                  return <a {...props} className="text-amber-400 hover:underline" />;
                                }
                              }}
                            >
                              {note.content || "*Empty note*"}
                            </Markdown>
                          </div>
                        ) : (
                          <textarea
                            value={note.content}
                            onChange={(e) => updateNote(note.id, note.title, e.target.value)}
                            onKeyDown={(e) => {
                              // Save/Exit edit on Ctrl+Enter
                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                e.preventDefault();
                                setIsNotePreviewMode(true);
                              }
                            }}
                            className="absolute inset-0 p-8 w-full h-full bg-transparent border-none focus:outline-none focus:ring-0 resize-none text-[15px] leading-[1.7] text-slate-300 placeholder-slate-600 custom-scrollbar font-sans"
                            placeholder="Start writing... (Markdown supported)"
                            autoFocus
                          />
                        )}
                      </div>
                    <div className="p-4 border-t border-[#333]/40 bg-[#131314]/80 backdrop-blur-md flex justify-between items-center shrink-0">
                      <div className="flex items-center gap-4">
                        <button
                          onClick={() => convertNoteToSource(note)}
                          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-900/20 px-4 py-2.5 rounded-xl text-[14px] font-medium transition-all active:scale-95"
                        >
                          <FileText className="w-4 h-4" /> Convert to Source
                        </button>
                        <span className="text-[13px] font-medium text-slate-400 flex items-center gap-2">
                          {noteSaveStatus === 'Saving...' ? (
                            <><Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" /> Saving...</>
                          ) : (
                            <><CheckSquare className="w-3.5 h-3.5 text-emerald-500" /> Saved</>
                          )}
                        </span>
                      </div>
                      <button
                        onClick={() => setSelectedNoteId(null)}
                        className="bg-[#1e1e20] text-slate-200 border border-[#333] hover:border-[#444] px-5 py-2.5 rounded-xl text-[14px] font-medium hover:bg-[#2a2a2d] transition-all shadow-sm ring-1 ring-white/5"
                      >
                        Done
                      </button>
                    </div>
                  </>
                );
              })()}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Settings Modal */}
      <AnimatePresence>
        {isSettingsOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setIsSettingsOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="relative w-full max-w-4xl bg-[var(--panel-color)]/95 backdrop-blur-3xl border border-[var(--border-color)] rounded-3xl shadow-[0_0_80px_rgba(0,0,0,0.8)] overflow-hidden flex flex-col max-h-[85vh] ring-1 ring-white/5 transition-colors duration-300"
            >
              <div className="flex items-center justify-between p-6 pl-8 border-b border-[var(--border-color)] bg-transparent">
                <h2 className="text-xl font-semibold text-[var(--text-color)] tracking-tight">Settings</h2>
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="p-2 text-[var(--text-dim)] hover:text-[var(--text-color)] hover:bg-[var(--panel-hover)] rounded-full transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex flex-1 overflow-hidden">
                {/* Settings Sidebar */}
                <div className="w-[240px] border-r border-[var(--border-color)] p-5 flex flex-col gap-2 bg-[var(--bg-color)]/50 transition-colors duration-300">
                  <button
                    onClick={() => setActiveSettingsTab('account')}
                    className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-[14px] font-medium transition-all ${activeSettingsTab === 'account' ? 'bg-[var(--panel-hover)] text-blue-500 shadow-sm ring-1 ring-[var(--border-color)]' : 'text-[var(--text-dim)] hover:text-[var(--text-color)] hover:bg-[var(--panel-hover)]/50'}`}
                  >
                    <User className="w-4 h-4" /> Account
                  </button>
                  <button
                    onClick={() => setActiveSettingsTab('api')}
                    className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-[14px] font-medium transition-all ${activeSettingsTab === 'api' ? 'bg-[var(--panel-hover)] text-blue-500 shadow-sm ring-1 ring-[var(--border-color)]' : 'text-[var(--text-dim)] hover:text-[var(--text-color)] hover:bg-[var(--panel-hover)]/50'}`}
                  >
                    <Database className="w-4 h-4" /> API Configuration
                  </button>
                  <button
                    onClick={() => setActiveSettingsTab('model')}
                    className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-[14px] font-medium transition-all ${activeSettingsTab === 'model' ? 'bg-[var(--panel-hover)] text-blue-500 shadow-sm ring-1 ring-[var(--border-color)]' : 'text-[var(--text-dim)] hover:text-[var(--text-color)] hover:bg-[var(--panel-hover)]/50'}`}
                  >
                    <Cpu className="w-4 h-4" /> Model Settings
                  </button>
                  <button
                    onClick={() => setActiveSettingsTab('data')}
                    className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-[14px] font-medium transition-all ${activeSettingsTab === 'data' ? 'bg-[#1e1e20] text-blue-400 shadow-sm ring-1 ring-[#333]' : 'text-slate-400 hover:text-slate-200 hover:bg-[#1e1e20]/50'}`}
                  >
                    <Trash2 className="w-4 h-4" /> Data & Privacy
                  </button>
                </div>

                {/* Settings Content */}
                <div className="flex-1 p-8 md:p-10 overflow-y-auto bg-[#0a0a0b] custom-scrollbar">
                  {activeSettingsTab === 'account' && (
                    <div className="max-w-2xl animate-fade-in">
                      <h3 className="text-2xl font-bold text-white mb-2 tracking-tight">Account Profile</h3>
                      <p className="text-slate-400 text-[14px] mb-8">Manage your personal information and security settings.</p>

                      <div className="space-y-6">
                        {/* Profile Card */}
                        <div className="bg-[#131314] border border-[#2a2a2d] rounded-2xl p-6 shadow-sm">
                          <h4 className="text-[15px] font-semibold text-slate-200 mb-5 flex items-center gap-2"><User className="w-4 h-4 text-blue-400" /> Personal Details</h4>

                          <div className="space-y-5">
                            <div className="flex flex-col sm:flex-row gap-5">
                              <div className="flex-1">
                                <label className="text-[13px] font-medium text-slate-400 ml-1 mb-2 block">First Name</label>
                                <div className="relative">
                                  <input
                                    type="text"
                                    value={accountFirstName}
                                    onChange={e => setAccountFirstName(e.target.value)}
                                    className="w-full bg-[#0a0a0b] border border-[#2a2a2d] rounded-xl px-4 py-3 text-[14px] text-slate-200 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all shadow-inner"
                                  />
                                </div>
                              </div>
                              <div className="flex-1">
                                <label className="text-[13px] font-medium text-slate-400 ml-1 mb-2 block">Last Name</label>
                                <div className="relative">
                                  <input
                                    type="text"
                                    value={accountLastName}
                                    onChange={e => setAccountLastName(e.target.value)}
                                    className="w-full bg-[#0a0a0b] border border-[#2a2a2d] rounded-xl px-4 py-3 text-[14px] text-slate-200 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all shadow-inner"
                                  />
                                </div>
                              </div>
                            </div>
                            <div>
                              <label className="text-[13px] font-medium text-slate-400 ml-1 mb-2 block">Email Address</label>
                              <div className="relative">
                                <input
                                  type="email"
                                  value={accountEmail}
                                  onChange={e => setAccountEmail(e.target.value)}
                                  className="w-full bg-[#0a0a0b] border border-[#2a2a2d] rounded-xl px-4 py-3 text-[14px] text-slate-200 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all shadow-inner"
                                />
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Password Card */}
                        <div className="bg-[#131314] border border-[#2a2a2d] rounded-2xl p-6 shadow-sm">
                          <h4 className="text-[15px] font-semibold text-slate-200 mb-5 flex items-center gap-2">Security</h4>

                          <div className="space-y-5">
                            <div>
                              <label className="text-[13px] font-medium text-slate-400 ml-1 mb-2 block">New Password <span className="opacity-60 font-normal">(optional)</span></label>
                              <div className="relative">
                                <input
                                  type={showAccountPassword ? 'text' : 'password'}
                                  value={accountPassword}
                                  onChange={e => setAccountPassword(e.target.value)}
                                  placeholder="Leave blank to keep current password"
                                  className="w-full bg-[#0a0a0b] border border-[#2a2a2d] rounded-xl px-4 py-3 pr-11 text-[14px] text-slate-200 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all shadow-inner"
                                />
                                <button
                                  type="button"
                                  onClick={() => setShowAccountPassword((prev) => !prev)}
                                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition-colors"
                                  aria-label={showAccountPassword ? 'Hide password' : 'Show password'}
                                >
                                  {showAccountPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                              </div>

                              <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
                                {accountPasswordRequirements.map((requirement) => {
                                  const hasPasswordInput = accountPassword.length > 0;
                                  const textClass = hasPasswordInput
                                    ? (requirement.valid ? 'text-emerald-400' : 'text-red-400')
                                    : 'text-slate-500';

                                  return (
                                    <div key={requirement.key} className={`flex items-center gap-1.5 text-[12px] ${textClass}`}>
                                      {requirement.valid ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                                      <span>{requirement.label}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>

                            <AnimatePresence>
                              {accountPassword.length > 0 && (
                                <motion.div
                                  initial={{ opacity: 0, height: 0 }}
                                  animate={{ opacity: 1, height: 'auto' }}
                                  exit={{ opacity: 0, height: 0 }}
                                  className="overflow-hidden"
                                >
                                  <div className="pt-2">
                                    <label className="text-[13px] font-medium text-slate-400 ml-1 mb-2 block">Confirm New Password</label>
                                    <div className="relative">
                                      <input
                                        type={showAccountConfirmPassword ? 'text' : 'password'}
                                        value={accountConfirmPassword}
                                        onChange={e => setAccountConfirmPassword(e.target.value)}
                                        placeholder="Confirm new password"
                                        className={`w-full bg-[#0a0a0b] border rounded-xl px-4 py-3 pr-11 text-[14px] text-slate-200 focus:outline-none focus:ring-1 transition-all shadow-inner ${accountConfirmPassword.length > 0 ? (isAccountPasswordConfirmed ? 'border-emerald-500/60 focus:border-emerald-500 focus:ring-emerald-500/30' : 'border-red-500/50 focus:border-red-500 focus:ring-red-500/30') : 'border-[#2a2a2d] focus:border-blue-500 focus:ring-blue-500'}`}
                                      />
                                      <button
                                        type="button"
                                        onClick={() => setShowAccountConfirmPassword((prev) => !prev)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition-colors"
                                        aria-label={showAccountConfirmPassword ? 'Hide confirmation password' : 'Show confirmation password'}
                                      >
                                        {showAccountConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                      </button>
                                    </div>
                                    {accountConfirmPassword.length > 0 && (
                                      <p className={`mt-2 text-[12px] font-medium ${isAccountPasswordConfirmed ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {isAccountPasswordConfirmed ? 'Passwords match.' : 'Passwords do not match.'}
                                      </p>
                                    )}
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        </div>

                        <NotificationInline scope={ACCOUNT_SETTINGS_INLINE_SCOPE} />

                        {/* Save Button */}
                        <div className="flex justify-end pt-2">
                          <button
                            onClick={handleUpdateAccount}
                            disabled={isAccountSaveBlockedByPassword}
                            className="bg-white text-black px-8 py-3 rounded-xl text-[14px] font-medium transition-all hover:bg-slate-200 hover:scale-[1.02] active:scale-[0.98] shadow-[0_0_20px_rgba(255,255,255,0.1)] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:hover:bg-white"
                          >
                            Save Changes
                          </button>
                        </div>

                        {/* Danger Zone */}
                        <div className="mt-12 border border-red-900/30 bg-red-950/20 rounded-2xl p-6 relative overflow-hidden">
                          <div className="absolute top-0 left-0 w-1 h-full bg-red-600/50"></div>
                          <h4 className="text-[15px] font-semibold text-red-400 mb-2">Danger Zone</h4>
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                            <p className="text-[13px] text-slate-400 max-w-sm">Sign out securely from your current device session. You will be redirected to the landing page.</p>
                            <button
                              onClick={() => {
                                setIsSettingsOpen(false);
                                requestSignOutConfirmation();
                              }}
                              className="px-5 py-2.5 bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white border border-red-500/20 hover:border-red-500 rounded-xl text-sm font-medium transition-colors whitespace-nowrap shrink-0"
                            >
                              Sign out securely
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {activeSettingsTab === 'api' && (
                    <div className="space-y-8">
                      <div>
                        <h3 className="text-[16px] font-semibold text-slate-200 mb-4">API Provider Strategy</h3>
                        <div className="grid grid-cols-2 gap-4 mb-6">
                          <button
                            onClick={() => {
                              if (apiProvider === 'local') setApiProvider('gemini');
                              setIsProviderDropdownOpen(false);
                              setIsModelDropdownOpen(false);
                            }}
                            className={`flex items-center gap-3 p-4 rounded-xl border text-left transition-all relative overflow-hidden ${apiProvider !== 'local' ? 'border-blue-500 bg-blue-500/10' : 'border-[#333] hover:border-[#444] bg-[#131314]'}`}
                          >
                            <div className={`flex items-center justify-center w-5 h-5 rounded-full border ${apiProvider !== 'local' ? 'border-blue-500' : 'border-[#444]'}`}>
                              {apiProvider !== 'local' && <div className="w-2.5 h-2.5 bg-blue-500 rounded-full" />}
                            </div>
                            <div>
                              <span className={`block text-[14px] font-medium ${apiProvider !== 'local' ? 'text-blue-400' : 'text-slate-300'}`}>Cloud Services</span>
                              <span className="block text-[12px] text-slate-500 mt-0.5">Use remote models via API Key</span>
                            </div>
                          </button>

                          <button
                            onClick={() => {
                              setApiProvider('local');
                              setIsProviderDropdownOpen(false);
                              setIsModelDropdownOpen(false);
                            }}
                            className={`flex items-center gap-3 p-4 rounded-xl border text-left transition-all relative overflow-hidden ${apiProvider === 'local' ? 'border-blue-500 bg-blue-500/10' : 'border-[#333] hover:border-[#444] bg-[#131314]'}`}
                          >
                            <div className={`flex items-center justify-center w-5 h-5 rounded-full border ${apiProvider === 'local' ? 'border-blue-500' : 'border-[#444]'}`}>
                              {apiProvider === 'local' && <div className="w-2.5 h-2.5 bg-blue-500 rounded-full" />}
                            </div>
                            <div>
                              <span className={`block text-[14px] font-medium ${apiProvider === 'local' ? 'text-blue-400' : 'text-slate-300'}`}>Local LLM</span>
                              <span className="block text-[12px] text-slate-500 mt-0.5">Run lightweight models locally</span>
                            </div>
                          </button>
                        </div>
                      </div>

                      {apiProvider !== 'local' ? (
                        <div className="pt-6 border-t border-[#333]">
                          <div className="mb-6">
                            <label className="block text-[14px] font-medium text-slate-300 mb-2">Select Cloud Provider</label>
                            <div className="relative max-w-sm">
                              <button
                                onClick={() => {
                                  setIsProviderDropdownOpen(!isProviderDropdownOpen);
                                  setIsModelDropdownOpen(false);
                                }}
                                className={`w-full bg-[#0a0a0b] border ${isProviderDropdownOpen ? 'border-[#444] ring-1 ring-[#444]' : 'border-[#2a2a2d]'} rounded-xl px-4 py-3 text-[14px] transition-all text-slate-200 flex items-center justify-between shadow-inner`}
                              >
                                <span>
                                  {apiProvider === 'gemini' && 'Google Gemini'}
                                  {apiProvider === 'openai' && 'OpenAI (ChatGPT)'}
                                  {apiProvider === 'openai_compatible' && 'OpenAI-compatible (Custom)'}
                                  {apiProvider === 'openrouter' && 'OpenRouter'}
                                  {apiProvider === 'anthropic' && 'Anthropic (Claude)'}
                                  {apiProvider === 'cerebras' && 'Cerebras'}
                                </span>
                                <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isProviderDropdownOpen ? 'rotate-180' : ''}`} />
                              </button>

                              <AnimatePresence>
                                {isProviderDropdownOpen && (
                                  <>
                                    <div className="fixed inset-0 z-40" onClick={() => setIsProviderDropdownOpen(false)} />
                                    <motion.div
                                      initial={{ opacity: 0, y: -5 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      exit={{ opacity: 0, y: -5 }}
                                      transition={{ duration: 0.15 }}
                                      className="absolute left-0 right-0 top-full mt-1 bg-[#0a0a0b] border border-[#333] rounded-xl shadow-xl overflow-hidden z-50 py-1"
                                    >
                                      {[
                                        { id: 'gemini', label: 'Google Gemini' },
                                        { id: 'openai', label: 'OpenAI (ChatGPT)' },
                                        { id: 'openai_compatible', label: 'OpenAI-compatible (Custom)' },
                                        { id: 'openrouter', label: 'OpenRouter' },
                                        { id: 'anthropic', label: 'Anthropic (Claude)' },
                                        { id: 'cerebras', label: 'Cerebras' }
                                      ].map((provider) => (
                                        <button
                                          key={provider.id}
                                          onClick={() => {
                                            setApiProvider(provider.id as ApiProvider);
                                            setApiKeyError('');
                                            setIsProviderDropdownOpen(false);
                                            setIsModelDropdownOpen(false);
                                          }}
                                          className={`w-full text-left px-4 py-2.5 text-[14px] transition-colors ${
                                            apiProvider === provider.id
                                              ? 'bg-blue-600 text-white'
                                              : 'text-slate-300 hover:bg-[#1a1a1c] hover:text-white'
                                          }`}
                                        >
                                          {provider.label}
                                        </button>
                                      ))}
                                    </motion.div>
                                  </>
                                )}
                              </AnimatePresence>
                            </div>
                          </div>

                          <h3 className="text-[16px] font-semibold text-slate-200 mb-1">
                            {apiProvider === 'gemini' && 'Gemini API Key'}
                            {apiProvider === 'openai' && 'OpenAI API Key'}
                            {apiProvider === 'openai_compatible' && 'OpenAI-compatible API Key'}
                            {apiProvider === 'openrouter' && 'OpenRouter API Key'}
                            {apiProvider === 'anthropic' && 'Anthropic API Key'}
                            {apiProvider === 'cerebras' && 'Cerebras API Key'}
                          </h3>
                          <p className="text-[13px] text-slate-400 mb-6">
                            {apiProvider === 'gemini' && 'Enter your custom Google Gemini API key to use your own quota. Your key is stored locally in your browser.'}
                            {apiProvider === 'openai' && 'Enter your OpenAI API key to use ChatGPT models. Your key is stored locally in your browser.'}
                            {apiProvider === 'openai_compatible' && 'Enter an API key and custom OpenAI-compatible base URL (for providers such as Groq/Together/xAI-compatible gateways). Your settings are stored locally in your browser.'}
                            {apiProvider === 'openrouter' && 'Enter your OpenRouter API key to route requests across OpenRouter-supported models. Your key is stored locally in your browser.'}
                            {apiProvider === 'anthropic' && 'Enter your Anthropic API key to use Claude models. Your key is stored locally in your browser.'}
                            {apiProvider === 'cerebras' && 'Enter your Cerebras API key to use Cerebras-hosted models. Your key is stored locally in your browser.'}
                          </p>

                          <div className="flex flex-col gap-3 max-w-sm">
                            <input
                              type="password"
                              value={
                                apiProvider === 'gemini' ? (apiKeyInput || activeApiKey) :
                                apiProvider === 'openai' ? openaiApiKey :
                                apiProvider === 'openai_compatible' ? openaiCompatibleApiKey :
                                apiProvider === 'openrouter' ? openrouterApiKey :
                                apiProvider === 'anthropic' ? anthropicApiKey :
                                cerebrasApiKey
                              }
                              onChange={(e) => {
                                if (apiProvider === 'gemini') { setApiKeyInput(e.target.value); setActiveApiKey(e.target.value); }
                                else if (apiProvider === 'openai') { setOpenaiApiKey(e.target.value); }
                                else if (apiProvider === 'openai_compatible') { setOpenaiCompatibleApiKey(e.target.value); }
                                else if (apiProvider === 'openrouter') { setOpenrouterApiKey(e.target.value); }
                                else if (apiProvider === 'anthropic') { setAnthropicApiKey(e.target.value); }
                                else { setCerebrasApiKey(e.target.value); }
                                const provider = apiProvider;
                                setCloudValidationByProvider((prev) => ({
                                  ...prev,
                                  [provider]: {
                                    ...prev[provider],
                                    status: 'idle',
                                    message: '',
                                    fallbackApplied: false,
                                  },
                                }));
                                setCloudModelsByProvider((prev) => ({
                                  ...prev,
                                  [provider]: [],
                                }));
                                setIsModelDropdownOpen(false);
                                setApiKeyError('');
                              }}
                              placeholder={
                                apiProvider === 'gemini' ? 'Enter your Gemini API key' :
                                apiProvider === 'openai' ? 'Enter your OpenAI API key' :
                                apiProvider === 'openai_compatible' ? 'Enter your OpenAI-compatible API key' :
                                apiProvider === 'openrouter' ? 'Enter your OpenRouter API key' :
                                apiProvider === 'anthropic' ? 'Enter your Anthropic API key' :
                                'Enter your Cerebras API key'
                              }
                              className={`w-full bg-[#0a0a0b] border ${apiKeyError ? 'border-red-500 focus:border-red-400' : 'border-[#2a2a2d] focus:border-blue-500 focus:ring-1 focus:ring-blue-500'} rounded-xl px-4 py-3 text-[14px] focus:outline-none transition-all shadow-inner text-slate-200`}
                            />
                            {apiProvider === 'openai_compatible' && (
                              <input
                                type="text"
                                value={openaiCompatibleBaseUrl}
                                onChange={(e) => {
                                  const nextValue = e.target.value;
                                  setOpenaiCompatibleBaseUrl(nextValue);
                                  writeStoredValue(SETTINGS_STORAGE_KEYS.openaiCompatibleBaseUrl, nextValue);
                                  const provider = apiProvider;
                                  setCloudValidationByProvider((prev) => ({
                                    ...prev,
                                    [provider]: {
                                      ...prev[provider],
                                      status: 'idle',
                                      message: '',
                                      fallbackApplied: false,
                                    },
                                  }));
                                  setCloudModelsByProvider((prev) => ({
                                    ...prev,
                                    [provider]: [],
                                  }));
                                  setIsModelDropdownOpen(false);
                                  setApiKeyError('');
                                }}
                                placeholder="Enter OpenAI-compatible base URL (e.g., https://api.groq.com/openai/v1)"
                                className={`w-full bg-[#0a0a0b] border ${apiKeyError ? 'border-red-500 focus:border-red-400' : 'border-[#2a2a2d] focus:border-blue-500 focus:ring-1 focus:ring-blue-500'} rounded-xl px-4 py-3 text-[14px] focus:outline-none transition-all shadow-inner text-slate-200`}
                              />
                            )}
                            <button
                              onClick={handleSaveApiKey}
                              disabled={isCloudValidationBusy}
                              className={`bg-blue-600 text-white px-5 py-2.5 rounded-xl text-[13px] font-medium transition-all w-full sm:w-auto self-start shadow-md shadow-blue-900/20 active:scale-95 mt-1 ${isCloudValidationBusy ? 'opacity-70 cursor-not-allowed' : 'hover:bg-blue-500'}`}
                            >
                              {isCloudValidationBusy ? (
                                <span className="inline-flex items-center gap-2">
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  Validating...
                                </span>
                              ) : (
                                'Check API Key & Load Models'
                              )}
                            </button>

                            <div className="mt-2">
                              <label className="block text-[13px] font-medium text-slate-400 mb-2">Model</label>
                              <div className="relative">
                                <button
                                  onClick={() => {
                                    if (isCloudValidationBusy || getCloudModelOptionsForProvider(apiProvider).length === 0) {
                                      return;
                                    }
                                    setIsModelDropdownOpen(!isModelDropdownOpen);
                                    setIsProviderDropdownOpen(false);
                                  }}
                                  disabled={isCloudValidationBusy || getCloudModelOptionsForProvider(apiProvider).length === 0}
                                  className={`w-full bg-[#0a0a0b] border ${isModelDropdownOpen ? 'border-[#444] ring-1 ring-[#444]' : 'border-[#2a2a2d]'} rounded-xl px-4 py-3 text-[14px] transition-all text-slate-200 flex items-center justify-between shadow-inner disabled:opacity-70 disabled:cursor-not-allowed`}
                                >
                                  <span className={getCloudModelForProvider(apiProvider) ? 'text-slate-200' : 'text-slate-500'}>
                                    {getCloudModelForProvider(apiProvider)
                                      || (getCloudModelOptionsForProvider(apiProvider).length > 0
                                        ? 'Select a model'
                                        : 'Validate API key to load models')}
                                  </span>
                                  <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isModelDropdownOpen ? 'rotate-180' : ''}`} />
                                </button>

                                <AnimatePresence>
                                  {isModelDropdownOpen && (
                                    <>
                                      <div className="fixed inset-0 z-40" onClick={() => setIsModelDropdownOpen(false)} />
                                      <motion.div
                                        initial={{ opacity: 0, y: -5 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -5 }}
                                        transition={{ duration: 0.15 }}
                                        className="absolute left-0 right-0 top-full mt-1 bg-[#0a0a0b] border border-[#333] rounded-xl shadow-xl overflow-hidden z-50 py-1 max-h-72 overflow-y-auto"
                                      >
                                        {getCloudModelOptionsForProvider(apiProvider).map((model) => (
                                          <button
                                            key={model}
                                            onClick={() => {
                                              handleCloudModelSelection(model);
                                              setIsModelDropdownOpen(false);
                                            }}
                                            className={`w-full text-left px-4 py-2.5 text-[14px] transition-colors ${
                                              getCloudModelForProvider(apiProvider) === model
                                                ? 'bg-blue-600 text-white'
                                                : 'text-slate-300 hover:bg-[#1a1a1c] hover:text-white'
                                            }`}
                                          >
                                            {model}
                                          </button>
                                        ))}
                                      </motion.div>
                                    </>
                                  )}
                                </AnimatePresence>
                              </div>
                            </div>
                          </div>

                          {apiKeyError && <p className="text-red-400 text-[13px] mt-2">{apiKeyError}</p>}
                          {getCloudValidationForProvider(apiProvider).message && !apiKeyError && (
                            <div className={`mt-3 p-3 rounded-xl border text-[13px] ${getCloudValidationForProvider(apiProvider).status === 'valid' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : getCloudValidationForProvider(apiProvider).status === 'checking' ? 'bg-blue-500/10 border-blue-500/20 text-blue-300' : 'bg-amber-500/10 border-amber-500/20 text-amber-300'}`}>
                              {getCloudValidationForProvider(apiProvider).message}
                            </div>
                          )}
                          {apiProvider === 'gemini' && activeApiKey && activeApiKey !== DEFAULT_GEMINI_API_KEY && !apiKeyError && (
                            <div className="mt-6 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center gap-3 text-emerald-400 text-[13px]">
                              <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]"></div>
                              Custom API key is currently active.
                            </div>
                          )}
                          {apiProvider === 'gemini' && activeApiKey === DEFAULT_GEMINI_API_KEY && !apiKeyError && (
                            <div className="mt-6 p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl flex items-center gap-3 text-blue-400 text-[13px]">
                              <div className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)]"></div>
                              Default platform API key is currently active.
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="pt-6 border-t border-[#333]">
                          <h3 className="text-[16px] font-semibold text-slate-200 mb-1">Local LLM Configuration</h3>
                          <p className="text-[13px] text-slate-400 mb-6">Auto-detect Ollama or LM Studio, then review or edit the endpoint and model manually.</p>

                          <div className="flex flex-col gap-4 max-w-sm">
                            <div>
                              <label className="block text-[13px] font-medium text-slate-400 mb-2">API Endpoint URL</label>
                              <input
                                type="text"
                                value={localModelUrl}
                                onChange={(e) => setLocalModelUrl(e.target.value)}
                                placeholder="Optional: leave blank to auto-scan common local endpoints"
                                className="w-full bg-[#0a0a0b] border border-[#2a2a2d] focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded-xl px-4 py-3 text-[14px] transition-all shadow-inner text-slate-200 outline-none"
                              />
                            </div>
                            <div>
                              <label className="block text-[13px] font-medium text-slate-400 mb-2">Model Name</label>
                              {localDiscoveredModels.length > 0 ? (
                                <div className="relative">
                                  <select
                                    value={localModelName}
                                    onChange={(e) => setLocalModelName(e.target.value)}
                                    className="w-full appearance-none bg-[#0a0a0b] border border-[#2a2a2d] focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded-xl px-4 py-3 pr-10 text-[14px] transition-all shadow-inner text-slate-200 outline-none"
                                  >
                                    {!localModelName && <option value="">Select an installed model</option>}
                                    {localModelName && !localDiscoveredModels.includes(localModelName) && (
                                      <option value={localModelName}>{localModelName} (manual)</option>
                                    )}
                                    {localDiscoveredModels.map((modelId) => (
                                      <option key={modelId} value={modelId}>{modelId}</option>
                                    ))}
                                  </select>
                                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                </div>
                              ) : (
                                <input
                                  type="text"
                                  value={localModelName}
                                  onChange={(e) => setLocalModelName(e.target.value)}
                                  placeholder="Run Auto-Connect first, or enter model manually"
                                  className="w-full bg-[#0a0a0b] border border-[#2a2a2d] focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded-xl px-4 py-3 text-[14px] transition-all shadow-inner text-slate-200 outline-none"
                                />
                              )}
                              <p className="mt-2 text-[11px] text-slate-500">
                                {localDiscoveredModels.length > 0
                                  ? 'Select from detected installed models. Use Auto-Connect to refresh this list.'
                                  : 'No installed models detected yet. Auto-Connect to load available models from Ollama or LM Studio.'}
                              </p>
                            </div>

                            <div className="rounded-xl border border-blue-500/20 bg-blue-500/8 p-3 text-[12px] text-blue-200">
                              <div className="flex items-center justify-between gap-3">
                                <span className="font-medium uppercase tracking-wider text-blue-300">Connection Status</span>
                                <span
                                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                                    isLocalDiscoveryBusy
                                      ? 'bg-blue-500/15 border-blue-400/40 text-blue-200'
                                      : isLocalRuntimeConnected
                                        ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-200'
                                        : 'bg-slate-500/15 border-slate-400/30 text-slate-300'
                                  }`}
                                >
                                  {isLocalDiscoveryBusy ? 'Connecting...' : isLocalRuntimeConnected ? 'Connected' : 'Not Connected'}
                                </span>
                              </div>
                              <div className="mt-2 space-y-1 text-slate-300">
                                <div>Runtime: {localEndpointType ? getLocalEndpointTypeLabel(localEndpointType) : 'Not detected'}</div>
                                <div>Endpoint: {localModelUrl.trim() || 'Not set'}</div>
                                <div>Active Model: {localModelName.trim() || 'Not set'}</div>
                                <div>Last Checked: {localLastCheckedAt ? formatDateTime(localLastCheckedAt) : 'Not checked yet'}</div>
                                {localDiscoveredModels.length > 0 && (
                                  <div>Detected Models: {localDiscoveredModels.slice(0, 6).join(', ')}{localDiscoveredModels.length > 6 ? ` (+${localDiscoveredModels.length - 6} more)` : ''}</div>
                                )}
                                {localDockerHint && <div>Docker Hint: {localDockerHint}</div>}
                              </div>
                            </div>

                            <div className="mt-2">
                              <div className="flex items-center justify-between mb-2">
                                <label className="block text-[12px] font-medium text-slate-500 uppercase tracking-wider">Connection Logs</label>
                                <button
                                  onClick={() => setShowLocalConnectionLogs(prev => !prev)}
                                  className="text-[11px] text-slate-400 hover:text-slate-200 transition-colors"
                                >
                                  {showLocalConnectionLogs ? 'Hide Logs' : 'Show Logs'}
                                </button>
                              </div>

                              {showLocalConnectionLogs ? (
                                <div className="w-full bg-[#050505] border border-[#1a1a1c] rounded-lg p-3 font-mono text-[11px] h-32 overflow-y-auto shadow-inner flex flex-col gap-1">
                                  {localConnectionLogs.map((log, i) => (
                                    <div key={i} className={log.includes('Error') ? 'text-red-400' : log.includes('Success') ? 'text-emerald-400' : 'text-slate-400'}>
                                      <span className="opacity-50 mr-1">$</span> {log}
                                    </div>
                                  ))}
                                  {localConnectionLogs.length === 0 && <div className="text-slate-600 italic">No logs available.</div>}
                                </div>
                              ) : (
                                <p className="text-[11px] text-slate-600">Logs are hidden by default. Expand to inspect connection attempts.</p>
                              )}
                            </div>

                            <button
                              onClick={async () => {
                                const normalizedLocalModelUrl = localModelUrl.trim();
                                const normalizedLocalModelName = localModelName.trim();

                                if (normalizedLocalModelUrl) {
                                  setLocalModelUrl(normalizedLocalModelUrl);
                                  writeStoredValue(SETTINGS_STORAGE_KEYS.localModelUrl, normalizedLocalModelUrl);
                                }

                                if (normalizedLocalModelName) {
                                  setLocalModelName(normalizedLocalModelName);
                                  writeStoredValue(SETTINGS_STORAGE_KEYS.localModelName, normalizedLocalModelName);
                                }

                                showToast('Saved current local settings. Running auto-connect...', 'info');
                                localAutoDiscoveryAttemptedRef.current = true;
                                setShowLocalConnectionLogs(true);
                                await testLocalConnection();
                              }}
                              disabled={isLocalDiscoveryBusy}
                              className="bg-blue-600 text-white px-5 py-2.5 rounded-xl text-[13px] font-medium hover:bg-blue-500 transition-all w-full sm:w-auto self-start shadow-md shadow-blue-900/20 active:scale-95 mt-2 disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                              {isLocalDiscoveryBusy ? 'Discovering Runtime...' : isLocalRuntimeConnected ? 'Retry Auto-Connect' : 'Auto-Connect'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {activeSettingsTab === 'model' && (
                    <div className="space-y-8">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <h3 className="text-[16px] font-semibold text-[var(--text-color)]">System Instructions</h3>
                        </div>
                        <p className="text-[13px] text-[var(--text-dim)] mb-4">Customize how the AI behaves and responds to your queries.</p>
                        <textarea
                          value={systemInstructions}
                          onChange={(e) => setSystemInstructions(e.target.value)}
                          className="w-full max-w-lg bg-[var(--input-bg)] border border-[var(--border-color)] focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded-xl px-4 py-3 text-[14px] text-[var(--text-color)] resize-none h-48 transition-all shadow-inner outline-none placeholder-[var(--text-dim)]"
                          placeholder="You are NoteStack, an evidence-grounded assistant..."
                        />
                        <div className="mt-6 flex flex-col sm:flex-row gap-3 w-full sm:w-auto self-start">
                          <button
                            onClick={saveSystemInstructions}
                            className="flex bg-blue-600 text-white px-5 py-2.5 rounded-xl text-[13px] font-medium hover:bg-blue-500 transition-all w-full sm:w-auto shadow-md shadow-blue-900/20 active:scale-95"
                          >
                            Save Changes
                          </button>
                          <button
                            onClick={resetSystemInstructionsToRecommended}
                            className="flex items-center justify-center px-5 py-2.5 rounded-xl text-[13px] font-medium transition-all w-full sm:w-auto border border-[var(--border-color)] text-[var(--text-color)] hover:bg-[var(--panel-hover)]"
                          >
                            Reset to Recommended
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {activeSettingsTab === 'data' && (
                    <div className="space-y-8">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <h3 className="text-[16px] font-semibold text-slate-200">Clear Chat History</h3>
                        </div>
                        <p className="text-[13px] text-slate-400 mb-4">Permanently delete all conversations and messages in your account.</p>
                        <button
                          onClick={requestClearHistoryConfirmation}
                          className="px-5 py-3 border rounded-xl text-[13px] font-medium transition-colors bg-red-500/10 text-red-500 border-red-500/20 hover:bg-red-500 hover:text-white"
                        >
                          Clear History
                        </button>
                      </div>

                      <div className="pt-8 border-t border-[#333]">
                        <div className="flex items-center justify-between mb-1">
                          <h3 className="text-[16px] font-semibold text-slate-200">Export Data</h3>
                        </div>
                        <p className="text-[13px] text-slate-400 mb-4">Download a copy of your chat history and uploaded sources.</p>
                        <button
                          onClick={handleExportChat}
                          className="px-5 py-3 bg-[#2a2a2d] text-slate-200 border border-[#444] rounded-xl text-[13px] font-medium hover:bg-[#333] transition-colors"
                        >
                          Export as JSON
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Hidden Chat Export Container */}
      <div className="overflow-hidden h-0 w-0 absolute pointer-events-none">
        <div id="chat-export-container" className="w-[800px] bg-[#131314] p-8 flex flex-col gap-6 text-slate-200" style={{ display: 'none' }}>
          <h1 className="text-2xl font-bold mb-4 border-b border-[#333] pb-4">NoteStack Chat History</h1>
          {messages.map((msg) => (
            <div key={`export-${msg.id}`} className={`flex gap-4 ${msg.role === 'user' ? 'self-end flex-row-reverse' : ''}`}>
              {msg.role === 'model' && (
                <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-[12px] font-semibold bg-[#2a2a2d] text-slate-300 border border-[#333]">
                  <Bot className="w-4 h-4" />
                </div>
              )}
              <div className={`flex flex-col ${msg.role === 'model' ? 'w-full max-w-3xl' : 'items-end'}`}>
                {msg.role === 'user' ? (
                  <div className="flex flex-col items-end gap-2">
                    {msg.attachedFiles && msg.attachedFiles.length > 0 && (
                      <div className="flex flex-wrap gap-2 justify-end mb-1">
                        {msg.attachedFiles.map((doc) => (
                          <div key={`export-attached-${doc.id}`} className="flex items-center gap-2 bg-[#2a2a2d] border border-[#444] rounded-lg p-1.5 pr-3">
                            <FileText className="w-3 h-3 text-blue-400" />
                            <span className="text-[12px] font-medium text-slate-300">{doc.name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {msg.text && (
                      <div className="text-[15px] leading-[1.6] text-slate-200 whitespace-pre-wrap bg-[#2a2a2d] px-5 py-3.5 rounded-2xl rounded-tr-sm">
                        {msg.text}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="bg-transparent text-slate-300 w-full">
                    <div className="prose prose-sm prose-invert max-w-none prose-p:leading-[1.7] prose-headings:text-slate-200 prose-strong:text-slate-200">
                      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                        {getRenderableMessageText(msg)}
                      </Markdown>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Document Preview Modal */}
      <AnimatePresence>
        {(previewDoc || isPreviewLoading) && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
              onClick={() => { setPreviewDoc(null); setPreviewContent(null); setIsPreviewLoading(false); }}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="relative w-full max-w-5xl bg-[#1e1e1e] border border-[#333] rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[90vh]"
            >
              <div className="flex items-center justify-between p-4 border-b border-[#333] bg-[#131314]">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-[#2a2a2d] rounded-lg flex items-center justify-center">
                    {previewDoc && getFileIcon(previewDoc.mimeType, "w-4 h-4")}
                  </div>
                  <h3 className="text-[16px] font-medium text-slate-200">{previewDoc ? previewDoc.name : "Loading Preview..."}</h3>
                </div>
                <button
                  onClick={() => { setPreviewDoc(null); setPreviewContent(null); setIsPreviewLoading(false); }}
                  className="p-2 text-slate-400 hover:text-slate-200 hover:bg-[#2a2a2d] rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 overflow-hidden bg-white flex flex-col items-center justify-center">
                {isPreviewLoading ? (
                  <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-12 h-12 animate-spin text-blue-500" />
                    <span className="text-slate-500 font-medium">Processing document preview...</span>
                  </div>
                ) : previewDoc && previewContent ? (
                  <>
                    {previewDoc.mimeType === 'application/pdf' ? (
                      <iframe
                        src={`data:application/pdf;base64,${previewContent}`}
                        className="w-full h-full border-0"
                        title="PDF Preview"
                      />
                    ) : previewDoc.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? (
                      <div className="w-full h-full overflow-auto p-8">
                        <div
                          className="text-black font-sans text-[14px] leading-relaxed max-w-4xl mx-auto prose"
                          dangerouslySetInnerHTML={{ __html: previewContent }}
                        />
                      </div>
                    ) : (
                      <div className="w-full h-full overflow-auto p-8">
                        <pre className="text-black whitespace-pre-wrap font-sans text-[14px] leading-relaxed max-w-4xl mx-auto">
                          {decodeURIComponent(escape(atob(previewContent)))}
                        </pre>
                      </div>
                    )}
                  </>
                ) : null}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Staging Modal */}
      <AnimatePresence>
        {stagedFiles.length > 0 && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 sm:p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="relative bg-[#1e1e1e] border border-[#333] rounded-2xl w-full max-w-5xl h-[85vh] flex overflow-hidden shadow-2xl"
            >
              {/* Left side: File list */}
              <div className="w-1/3 border-r border-[#333] flex flex-col bg-[#131314]">
                <div className="p-4 border-b border-[#333]">
                  <h3 className="text-[16px] font-medium text-slate-200">Review Uploads</h3>
                  <p className="text-[13px] text-slate-400">{stagedFiles.length} file(s) selected</p>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                  {stagedFiles.map((file, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between p-3 hover:bg-[#2a2a2d] rounded-lg cursor-pointer group"
                      onClick={() => handlePreviewStaged(file)}
                    >
                      <div className="flex items-center gap-3 overflow-hidden">
                        {file.type === 'application/pdf' ? <File className="w-4 h-4 text-red-400 shrink-0" /> : <FileText className="w-4 h-4 text-blue-400 shrink-0" />}
                        <span className="text-[13px] text-slate-300 truncate">{file.name}</span>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); setStagedFiles(prev => prev.filter((_, idx) => idx !== i)); }}
                        className="text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 p-1"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="p-4 border-t border-[#333] flex gap-2">
                  <button
                    onClick={() => { setStagedFiles([]); setStagedPreviewUrl(null); setStagedPreviewText(null); }}
                    className="flex-1 py-2 bg-[#2a2a2d] text-slate-300 rounded-lg text-[13px] font-medium hover:bg-[#333]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => { processFiles(stagedFiles); setStagedFiles([]); setStagedPreviewUrl(null); setStagedPreviewText(null); }}
                    className="flex-1 py-2 bg-blue-500 text-white rounded-lg text-[13px] font-medium hover:bg-blue-600"
                  >
                    Upload All
                  </button>
                </div>
              </div>
              {/* Right side: Preview */}
              <div className="w-2/3 bg-white flex flex-col relative text-black">
                {stagedPreviewUrl ? (
                  stagedPreviewType === 'application/pdf' ? (
                    <iframe src={stagedPreviewUrl} className="w-full h-full border-0" />
                  ) : stagedPreviewUrl === 'html' && stagedPreviewHtml ? (
                    <div className="w-full h-full overflow-auto p-8">
                      <div
                        className="font-sans text-[14px] leading-relaxed max-w-3xl mx-auto prose"
                        dangerouslySetInnerHTML={{ __html: stagedPreviewHtml }}
                      />
                    </div>
                  ) : (
                    <div className="w-full h-full overflow-auto p-8">
                      <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed max-w-3xl mx-auto">
                        {stagedPreviewText}
                      </pre>
                    </div>
                  )
                ) : (
                  <div className="flex-1 flex items-center justify-center text-slate-400 bg-[#1e1e1e]">
                    <div className="text-center">
                      <Eye className="w-12 h-12 mx-auto mb-4 opacity-20" />
                      <p>Select a file to preview</p>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
