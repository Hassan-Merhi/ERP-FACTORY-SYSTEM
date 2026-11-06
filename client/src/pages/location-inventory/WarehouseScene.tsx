/** Decorative, non-interactive warehouse illustration used by the location landing page. */
export function WarehouseScene({ compact = false }: { compact?: boolean }) {
  const suffix = compact ? "card" : "hero";
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 760 290"
      preserveAspectRatio="xMidYMid slice"
      className="h-full w-full"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={`warehouse-wall-${suffix}`} x1="0" x2="1" y1="0" y2="1">
          <stop stopColor="#9a71ff" stopOpacity=".8" />
          <stop offset=".45" stopColor="#312d72" stopOpacity=".85" />
          <stop offset="1" stopColor="#0d193f" stopOpacity=".95" />
        </linearGradient>
        <linearGradient id={`warehouse-door-${suffix}`} x1="0" x2="0" y1="0" y2="1">
          <stop stopColor="#f4adff" stopOpacity=".68" />
          <stop offset="1" stopColor="#7335e0" stopOpacity=".15" />
        </linearGradient>
        <linearGradient id={`warehouse-floor-${suffix}`} x1="0" x2="0" y1="0" y2="1">
          <stop stopColor="#b167ff" stopOpacity=".27" />
          <stop offset="1" stopColor="#131027" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M0 245L760 214V290H0Z" fill={`url(#warehouse-floor-${suffix})`} />
      <path d="M155 94L405 34L704 90L460 151Z" fill="#9053ed" fillOpacity=".38" stroke="#be91ff" strokeOpacity=".7" strokeWidth="2" />
      <path d="M155 94L460 151V244L155 211Z" fill={`url(#warehouse-wall-${suffix})`} stroke="#b18dff" strokeOpacity=".42" strokeWidth="2" />
      <path d="M460 151L704 90V214L460 244Z" fill="#15183f" stroke="#a474ff" strokeOpacity=".53" strokeWidth="2" />
      {Array.from({ length: 7 }, (_, i) => (
        <path key={`wall-${i}`} d={`M${190 + i * 38} ${100 + i * 7}V${214 + i * 4}`} stroke="#c6abff" strokeOpacity=".14" strokeWidth="3" />
      ))}
      <path d="M472 156L675 107V210L472 233Z" fill={`url(#warehouse-door-${suffix})`} stroke="#d5aeff" strokeOpacity=".68" strokeWidth="3" />
      <path d="M500 150V227M540 141V222M582 131V217M625 121V212" stroke="#f3d9ff" strokeOpacity=".25" strokeWidth="2" />
      <path d="M473 183L674 147M473 208L674 184" stroke="#f3d9ff" strokeOpacity=".22" strokeWidth="2" />
      <path d="M205 129L290 141V177L205 167ZM318 148L407 163V194L318 182Z" fill="#a26bf5" fillOpacity=".32" stroke="#d2b3ff" strokeOpacity=".38" />
      <g fill="#eabaff" fillOpacity=".66">
        <rect x="497" y="190" width="42" height="30" rx="2" />
        <rect x="543" y="184" width="39" height="32" rx="2" />
        <rect x="539" y="163" width="40" height="21" rx="2" />
        <rect x="588" y="176" width="39" height="36" rx="2" />
      </g>
      <path d="M448 239L709 216" stroke="#c58aff" strokeOpacity=".6" strokeWidth="3" />
      <path d="M134 217L448 255" stroke="#8348fb" strokeOpacity=".5" strokeWidth="3" />
      {!compact && (
        <g transform="translate(82 191)" stroke="#eac9ff" strokeWidth="3">
          <path d="M5 39H105V9H79L60 0H19L5 17Z" fill="#5020a9" fillOpacity=".8" />
          <path d="M91 10V-33H105V39M105 10H142" />
          <rect x="108" y="10" width="41" height="26" fill="#8d51f5" fillOpacity=".5" />
          <circle cx="31" cy="42" r="12" fill="#130f31" />
          <circle cx="89" cy="42" r="12" fill="#130f31" />
        </g>
      )}
      <path d="M0 270C140 241 203 280 325 260S600 260 760 236" stroke="#9e55ff" strokeOpacity=".45" strokeWidth="2" fill="none" />
    </svg>
  );
}
