export default function Wordmark({ sub = true }) {
  return (
    <div>
      <span className="wordmark">Meridian <span>Charters</span></span>
      {sub && <span className="wordmark-sub">Private Aviation · India</span>}
    </div>
  );
}
