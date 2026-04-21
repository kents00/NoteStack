import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { type NotificationType, useNotifications } from '../../context/NotificationContext';

interface NotificationInlineProps {
  scope: string;
  className?: string;
}

function getInlineIcon(type: NotificationType) {
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

function getInlineClasses(type: NotificationType) {
  switch (type) {
    case 'success':
      return 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200';
    case 'warning':
      return 'border-amber-500/35 bg-amber-500/10 text-amber-100';
    case 'error':
      return 'border-red-500/35 bg-red-500/10 text-red-200';
    default:
      return 'border-blue-500/35 bg-blue-500/10 text-blue-100';
  }
}

export const NotificationInline: React.FC<NotificationInlineProps> = ({ scope, className }) => {
  const { inlineByScope, clearInline } = useNotifications();
  const notification = inlineByScope[scope];
  const Icon = notification ? getInlineIcon(notification.type) : null;

  return (
    <AnimatePresence initial={false}>
      {notification && (
        <motion.div
          key={notification.id}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          className={`rounded-xl border px-3.5 py-3 ${getInlineClasses(notification.type)} ${className ?? ''}`}
        >
          <div className="flex items-start gap-2.5">
            {Icon && <Icon className="mt-[1px] h-4 w-4 shrink-0" />}
            <div className="min-w-0 flex-1">
              {notification.title && <div className="text-[12px] font-semibold tracking-wide">{notification.title}</div>}
              <div className="text-[12.5px] leading-relaxed">{notification.message}</div>
            </div>
            <button
              type="button"
              onClick={() => clearInline(scope)}
              className="rounded-md p-1 text-white/70 transition-colors hover:bg-black/20 hover:text-white"
              aria-label="Dismiss notification"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
