import { Link } from 'react-router-dom';
import { useAuth, homeFor } from '../../context/AuthContext';
import Wordmark from '../../components/Wordmark';

export default function PublicLayout({ children }) {
  const { user } = useAuth();
  return (
    <div className="pub">
      <header className="pub-nav">
        <div className="pub-nav-inner">
          <Link to="/empty-legs" aria-label="Meridian Charters — empty-leg deals"><Wordmark sub={false} /></Link>
          <nav className="pub-nav-links">
            <Link to="/empty-legs" className="hide-xs">Empty legs</Link>
            {user
              ? <Link to={homeFor(user.role)} className="btn btn-sm pub-signin">Your account</Link>
              : <Link to="/login" className="btn btn-sm pub-signin">Member sign in</Link>}
          </nav>
        </div>
      </header>
      {children}
      <footer className="pub-foot">
        <div className="pub-foot-inner">
          <div>
            <Wordmark />
            <p className="small" style={{ marginTop: 14, maxWidth: 380 }}>
              Whole-aircraft private charter across India’s domestic network, operated by a licensed Indian operator.
            </p>
          </div>
          <div className="small pub-foot-links">
            <Link to="/empty-legs">Empty-leg deals</Link>
            <Link to="/login">Member sign in</Link>
            <span>Prices in INR, exclusive of GST. All times IST.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
