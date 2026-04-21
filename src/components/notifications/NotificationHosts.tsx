import React from 'react';
import { NotificationToastHost } from './NotificationToastHost';
import { NotificationModal } from './NotificationModal';

export const NotificationHosts: React.FC = () => {
  return (
    <>
      <NotificationToastHost />
      <NotificationModal />
    </>
  );
};
