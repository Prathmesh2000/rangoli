import { getState, setState } from './store';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Shell } from './app/Shell';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.pathname.startsWith('/editor') ? <App /> : <Shell />}
  </StrictMode>,
);

void import('../../engine/src/icon-pack').then(() => setState({ version: getState().version + 1 }));
