import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { NotificationProvider } from './context/NotificationContext';
import { NotificationHosts } from './components/notifications/NotificationHosts';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NotificationProvider>
      <App />
      <NotificationHosts />
    </NotificationProvider>
  </StrictMode>,
);
