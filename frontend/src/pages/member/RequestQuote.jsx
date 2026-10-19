import { useNavigate } from 'react-router-dom';
import RequestForm from '../shared/RequestForm';
import { PageHead } from '../../components/ui';

export default function RequestQuote() {
  const nav = useNavigate();
  return (
    <div style={{ maxWidth: 920 }}>
      <PageHead eyebrow="New request" title="Request a quote" sub="Whole-aircraft charter across our domestic network. Add as many as six legs." />
      <RequestForm onCreated={r => nav(r?.id ? `/m/requests/${r.id}?created=1` : '/m/requests')} />
    </div>
  );
}
