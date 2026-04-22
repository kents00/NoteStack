import type { CitationItem } from '../utils/citationStream';

export type Document = {
  id: string;
  name: string;
  mimeType: string;
  base64?: string;
  folderId?: string;
  size?: number;
  timestamp?: number;
};

export type Folder = {
  id: string;
  name: string;
  isExpanded?: boolean;
  timestamp?: number;
};

export type Message = {
  id: string;
  role: 'user' | 'model';
  text: string;
  attachedFiles?: Document[];
  citations?: CitationItem[];
  citationStatus?: 'full' | 'partial';
  citationStatusReason?: string;
  bubbleStyle?: React.CSSProperties;
};

export type Note = {
  id: string;
  title: string;
  content: string;
  timestamp: number;
};

export type UploadingFile = {
  id: string;
  name: string;
  progress: number;
};

export type ApiProvider = 'gemini' | 'openai' | 'anthropic' | 'cerebras' | 'openrouter' | 'openai_compatible' | 'local';
export type MessageFeedback = 'like' | 'dislike';
export type CloudValidationStatus = 'idle' | 'checking' | 'valid' | 'invalid';

export type CloudValidationState = {
  status: CloudValidationStatus;
  message: string;
  defaultModel?: string;
  resolvedModel?: string;
  fallbackApplied?: boolean;
  selectedModelAccessible?: boolean;
};

export type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type RightPanelTab = 'notes' | 'configure' | 'history';
export type ChatGoalMode = 'default' | 'learning-guide';
export type ChatResponseLength = 'default' | 'longer' | 'shorter';
export type RegenerateMode = 'try_again' | 'think_longer';

export type ChatSessionConfig = {
  goalMode: ChatGoalMode;
  responseLength: ChatResponseLength;
};
