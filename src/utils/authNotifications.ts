export type AuthMode = 'login' | 'signup';

export interface AuthErrorLike {
  status?: number;
  message?: string;
}

export interface AuthFailureNotification {
  title: string;
  message: string;
}

interface BuildAuthFailureNotificationInput {
  mode: AuthMode;
  error: unknown;
  accountCreated?: boolean;
}

const GENERIC_AUTH_MESSAGES = new Set([
  'login failed',
  'registration failed',
  'authentication failed. please try again.',
]);

function readAuthError(error: unknown): AuthErrorLike {
  if (!error || typeof error !== 'object') {
    return {};
  }

  const candidate = error as { status?: unknown; message?: unknown };

  const status = typeof candidate.status === 'number' ? candidate.status : undefined;
  const message = typeof candidate.message === 'string' ? candidate.message : undefined;

  return { status, message };
}

function normalizeDetail(rawMessage: string | undefined, fallback: string): string {
  if (!rawMessage) {
    return fallback;
  }

  const normalized = rawMessage.trim();
  if (!normalized) {
    return fallback;
  }

  if (GENERIC_AUTH_MESSAGES.has(normalized.toLowerCase())) {
    return fallback;
  }

  return normalized;
}

const STATUS_TITLE_MAP: Record<number, { login: string; signup: string }> = {
  401: {
    login: 'Incorrect Credentials',
    signup: 'Authentication Required',
  },
  403: {
    login: 'Access Blocked',
    signup: 'Access Blocked',
  },
  409: {
    login: 'Account Conflict',
    signup: 'Email Already Registered',
  },
  422: {
    login: 'Check Your Input',
    signup: 'Check Your Details',
  },
};

const STATUS_FALLBACK_MESSAGE_MAP: Record<number, { login: string; signup: string }> = {
  401: {
    login: 'The email or password is incorrect. Please try again.',
    signup: 'Please sign in to continue.',
  },
  403: {
    login: 'This sign-in attempt is not allowed right now. Please try again later.',
    signup: 'This request is not allowed right now. Please try again later.',
  },
  409: {
    login: 'An account conflict occurred. Please try again.',
    signup: 'This email is already registered. Try signing in instead.',
  },
  422: {
    login: 'Please check your credentials and try again.',
    signup: 'Please check the fields and try again.',
  },
};

export function buildAuthFailureNotification(input: BuildAuthFailureNotificationInput): AuthFailureNotification {
  const { mode, accountCreated = false } = input;
  const error = readAuthError(input.error);

  if (mode === 'signup' && accountCreated) {
    return {
      title: 'Sign In Required',
      message: normalizeDetail(
        error.message,
        'Your account was created, but automatic sign in failed. Please sign in with your new credentials.'
      ),
    };
  }

  const mappedTitle = error.status ? STATUS_TITLE_MAP[error.status]?.[mode] : undefined;
  const mappedFallbackMessage = error.status ? STATUS_FALLBACK_MESSAGE_MAP[error.status]?.[mode] : undefined;

  const fallbackTitle = mode === 'login' ? 'Sign In Failed' : 'Sign Up Failed';
  const fallbackMessage = mappedFallbackMessage || 'Authentication failed. Please try again.';

  return {
    title: mappedTitle || fallbackTitle,
    message: normalizeDetail(error.message, fallbackMessage),
  };
}
