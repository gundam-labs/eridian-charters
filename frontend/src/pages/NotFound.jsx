import { Link } from 'react-router-dom';
import { useAuth, homeFor } from '../context/AuthContext';
export default function NotFound() {
  const { user } = useAuth();
  return (
    <div className="empty" style={{ paddingTop: 120 }}>
      <div className="empty-mark">✦</div>
      <h3>Page not found</h3>
      <p>That page doesn’t exist or you don’t have access to it.</p>
      <Link className="btn btn-primary" to={user ? homeFor(user.role) : '/login'}>Go home</Link>
    </div>
  );
}
