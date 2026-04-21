import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface NotificationToastInput {
  type?: NotificationType;
  title?: string;
  message: string;
  feature?: string;
  durationMs?: number;
}

export interface NotificationInlineInput {
  scope: string;
  type?: NotificationType;
  title?: string;
  message: string;
  feature?: string;
  autoClearMs?: number;
}

export interface NotificationModalAction {
  id?: string;
  label: string;
  variant?: 'default' | 'danger' | 'ghost';
  closeOnClick?: boolean;
  onClick?: () => void | Promise<void>;
}

export type NotificationModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface NotificationModalInput {
  type?: NotificationType;
  title: string;
  message?: string;
  content?: React.ReactNode;
  size?: NotificationModalSize;
  feature?: string;
  closeOnBackdropClick?: boolean;
  actions?: NotificationModalAction[];
}

export interface NotificationConfirmInput {
  title: string;
  message: string;
  feature?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  closeOnBackdropClick?: boolean;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}

export interface NotificationToast extends NotificationToastInput {
  id: string;
  createdAt: number;
  type: NotificationType;
}

export interface NotificationInlineEntry extends NotificationInlineInput {
  id: string;
  createdAt: number;
  type: NotificationType;
}

export interface NotificationModalState extends NotificationModalInput {
  id: string;
  type: NotificationType;
  message: string;
  closeOnBackdropClick: boolean;
  size: NotificationModalSize;
  actions: NotificationModalAction[];
}

interface NotificationContextValue {
  toasts: NotificationToast[];
  inlineByScope: Record<string, NotificationInlineEntry>;
  modal: NotificationModalState | null;
  toast: (input: NotificationToastInput) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
  inline: (input: NotificationInlineInput) => string;
  clearInline: (scope: string) => void;
  openModal: (input: NotificationModalInput) => string;
  closeModal: () => void;
  confirm: (input: NotificationConfirmInput) => Promise<boolean>;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

const DEFAULT_TOAST_DURATION_MS = 3500;

function createNotificationId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<NotificationToast[]>([]);
  const [inlineByScope, setInlineByScope] = useState<Record<string, NotificationInlineEntry>>({});
  const [modal, setModal] = useState<NotificationModalState | null>(null);

  const timeoutIdsRef = useRef<number[]>([]);
  const pendingConfirmResolverRef = useRef<((value: boolean) => void) | null>(null);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  const toast = useCallback(
    (input: NotificationToastInput) => {
      const id = createNotificationId('toast');
      const durationMs = input.durationMs ?? DEFAULT_TOAST_DURATION_MS;

      const nextToast: NotificationToast = {
        ...input,
        id,
        createdAt: Date.now(),
        type: input.type ?? 'info',
      };

      setToasts((current) => [...current, nextToast]);

      if (durationMs > 0) {
        const timeoutId = window.setTimeout(() => {
          setToasts((current) => current.filter((toastItem) => toastItem.id !== id));
        }, durationMs);
        timeoutIdsRef.current.push(timeoutId);
      }

      return id;
    },
    []
  );

  const clearInline = useCallback((scope: string) => {
    setInlineByScope((current) => {
      if (!current[scope]) {
        return current;
      }
      const next = { ...current };
      delete next[scope];
      return next;
    });
  }, []);

  const inline = useCallback(
    (input: NotificationInlineInput) => {
      const id = createNotificationId('inline');
      const entry: NotificationInlineEntry = {
        ...input,
        id,
        createdAt: Date.now(),
        type: input.type ?? 'info',
      };

      setInlineByScope((current) => ({
        ...current,
        [input.scope]: entry,
      }));

      if ((input.autoClearMs ?? 0) > 0) {
        const timeoutId = window.setTimeout(() => {
          setInlineByScope((current) => {
            const active = current[input.scope];
            if (!active || active.id !== id) {
              return current;
            }
            const next = { ...current };
            delete next[input.scope];
            return next;
          });
        }, input.autoClearMs);
        timeoutIdsRef.current.push(timeoutId);
      }

      return id;
    },
    []
  );

  const clearPendingConfirm = useCallback((value: boolean) => {
    if (pendingConfirmResolverRef.current) {
      pendingConfirmResolverRef.current(value);
      pendingConfirmResolverRef.current = null;
    }
  }, []);

  const closeModal = useCallback(() => {
    setModal(null);
    clearPendingConfirm(false);
  }, [clearPendingConfirm]);

  const openModal = useCallback(
    (input: NotificationModalInput) => {
      clearPendingConfirm(false);

      const id = createNotificationId('modal');
      setModal({
        ...input,
        id,
        type: input.type ?? 'info',
        message: input.message ?? '',
        closeOnBackdropClick: input.closeOnBackdropClick ?? true,
        size: input.size ?? 'md',
        actions: input.actions ?? [],
      });
      return id;
    },
    [clearPendingConfirm]
  );

  const confirm = useCallback(
    (input: NotificationConfirmInput) => {
      clearPendingConfirm(false);

      return new Promise<boolean>((resolve) => {
        pendingConfirmResolverRef.current = resolve;

        const handleCancel = async () => {
          try {
            if (input.onCancel) {
              await input.onCancel();
            }
          } finally {
            setModal(null);
            clearPendingConfirm(false);
          }
        };

        const handleConfirm = async () => {
          try {
            if (input.onConfirm) {
              await input.onConfirm();
            }
            setModal(null);
            clearPendingConfirm(true);
          } catch (error) {
            console.error('Notification confirm action failed', error);
          }
        };

        setModal({
          id: createNotificationId('confirm'),
          type: input.destructive ? 'warning' : 'info',
          title: input.title,
          message: input.message,
          feature: input.feature,
          closeOnBackdropClick: input.closeOnBackdropClick ?? false,
          size: 'md',
          actions: [
            {
              id: 'cancel',
              label: input.cancelLabel ?? 'Cancel',
              variant: 'ghost',
              onClick: handleCancel,
            },
            {
              id: 'confirm',
              label: input.confirmLabel ?? 'Confirm',
              variant: input.destructive ? 'danger' : 'default',
              onClick: handleConfirm,
            },
          ],
        });
      });
    },
    [clearPendingConfirm]
  );

  useEffect(() => {
    return () => {
      for (const timeoutId of timeoutIdsRef.current) {
        window.clearTimeout(timeoutId);
      }
      clearPendingConfirm(false);
    };
  }, [clearPendingConfirm]);

  const value = useMemo<NotificationContextValue>(
    () => ({
      toasts,
      inlineByScope,
      modal,
      toast,
      dismissToast,
      clearToasts,
      inline,
      clearInline,
      openModal,
      closeModal,
      confirm,
    }),
    [toasts, inlineByScope, modal, toast, dismissToast, clearToasts, inline, clearInline, openModal, closeModal, confirm]
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
};

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotifications must be used within a NotificationProvider');
  }
  return context;
}
