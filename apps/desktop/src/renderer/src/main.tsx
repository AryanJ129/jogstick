import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

function App(): React.JSX.Element {
  return (
    <main
      style={{
        fontFamily: 'system-ui',
        color: '#ddd',
        background: '#1a1a1a',
        height: '100vh',
        padding: 24,
      }}
    >
      <h1>Jogstick</h1>
      <p>Development build. The mapping editor arrives in Phase 4.</p>
    </main>
  );
}

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
