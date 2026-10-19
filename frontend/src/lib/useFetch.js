import { useEffect, useState, useCallback, useRef } from 'react';
import api, { errText } from '../api';

/** GET a URL (null to skip). Returns { data, error, loading, reload, setData }. */
export function useFetch(url) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!url);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!url) { setLoading(false); return; }
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await api.get(url);
      if (my === seq.current) { setData(r.data); setError(''); }
    } catch (e) {
      if (my === seq.current) setError(errText(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}
