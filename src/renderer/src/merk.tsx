/**
 * Het merk, op één plek.
 *
 * De M waarvan de middenstok naar beneden duikt naar een oplichtend punt. Deze
 * vorm staat ook in de tray, de splash, de installer en op de site -- en juist
 * daarom hoort er één bron te zijn. Wordt hij op vijf plekken opnieuw getekend,
 * dan lopen ze uit elkaar en merkt niemand dat tot het te laat is.
 *
 * Alleen formaat en gloed verschillen per plek; de geometrie nooit.
 */

export function Merk({
  size = 28,
  /** De gloed om het lichtpunt. Uit in een rij, aan als het merk ergens staat te zijn. */
  gloed = false,
  className = "",
}: {
  size?: number;
  gloed?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 120 118"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      className={className}
      style={gloed ? { filter: "drop-shadow(0 2px 10px rgba(231,199,110,0.35))" } : undefined}
    >
      <defs>
        <linearGradient id="merk-arm" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7a6426" />
          <stop offset="1" stopColor="#b89c4a" />
        </linearGradient>
        <linearGradient id="merk-piek" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b89c4a" />
          <stop offset="1" stopColor="#f0dca0" />
        </linearGradient>
      </defs>
      {/* De twee armen stromen naar binnen en ontmoeten elkaar in het midden. */}
      <path
        d="M14 102 L33 20 L60 60 L87 20 L106 102"
        stroke="url(#merk-arm)"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Daar duikt de middenstok verder: dat is "mid". */}
      <path d="M60 60 L60 104" stroke="url(#merk-piek)" strokeWidth="10" strokeLinecap="round" />
      <circle cx="60" cy="104" r="6" fill="#f7edc9" />
    </svg>
  );
}

/**
 * Het merk als wapen: groot, gedempt, voor een leeg scherm.
 *
 * Een lege staat hoort ontworpen te zijn en niet weggelaten. Dit is wat er
 * staat als er nog niets te tonen is -- rustig genoeg om niet als fout te
 * lezen, aanwezig genoeg om te laten zien dat het scherm klopt.
 */
export function MerkWapen({ size = 96 }: { size?: number }): JSX.Element {
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: "radial-gradient(circle, rgba(231,199,110,0.07), transparent 68%)",
        }}
      />
      <Merk size={size * 0.62} className="relative opacity-45" />
    </div>
  );
}
