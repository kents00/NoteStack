import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Info, X, XCircle } from 'lucide-react';
import {
  type NotificationModalAction,
  type NotificationModalSize,
  type NotificationType,
  useNotifications,
} from '../../context/NotificationContext';

function getModalIcon(type: NotificationType) {
  switch (type) {
    case 'warning':
      return AlertTriangle;
    case 'error':
      return XCircle;
    default:
      return Info;
  }
}

function getModalIconClasses(type: NotificationType) {
  switch (type) {
    case 'warning':
      return 'bg-amber-500/15 text-amber-300 border border-amber-500/25';
    case 'error':
      return 'bg-red-500/15 text-red-300 border border-red-500/25';
    default:
      return 'bg-blue-500/15 text-blue-300 border border-blue-500/25';
  }
}

function getActionClasses(action: NotificationModalAction) {
  if (action.variant === 'danger') {
    return 'bg-red-500 text-white hover:bg-red-400 border border-red-500';
  }
  if (action.variant === 'ghost') {
    return 'bg-transparent text-slate-300 hover:bg-white/5 border border-white/15';
  }
  return 'bg-blue-600 text-white hover:bg-blue-500 border border-blue-500/70';
}

function getModalSizeClasses(size: NotificationModalSize) {
  switch (size) {
    case 'sm':
      return 'max-w-sm';
    case 'lg':
      return 'max-w-2xl';
    case 'xl':
      return 'max-w-3xl';
    default:
      return 'max-w-md';
  }
}

export const NotificationModal: React.FC = () => {
  const { modal, closeModal } = useNotifications();
  const Icon = modal ? getModalIcon(modal.type) : Info;

  const runAction = async (action: NotificationModalAction) => {
    try {
      if (action.onClick) {
        await action.onClick();
      }
      if (action.closeOnClick !== false) {
        closeModal();
      }
    } catch (error) {
      console.error('Modal action failed', error);
    }
  };

  return (
    <AnimatePresence>
      {modal && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={modal.closeOnBackdropClick ? closeModal : undefined}
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
          />

          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className={`relative z-10 w-full rounded-2xl border border-white/10 bg-[#131315] p-5 shadow-2xl ${getModalSizeClasses(modal.size)}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="notification-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            {modal.closeOnBackdropClick && (
              <button
                type="button"
                onClick={closeModal}
                className="absolute right-3 top-3 rounded-md p-1 text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                aria-label="Close notification modal"
              >
                <X className="h-4 w-4" />
              </button>
            )}

            <div className="flex items-start gap-3 pr-8">
              <div className={`mt-0.5 rounded-lg p-2 ${getModalIconClasses(modal.type)}`}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <h2 id="notification-modal-title" className="text-[17px] font-semibold text-slate-100">
                  {modal.title}
                </h2>
                {modal.message && <p className="mt-2 text-[13px] leading-relaxed text-slate-300">{modal.message}</p>}
                {modal.content && <div className={modal.message ? 'mt-3' : 'mt-2'}>{modal.content}</div>}
              </div>
            </div>

            {modal.actions.length > 0 && (
              <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                {modal.actions.map((action) => (
                  <button
                    key={action.id ?? action.label}
                    type="button"
                    onClick={() => {
                      void runAction(action);
                    }}
                    className={`rounded-lg px-4 py-2 text-[12.5px] font-semibold transition-colors ${getActionClasses(action)}`}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
