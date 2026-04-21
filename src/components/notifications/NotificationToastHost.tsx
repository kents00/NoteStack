import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { type NotificationType, useNotifications } from '../../context/NotificationContext';

function getToastIcon(type: NotificationType) {
  switch (type) {
    case 'success':
      return CheckCircle2;
    case 'warning':
      return AlertTriangle;
    case 'error':
      return XCircle;
    default:
      return Info;
  }
}

function getToastClasses(type: NotificationType) {
  switch (type) {
    case 'success':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200';
    case 'warning':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-100';
    case 'error':
      return 'border-red-500/40 bg-red-500/10 text-red-100';
    default:
      return 'border-blue-500/40 bg-blue-500/10 text-blue-100';
  }
}

export const NotificationToastHost: React.FC = () => {
  const { toasts, dismissToast } = useNotifications();

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[120] flex flex-col items-center gap-2 px-4 sm:items-end sm:px-6">
      <AnimatePresence>
        {toasts.map((toast) => {
          const Icon = getToastIcon(toast.type);
          return (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: -14, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className={`pointer-events-auto w-full max-w-sm rounded-xl border px-3.5 py-3 shadow-xl backdrop-blur-md ${getToastClasses(toast.type)}`}
            >
              <div className="flex items-start gap-2.5">
                <Icon className="mt-[1px] h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  {toast.title && <div className="text-[12px] font-semibold tracking-wide">{toast.title}</div>}
                  <div className="text-[12.5px] leading-relaxed">{toast.message}</div>
                </div>
                <button
                  type="button"
                  onClick={() => dismissToast(toast.id)}
                  className="rounded-md p-1 text-white/70 transition-colors hover:bg-black/20 hover:text-white"
                  aria-label="Dismiss notification"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
};
