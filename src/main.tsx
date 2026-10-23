import { Component, ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class Boundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: Error) { return { err: e.message }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="splash">
        <div className="logo">קדימה</div>
        <p>משהו השתבש במסך הזה.</p>
        <small>{this.state.err}</small>
        <button className="btn" onClick={() => { history.replaceState(null, '', location.pathname + location.search); location.reload(); }}>חזרה למסך הראשי</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
